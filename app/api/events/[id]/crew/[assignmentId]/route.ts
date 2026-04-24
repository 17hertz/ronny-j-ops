/**
 * DELETE /api/events/:id/crew/:assignmentId
 *
 * Remove a single event_vendors row. The Remove button on the dashboard
 * crew list calls this. Ownership check: the viewer must be able to see
 * the event (created_by = me OR shared).
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; assignmentId: string } }
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

  const admin = createAdminClient();

  // Verify both (a) the assignment belongs to the event in the URL and
  // (b) the viewer has visibility into that event.
  const { data: assignment } = (await (admin as any)
    .from("event_vendors")
    .select("id, event_id")
    .eq("id", params.assignmentId)
    .maybeSingle()) as {
    data: { id: string; event_id: string } | null;
  };
  if (!assignment || assignment.event_id !== params.id) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const { data: event } = (await (admin as any)
    .from("events")
    .select("id, created_by, shared")
    .eq("id", params.id)
    .maybeSingle()) as {
    data: { id: string; created_by: string | null; shared: boolean } | null;
  };
  if (!event) {
    return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  }
  if (event.created_by !== member.id && !event.shared) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const { error } = await (admin as any)
    .from("event_vendors")
    .delete()
    .eq("id", params.assignmentId);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
