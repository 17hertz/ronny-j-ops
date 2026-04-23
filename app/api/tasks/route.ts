/**
 * POST /api/tasks — create a new task from the dashboard form.
 *
 * Dashboard-specific entry point (`source='dashboard'`). The SMS handler
 * and Claude agent hit lib/tasks/service.ts directly with their own
 * source tag, so we don't funnel every caller through this one route.
 *
 * Auth: logged-in team_member only. Non-members bounce.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createTask } from "@/lib/tasks/service";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const Body = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(5000).optional().nullable(),
  // ISO date string. Accept `null` so "no due date" is explicit.
  dueAt: z.string().datetime().optional().nullable(),
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

  try {
    const task = await createTask({
      teamMemberId: member.id,
      title: body.title,
      notes: body.notes ?? null,
      dueAt: body.dueAt ?? null,
      source: "dashboard",
    });
    return NextResponse.json({ ok: true, task });
  } catch (err: any) {
    console.error("[api/tasks] create failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "create failed" },
      { status: 500 }
    );
  }
}
