import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshAccessToken } from "@/lib/google/oauth";
import { patchTaskStatus, TasksScopeMissingError } from "@/lib/google/tasks";

export const dynamic = "force-dynamic";
// Single PATCH + small local update. Default Vercel timeout is fine but
// keep a modest ceiling in case Google is slow.
export const maxDuration = 15;

/**
 * POST /api/google/tasks/:id/toggle
 *
 * Flip a task between `completed` and `needsAction`. `:id` is the
 * `public.tasks.id` (our local uuid), not Google's task id. Route lives
 * under /api/google/tasks/ for URL-stability even though the source table
 * changed — the client already posts here.
 *
 * Body: { status: "completed" | "needsAction" }
 *
 * Flow:
 *   1. Auth — Supabase session → team_members row.
 *   2. Load the local public.tasks row, verify team_member_id matches.
 *   3. If the task has no google_task_id (local-only, never pushed —
 *      a newly-created dashboard task, for example), just update local
 *      state. The Inngest push worker (step 3 of the rollout) will
 *      propagate the completed state on its first push.
 *   4. Otherwise: load the google_calendar_accounts row, refresh the
 *      access token if it's near expiry, PATCH Google first, then mirror
 *      into public.tasks. Google-first ordering prevents the UI showing
 *      "done" for something Google thinks is still open.
 *
 * On 401/403 from Google we surface `scope_missing: true` so the client
 * can tell the user to reconnect.
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { data: member } = (await sb
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };

  if (!member) {
    return NextResponse.json({ error: "not_team_member" }, { status: 403 });
  }

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const desired = body.status;
  if (desired !== "completed" && desired !== "needsAction") {
    return NextResponse.json(
      { error: "status must be 'completed' or 'needsAction'" },
      { status: 400 }
    );
  }

  // Use the admin client past this point so the multi-table update isn't
  // fighting RLS policies. Ownership is enforced explicitly in the WHERE.
  const admin = createAdminClient();

  const { data: task, error: taskErr } = (await (admin as any)
    .from("tasks")
    .select(
      "id, team_member_id, google_account_id, google_tasklist_id, google_task_id"
    )
    .eq("id", params.id)
    .maybeSingle()) as {
    data: {
      id: string;
      team_member_id: string;
      google_account_id: string | null;
      google_tasklist_id: string | null;
      google_task_id: string | null;
    } | null;
    error: { message: string } | null;
  };

  if (taskErr) {
    console.error("[tasks/toggle] lookup failed", taskErr);
    return NextResponse.json({ error: taskErr.message }, { status: 500 });
  }
  if (!task) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (task.team_member_id !== member.id) {
    // Belt-and-braces — RLS would already block a regular client, but the
    // admin client we use here does not enforce it.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Local-only task (never pushed to Google yet — e.g. freshly created
  // from the dashboard form before the Inngest push worker has run).
  // Update local state and queue a push; the worker will PATCH Google
  // on our behalf with the final status.
  if (!task.google_task_id || !task.google_account_id || !task.google_tasklist_id) {
    const { error: updateErr } = await (admin as any)
      .from("tasks")
      .update({
        status: desired,
        completed_at: desired === "completed" ? new Date().toISOString() : null,
        push_status: "pending",
        last_push_attempt_at: null,
        push_error: null,
      })
      .eq("id", task.id);
    if (updateErr) {
      console.error("[tasks/toggle] local-only update failed", updateErr);
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      status: desired,
      completed_at: desired === "completed" ? new Date().toISOString() : null,
    });
  }

  const { data: acct, error: acctErr } = (await (admin as any)
    .from("google_calendar_accounts")
    .select("id, access_token, refresh_token, token_expires_at")
    .eq("id", task.google_account_id)
    .maybeSingle()) as {
    data: {
      id: string;
      access_token: string;
      refresh_token: string;
      token_expires_at: string;
    } | null;
    error: { message: string } | null;
  };

  if (acctErr || !acct) {
    return NextResponse.json(
      { error: acctErr?.message ?? "google account missing" },
      { status: 500 }
    );
  }

  // Refresh token if we're within 2 minutes of expiry — same logic as sync.
  let accessToken = acct.access_token;
  const expiresAt = new Date(acct.token_expires_at).getTime();
  if (expiresAt - Date.now() < 120 * 1000) {
    try {
      const refreshed = await refreshAccessToken(acct.refresh_token);
      accessToken = refreshed.access_token;
      const newExpiresAt = new Date(
        Date.now() + refreshed.expires_in * 1000
      ).toISOString();
      await (admin as any)
        .from("google_calendar_accounts")
        .update({
          access_token: accessToken,
          token_expires_at: newExpiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", acct.id);
    } catch (err: any) {
      console.error("[tasks/toggle] refresh failed", err);
      return NextResponse.json(
        { error: "token refresh failed" },
        { status: 500 }
      );
    }
  }

  // PATCH Google first so local state doesn't lie about remote truth.
  let gtask;
  try {
    gtask = await patchTaskStatus({
      accessToken,
      tasklistId: task.google_tasklist_id,
      taskId: task.google_task_id,
      status: desired,
    });
  } catch (err) {
    if (err instanceof TasksScopeMissingError) {
      return NextResponse.json(
        { ok: false, scope_missing: true },
        { status: 403 }
      );
    }
    console.error("[tasks/toggle] patch failed", err);
    return NextResponse.json(
      { error: (err as Error).message ?? "patch failed" },
      { status: 500 }
    );
  }

  // Mirror the new state into public.tasks. Google clears `completed` when
  // the task is reopened, so we mirror both sides. push_status='pushed'
  // because we just PATCHed Google successfully — no queued write to do.
  const { error: updateErr } = await (admin as any)
    .from("tasks")
    .update({
      status: gtask.status,
      completed_at: gtask.completed ?? null,
      remote_updated_at: gtask.updated ?? null,
      remote_etag: gtask.etag ?? null,
      push_status: "pushed",
      last_push_attempt_at: new Date().toISOString(),
      push_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", task.id);

  if (updateErr) {
    console.error("[tasks/toggle] local update failed", updateErr);
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    status: gtask.status,
    completed_at: gtask.completed ?? null,
  });
}
