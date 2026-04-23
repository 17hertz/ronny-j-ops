/**
 * POST /api/sync-errors/retry
 *
 * Re-emit the Inngest push event for a single errored row so the worker
 * takes another swing at Google. Used by the dashboard's sync-errors
 * panel when Jason clicks Retry next to a task or event that failed
 * to push.
 *
 * Request body: { kind: "task" | "event", id: string }
 *
 * What we do:
 *   1. Verify auth + team membership.
 *   2. Load the target row; confirm team_member ownership (the admin
 *      client bypasses RLS so we check manually).
 *   3. Reset push_status='pending', push_error=null, last_push_attempt_at=null.
 *   4. Re-emit task/push-to-google OR event/push-to-google-calendar.
 *
 * Not retryable: rows with push_status='skip' (permission-denied or
 * scope-missing). Those need a Google reconnect — the banner at the top
 * of the dashboard handles that flow.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const Body = z.object({
  kind: z.enum(["task", "event"]),
  id: z.string().uuid(),
});

export async function POST(request: Request) {
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  const { data: member } = (await sb
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };
  if (!member) {
    return NextResponse.json({ ok: false, error: "not_team_member" }, { status: 403 });
  }

  let body;
  try {
    body = Body.parse(await request.json());
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: `invalid body: ${err?.message ?? "parse error"}` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  if (body.kind === "task") {
    // Tasks are owned by team_member_id directly.
    const { data: task } = (await (admin as any)
      .from("tasks")
      .select("id, team_member_id, push_status")
      .eq("id", body.id)
      .maybeSingle()) as {
      data: {
        id: string;
        team_member_id: string;
        push_status: string;
      } | null;
    };
    if (!task) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (task.team_member_id !== member.id) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
    if (task.push_status !== "error") {
      return NextResponse.json({
        ok: false,
        error: `not retryable (status=${task.push_status})`,
      });
    }

    await (admin as any)
      .from("tasks")
      .update({
        push_status: "pending",
        push_error: null,
        last_push_attempt_at: null,
      })
      .eq("id", task.id);

    try {
      await inngest.send({
        name: "task/push-to-google",
        data: { taskId: task.id },
      });
    } catch (err) {
      console.error("[sync-errors/retry] inngest emit failed", err);
    }
    return NextResponse.json({ ok: true });
  }

  // kind === "event"
  // Events use created_by for ownership (plus any shared-team visibility
  // we may layer on later). For v1, only the creator can retry.
  const { data: event } = (await (admin as any)
    .from("events")
    .select("id, created_by, push_status")
    .eq("id", body.id)
    .maybeSingle()) as {
    data: {
      id: string;
      created_by: string | null;
      push_status: string;
    } | null;
  };
  if (!event) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (event.created_by !== member.id) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (event.push_status !== "error") {
    return NextResponse.json({
      ok: false,
      error: `not retryable (status=${event.push_status})`,
    });
  }

  await (admin as any)
    .from("events")
    .update({
      push_status: "pending",
      push_error: null,
      last_push_attempt_at: null,
    })
    .eq("id", event.id);

  try {
    await inngest.send({
      name: "event/push-to-google-calendar",
      data: { eventId: event.id, teamMemberId: member.id },
    });
  } catch (err) {
    console.error("[sync-errors/retry] inngest emit failed", err);
  }
  return NextResponse.json({ ok: true });
}
