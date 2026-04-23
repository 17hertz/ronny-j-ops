/**
 * Unified tasks service — the single entry point for task mutations.
 *
 * Every caller that creates, updates, completes, or cancels a task goes
 * through here:
 *   - Dashboard "new task" form → createTask
 *   - Dashboard "mark done" button → completeTask
 *   - SMS / WhatsApp inbound dispatcher → createTask (source='sms' | 'whatsapp')
 *   - Claude agent chat tool → createTask / completeTask / cancelTask
 *   - Google Tasks pull sync → upsertFromGoogle (not exported yet; lands
 *     in the reverse-sync update)
 *
 * Everything writes to public.tasks (the SoT). After a local mutation
 * that should propagate to Google, we emit an Inngest event so the
 * push worker handles it async. The HTTP caller does not block on the
 * Google API.
 *
 * Service-role client throughout: identity is established by the caller,
 * but writes shouldn't fight RLS (SMS/agent/cron paths have no session).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export type TaskSource =
  | "dashboard"
  | "sms"
  | "whatsapp"
  | "agent"
  | "email"
  | "google";

export type TaskStatus = "needsAction" | "completed" | "cancelled";

export type TaskRow = {
  id: string;
  team_member_id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  due_at: string | null;
  completed_at: string | null;
  source: TaskSource;
  google_account_id: string | null;
  google_tasklist_id: string | null;
  google_task_id: string | null;
  remote_etag: string | null;
  remote_updated_at: string | null;
  push_status: "pending" | "pushed" | "error" | "skip";
  push_error: string | null;
  last_push_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Create a new task owned by a team member. Returns the inserted row.
 *
 * If the caller wants it mirrored to Google Tasks, pass `pushToGoogle: true`
 * (default). We still write the row synchronously; the Google push happens
 * via an Inngest event so the HTTP response doesn't wait on Google latency.
 */
export async function createTask(opts: {
  teamMemberId: string;
  title: string;
  notes?: string | null;
  dueAt?: string | null;
  source: TaskSource;
  /** Default true. Set false for local-only tasks (rare). */
  pushToGoogle?: boolean;
}): Promise<TaskRow> {
  const admin = createAdminClient();
  const pushToGoogle = opts.pushToGoogle ?? true;

  const { data, error } = (await (admin as any)
    .from("tasks")
    .insert({
      team_member_id: opts.teamMemberId,
      title: opts.title.trim(),
      notes: opts.notes?.trim() || null,
      status: "needsAction",
      due_at: opts.dueAt ?? null,
      source: opts.source,
      push_status: pushToGoogle ? "pending" : "skip",
    })
    .select("*")
    .single()) as { data: TaskRow | null; error: { message: string } | null };

  if (error || !data) {
    throw new Error(`createTask failed: ${error?.message ?? "no row"}`);
  }

  if (pushToGoogle) {
    // Fire-and-forget — the task row exists regardless of whether the
    // event emit succeeds. If Inngest is down, the nightly reconciler
    // (todo) can re-emit for rows still in push_status='pending'.
    try {
      await inngest.send({
        name: "task/push-to-google",
        data: { taskId: data.id },
      });
    } catch (err) {
      console.error("[tasks/service] inngest emit failed", err);
    }
  }

  return data;
}

/**
 * Patch a task's editable fields. Does not change Google linkage columns —
 * those are owned by the sync layer. Re-queues a Google push because any
 * user-visible field change should propagate.
 */
export async function updateTask(opts: {
  taskId: string;
  title?: string;
  notes?: string | null;
  dueAt?: string | null;
}): Promise<TaskRow> {
  const admin = createAdminClient();

  const patch: Record<string, unknown> = {
    push_status: "pending",
    last_push_attempt_at: null,
    push_error: null,
  };
  if (opts.title !== undefined) patch.title = opts.title.trim();
  if (opts.notes !== undefined) patch.notes = opts.notes?.trim() || null;
  if (opts.dueAt !== undefined) patch.due_at = opts.dueAt;

  const { data, error } = (await (admin as any)
    .from("tasks")
    .update(patch)
    .eq("id", opts.taskId)
    .select("*")
    .single()) as { data: TaskRow | null; error: { message: string } | null };

  if (error || !data) {
    throw new Error(`updateTask failed: ${error?.message ?? "no row"}`);
  }

  // Only push if it was already linked to Google (otherwise it's local-only).
  if (data.push_status !== "skip") {
    try {
      await inngest.send({
        name: "task/push-to-google",
        data: { taskId: data.id },
      });
    } catch (err) {
      console.error("[tasks/service] inngest emit failed", err);
    }
  }

  return data;
}

/**
 * Mark a task complete. Idempotent — calling on an already-completed row
 * is a no-op for the status but still bumps updated_at + re-queues push
 * (cheap and avoids "completed locally but Google still shows it" drift).
 */
