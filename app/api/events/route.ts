/**
 * POST /api/events — create a new event from the dashboard form.
 *
 * Dashboard-specific (source='dashboard'). SMS/WhatsApp uses the
 * parser+dispatcher directly. Google pulls go through lib/google/sync.ts.
 * All three ultimately land in public.events; this route is the
 * dashboard's human-friendly entry.
 *
 * Auth: logged-in team member only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createEvent } from "@/lib/events/service";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const Body = z.object({
  title: z.string().min(1).max(500),
  starts_at: z.string().datetime(),
  // Optional — events service defaults to starts_at + 1h when omitted.
  ends_at: z.string().datetime().optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  description: z.string().max(5000).optional().nullable(),
  // Optional timezone override. If unset, uses the creator's team_members.timezone.
  timezone: z.string().max(64).optional().nullable(),
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
    .select("id, timezone")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; timezone: string } | null;
  };
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
    const event = await createEvent({
      teamMemberId: member.id,
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      startsAt: body.starts_at,
      endsAt: body.ends_at ?? null,
      timezone: body.timezone ?? member.timezone ?? "America/New_York",
      source: "dashboard",
    });
    return NextResponse.json({ ok: true, event });
  } catch (err: any) {
    console.error("[api/events] create failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "create failed" },
      { status: 500 }
    );
  }
}
