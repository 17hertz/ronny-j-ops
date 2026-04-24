/**
 * POST /api/events/:id/share
 *
 * Toggle an event's `shared` flag. Only the event's creator can change
 * it — team members can see shared events but can't re-share events
 * that aren't theirs.
 *
 * Request body: { shared: boolean }
 *
 * Returns: { ok: true, shared: boolean } on success.
 *
 * Note: we don't push the shared flag to Google Calendar because
 * Google Calendar has its own sharing model at the calendar level,
 * not per-event. "Shared within Ronny J Ops" is purely our concept.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const Body = z.object({
  shared: z.boolean(),
});

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
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

  // Verify ownership — only creator can toggle sharing.
  const { data: event } = (await (admin as any)
    .from("events")
    .select("id, created_by")
    .eq("id", params.id)
    .maybeSingle()) as {
    data: { id: string; created_by: string | null } | null;
  };
  if (!event) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (event.created_by !== member.id) {
    return NextResponse.json(
      { ok: false, error: "only the event's creator can change sharing" },
      { status: 403 }
    );
  }

  const { error } = await (admin as any)
    .from("events")
    .update({ shared: body.shared })
    .eq("id", event.id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, shared: body.shared });
}
