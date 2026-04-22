/**
 * Google Tasks API v1 client.
 *
 * We only read — our `google_tasks` table is a read-only mirror. Any change
 * flows Google → us, never the other direction. The Tasks API has no sync
 * token like Calendar, so we use `updatedMin` for incremental-ish pulls
 * and rely on the unique (account, list, task) index for idempotence.
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
 * without failing the whole sync.
 */
export class TasksScopeMissingError extends Error {
  constructor() {
    super("Google access token is missing the tasks.readonly scope");
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
