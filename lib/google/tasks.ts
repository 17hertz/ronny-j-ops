/**
 * Google Tasks API v1 client.
 *
 * Mostly a read path — our `google_tasks` table is a mirror populated by
 * `listTasks` + `listTaskLists`. The one write we do is `patchTaskStatus`,
 * so the dashboard can flip a task completed/needsAction and have it travel
 * back to Google (phone, tasks.google.com, etc.). That's the only mutation
 * we make against the remote.
 *
 * The Tasks API has no sync token like Calendar, so we use `updatedMin` for
 * incremental-ish pulls and rely on the unique (account, list, task) index
 * for idempotence.
 */
const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

export type GoogleTaskList = {
  id: string;
  title: string;
  updated?: string;
};

export type GoogleTask = {
  id: string;
  title?: string;
  notes?: string;
  status: "needsAction" | "completed";
  due?: string;        // ISO date, e.g. "2026-04-22T00:00:00.000Z"
  completed?: string;  // ISO timestamp when completed
  parent?: string;
  position?: string;
  etag?: string;
  updated?: string;
  deleted?: boolean;
  hidden?: boolean;
};

/**
 * Thrown when the access token doesn't include the tasks scope (403),
 * OR when the Tasks API isn't enabled on the Google Cloud project (also
 * 403). Caller surfaces "reconnect Google / enable API" guidance.
 */
export class TasksScopeMissingError extends Error {
  constructor() {
    super("Google Tasks API returned 403 — scope missing or Tasks API not enabled");
    this.name = "TasksScopeMissingError";
  }
}

/**
 * Thrown on 401 from Google Tasks API — access token was rejected even
 * though our clock says it's still valid. Caller should force-refresh
 * the token and retry once (same pattern as calendar sync).
 */
export class TasksUnauthorizedError extends Error {
  constructor() {
    super("Google Tasks API returned 401 — access token rejected, needs refresh");
    this.name = "TasksUnauthorizedError";
  }
}

/** List every task list the user owns. */
export async function listTaskLists(
  accessToken: string
): Promise<GoogleTaskList[]> {
  const out: GoogleTaskList[] = [];
  let pageToken: string | undefined = undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ maxResults: "100" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fetch(`${TASKS_API}/users/@me/lists?${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) throw new TasksUnauthorizedError();
    if (res.status === 403) throw new TasksScopeMissingError();
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google tasklists failed (${res.status}): ${body}`);
    }
    const json = (await res.json()) as {
      items?: GoogleTaskList[];
      nextPageToken?: string;
    };
    if (json.items) out.push(...json.items);
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

/**
 * List tasks in a given list. `updatedMin` bounds the pull for incremental
 * sync; include completed + deleted so we can reflect state changes.
 */