export async function completeTask(taskId: string): Promise<TaskRow> {
  const admin = createAdminClient();

  const { data, error } = (await (admin as any)
    .from("tasks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      push_status: "pending",
      last_push_attempt_at: null,
      push_error: null,
    })
    .eq("id", taskId)
    .select("*")
    .single()) as { data: TaskRow | null; error: { message: string } | null };

  if (error || !data) {
    throw new Error(`completeTask failed: ${error?.message ?? "no row"}`);
  }

  if (data.push_status !== "skip") {
    try {
      await inngest.send({
        name: "task/push-to-google",
        data: { taskId: data.id },
      });
    } catch (err) {
      console.error("[tasks/service] inngest emit failed", err);
    }
  }

  return data;
}

/**
 * Cancel (soft-delete) a task. Local row stays for audit; push worker
 * translates this to a Google DELETE on the mirror side.
 */
export async function cancelTask(taskId: string): Promise<TaskRow> {
  const admin = createAdminClient();

  const { data, error } = (await (admin as any)
    .from("tasks")
    .update({
      status: "cancelled",
      push_status: "pending",
      last_push_attempt_at: null,
      push_error: null,
    })
    .eq("id", taskId)
    .select("*")
    .single()) as { data: TaskRow | null; error: { message: string } | null };

  if (error || !data) {
    throw new Error(`cancelTask failed: ${error?.message ?? "no row"}`);
  }

  if (data.push_status !== "skip") {
    try {
      await inngest.send({
        name: "task/push-to-google",
        data: { taskId: data.id },
      });
    } catch (err) {
      console.error("[tasks/service] inngest emit failed", err);
    }
  }

  return data;
}

/**
 * Fetch tasks completed "today" for a team member, in the given zone.
 * Used by the dashboard's collapsible recap section and the end-of-day
 * digest. "Today" = calendar day in `tz`, honored so a task completed at
 * 11:45pm doesn't roll off the recap the moment it's 12:01am UTC.
 */
export async function listCompletedTodayForMember(opts: {
  teamMemberId: string;
  tz?: string;
}): Promise<TaskRow[]> {
  const tz = opts.tz ?? "America/New_York";
  const admin = createAdminClient();

  // Today's start/end in the zone — computed via Intl (no date-fns-tz
  // dep needed for this). en-CA's ISO-ordered date makes the math easy.
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  // Offset derivation: compare UTC noon against the zone's local noon to
  // infer the UTC offset on this specific date (respects DST).
  const anchor = new Date(`${ymd}T12:00:00Z`);
  const hourInZone = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(anchor)
  );
  const offsetHours = 12 - hourInZone;
  const startUtc = new Date(`${ymd}T00:00:00Z`);
  startUtc.setUTCHours(startUtc.getUTCHours() + offsetHours);
  const endUtc = new Date(startUtc);
  endUtc.setUTCDate(endUtc.getUTCDate() + 1);

  const { data, error } = (await (admin as any)
    .from("tasks")
    .select("*")
    .eq("team_member_id", opts.teamMemberId)
    .eq("status", "completed")
    .gte("completed_at", startUtc.toISOString())
    .lt("completed_at", endUtc.toISOString())
    .order("completed_at", { ascending: false })) as {
    data: TaskRow[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`listCompletedToday failed: ${error.message}`);
  return data ?? [];
}

/**
 * Fetch the open + recently-completed tasks for a team member. Used by
 * the dashboard list + the daily digest renderer. Completed rows older
 * than `completedWithinDays` drop off (default 7 — matches the week-view
 * cadence Ronny is getting acclimated to).
 */
export async function listTasksForMember(opts: {
  teamMemberId: string;
  includeCompleted?: boolean;
  completedWithinDays?: number;
  limit?: number;
}): Promise<TaskRow[]> {
  const admin = createAdminClient();
  const includeCompleted = opts.includeCompleted ?? true;
  const withinDays = opts.completedWithinDays ?? 7;
  const limit = opts.limit ?? 200;

  let q = (admin as any)
    .from("tasks")
    .select("*")
    .eq("team_member_id", opts.teamMemberId)
    .neq("status", "cancelled") // hide soft-deletes by default
    .order("status", { ascending: true }) // needsAction before completed
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!includeCompleted) {
    q = q.eq("status", "needsAction");
  } else {
    // Drop stale completed rows so the list stays actionable.
    const cutoff = new Date(
      Date.now() - withinDays * 24 * 60 * 60 * 1000
    ).toISOString();
    q = q.or(`status.eq.needsAction,completed_at.gte.${cutoff}`);
  }

  const { data, error } = (await q) as {
    data: TaskRow[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`listTasksForMember failed: ${error.message}`);
  return data ?? [];
}
