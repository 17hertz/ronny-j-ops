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
 * Thrown when the access token doesn't include the tasks scope. The caller
 * can catch this and surface a "reconnect Google to enable tasks" nudge
 * without failing the whole sync. Also thrown on the write path when the
 * token was minted before we upgraded to the full `tasks` scope and only
 * has `tasks.readonly` — Google returns 403 on PATCH in that case.
 */
export class TasksScopeMissingError extends Error {
  constructor() {
    super("Google access token is missing the tasks scope");
    this.name = "TasksScopeMissingError";
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
    if (res.status === 401 || res.status === 403) {
      throw new TasksScopeMissingError();
    }
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
    if (res.status === 401 || res.status === 403) {
      throw new TasksScopeMissingError();
    }
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
  if (res.status === 401 || res.status === 403) {
    throw new TasksScopeMissingError();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google tasks.patch failed (${res.status}): ${text}`);
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