export async function listTasks(params: {
  accessToken: string;
  tasklistId: string;
  updatedMin?: string;
}): Promise<GoogleTask[]> {
  const out: GoogleTask[] = [];
  let pageToken: string | undefined = undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({
      maxResults: "100",
      showCompleted: "true",
      showDeleted: "true",
      showHidden: "true",
    });
    if (params.updatedMin) qs.set("updatedMin", params.updatedMin);
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fetch(
      `${TASKS_API}/lists/${encodeURIComponent(params.tasklistId)}/tasks?${qs}`,
      { headers: { Authorization: `Bearer ${params.accessToken}` } }
    );
    if (res.status === 401) throw new TasksUnauthorizedError();
    if (res.status === 403) throw new TasksScopeMissingError();
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google tasks.list failed (${res.status}): ${body}`);
    }
    const json = (await res.json()) as {
      items?: GoogleTask[];
      nextPageToken?: string;
    };
    if (json.items) out.push(...json.items);
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

/**
 * PATCH a single task's status (completed ↔ needsAction). Returns the
 * updated task so the caller can refresh local state with the new
 * `completed` timestamp and `updated` etag.
 *
 * Google's semantics:
 *   - Setting status=completed requires `tasks` scope (not readonly).
 *   - `completed` is only set when status=completed; flipping back to
 *     needsAction should clear it — we pass null explicitly.
 */
export async function patchTaskStatus(params: {
  accessToken: string;
  tasklistId: string;
  taskId: string;
  status: "completed" | "needsAction";
}): Promise<GoogleTask> {
  const body: Record<string, unknown> = { status: params.status };
  if (params.status === "needsAction") {
    // Explicitly clear completed timestamp when reopening, otherwise Google
    // keeps the old one around and the UI looks stale.
    body.completed = null;
  }
  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(
      params.tasklistId
    )}/tasks/${encodeURIComponent(params.taskId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 401) throw new TasksUnauthorizedError();
  if (res.status === 403) throw new TasksScopeMissingError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google tasks.patch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleTask;
}

/**
 * Thrown when a PATCH is rejected because the caller's etag doesn't
 * match Google's current one — meaning someone (or another sync) edited
 * the task since we last read it. Caller should refetch and re-reconcile
 * rather than blindly overwrite.
 */
export class TaskEtagConflictError extends Error {
  constructor() {
    super("Google Tasks etag mismatch — someone else edited this task");
    this.name = "TaskEtagConflictError";
  }
}

/**
 * Create a new task on a given tasklist. Used by the Inngest push worker
 * when a locally-created task first needs a Google mirror.
 *
 * If `tasklistId` is not provided, the caller should resolve one first
 * (typically by picking the first result from listTaskLists — Google
 * always returns at least one, "My Tasks", for a new account).
 */
export async function createGoogleTask(params: {
  accessToken: string;
  tasklistId: string;
  title: string;
  notes?: string | null;
  /** ISO date (Google Tasks ignores time components on `due`). */
  due?: string | null;
  /** If set, task is created already-completed. */
  status?: "needsAction" | "completed";
}): Promise<GoogleTask> {
  const body: Record<string, unknown> = { title: params.title };
  if (params.notes) body.notes = params.notes;
  if (params.due) body.due = params.due;
  if (params.status) body.status = params.status;

  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(params.tasklistId)}/tasks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 401) throw new TasksUnauthorizedError();
  if (res.status === 403) throw new TasksScopeMissingError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google tasks.insert failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleTask;
}

/**
 * PATCH a full task — title, notes, due, status all in one call. Uses
 * If-Match with the expected etag so concurrent edits don't silently
 * overwrite each other. Throws TaskEtagConflictError on 412 so the
 * caller can pull the remote version and merge.
 *
 * Pass `null` for a field to clear it (Google respects explicit nulls
 * for notes, due, and completed).
 */
export async function patchGoogleTask(params: {
  accessToken: string;
  tasklistId: string;
  taskId: string;
  expectedEtag: string | null;
  title?: string;
  notes?: string | null;
  due?: string | null;
  status?: "needsAction" | "completed";
}): Promise<GoogleTask> {
  const body: Record<string, unknown> = {};
  if (params.title !== undefined) body.title = params.title;
  if (params.notes !== undefined) body.notes = params.notes;
  if (params.due !== undefined) body.due = params.due;
  if (params.status !== undefined) {
    body.status = params.status;
    // Reopening clears the completed timestamp explicitly (Google keeps
    // the stale value around otherwise).
    if (params.status === "needsAction") body.completed = null;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.accessToken}`,
    "Content-Type": "application/json",
  };
  // Only send If-Match when we have an etag. Without one we skip the
  // concurrency check — caller accepts the risk of overwriting a remote
  // change. This is the right tradeoff for blindly-retried rows where
  // we've lost the etag.
  if (params.expectedEtag) {
    headers["If-Match"] = params.expectedEtag;
  }

  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(
      params.tasklistId
    )}/tasks/${encodeURIComponent(params.taskId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    }
  );
  if (res.status === 412) {
    // Precondition-failed — etag didn't match.
    throw new TaskEtagConflictError();
  }
  if (res.status === 401) throw new TasksUnauthorizedError();
  if (res.status === 403) throw new TasksScopeMissingError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google tasks.patch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleTask;
}

/**
 * DELETE a task from Google. Maps to our 'cancelled' status on the
 * local side. Safe to call on a task that's already gone — Google
 * returns 404 which we swallow so cancellation is idempotent.
 */
export async function deleteGoogleTask(params: {
  accessToken: string;
  tasklistId: string;
  taskId: string;
}): Promise<void> {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(
      params.tasklistId
    )}/tasks/${encodeURIComponent(params.taskId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${params.accessToken}` },
    }
  );
  if (res.status === 404) return; // already gone — fine
  if (res.status === 401) throw new TasksUnauthorizedError();
  if (res.status === 403) throw new TasksScopeMissingError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google tasks.delete failed (${res.status}): ${text}`);
  }
}

/**
 * GET a single task. Used for pull-on-conflict — after a 412 we refetch
 * to read the latest state before deciding how to merge.
 */
export async function getGoogleTask(params: {
  accessToken: string;
  tasklistId: string;
  taskId: string;
}): Promise<GoogleTask> {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(
      params.tasklistId
    )}/tasks/${encodeURIComponent(params.taskId)}`,
    { headers: { Authorization: `Bearer ${params.accessToken}` } }
  );
  if (res.status === 401) throw new TasksUnauthorizedError();
  if (res.status === 403) throw new TasksScopeMissingError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google tasks.get failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleTask;
}

/**
 * Map a Google Task into our `google_tasks` row shape. Returns null if
 * the task was deleted (caller should remove the row).
 */
export function toTaskRow(
  gtask: GoogleTask,
  opts: {
    teamMemberId: string;
    googleAccountId: string;
    tasklistId: string;
  }
): null | {
  team_member_id: string;
  google_account_id: string;
  google_tasklist_id: string;
  google_task_id: string;
  title: string;
  notes: string | null;
  status: string;
  due_at: string | null;
  completed_at: string | null;
  parent_task_id: string | null;
  position: string | null;
  etag: string | null;
  remote_updated_at: string | null;
} {
  if (gtask.deleted) return null;
  return {
    team_member_id: opts.teamMemberId,
    google_account_id: opts.googleAccountId,
    google_tasklist_id: opts.tasklistId,
    google_task_id: gtask.id,
    title: gtask.title?.trim() || "(untitled task)",
    notes: gtask.notes ?? null,
    status: gtask.status,
    due_at: gtask.due ?? null,
    completed_at: gtask.completed ?? null,
    parent_task_id: gtask.parent ?? null,
    position: gtask.position ?? null,
    etag: gtask.etag ?? null,
    remote_updated_at: gtask.updated ?? null,
  };
}
