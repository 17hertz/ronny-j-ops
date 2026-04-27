/**
 * GET /api/captures/:id
 *
 * Returns the current status + result of a capture so the upload UI
 * can poll until classification is done. Scoped to the requesting team
 * member; admins can read any.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
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
    .select("id, role")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string; role: string } | null };
  if (!member) {
    return NextResponse.json({ ok: false, error: "not_team_member" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: capture } = (await (admin as any)
    .from("bill_captures")
    .select(
      "id, status, detected_intent, detection_confidence, reply_text, error_message, routed_task_id, routed_event_id, routed_expense_id, team_member_id, created_at, updated_at"
    )
    .eq("id", params.id)
    .maybeSingle()) as {
    data: {
      id: string;
      status: string;
      detected_intent: string | null;
      detection_confidence: number | null;
      reply_text: string | null;
      error_message: string | null;
      routed_task_id: string | null;
      routed_event_id: string | null;
      routed_expense_id: string | null;
      team_member_id: string | null;
      created_at: string;
      updated_at: string;
    } | null;
  };

  if (!capture) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (
    capture.team_member_id !== member.id &&
    member.role !== "admin"
  ) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({ ok: true, capture });
}
