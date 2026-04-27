/**
 * POST /api/captures/:id/reclassify
 *
 * Re-run the classifier on an existing capture. Useful after we update
 * the system prompt (e.g. taught it to handle booking contracts), or
 * when a needs_review row was a misfire and we want another shot.
 *
 * What it does:
 *   1. Verify the capture belongs to the requesting team_member.
 *   2. Reset status → 'pending', clear classification + routing fields.
 *      (The original image stays in Storage; we don't re-upload.)
 *   3. Re-emit the `capture/classify` Inngest event.
 *
 * Idempotent: hitting it twice just re-runs twice. The Inngest worker
 * picks up the latest emit.
 *
 * NOTE: this does NOT undo any previously-routed artifacts (a created
 * task / event / expense). If a misclassification already created a
 * wrong-shaped artifact, that stays around — Jason should delete it
 * separately. The capture's routed_*_id is cleared so the new run can
 * re-route cleanly.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(
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
    .select("id, team_member_id, status")
    .eq("id", params.id)
    .maybeSingle()) as {
    data: { id: string; team_member_id: string | null; status: string } | null;
  };
  if (!capture) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (capture.team_member_id !== member.id && member.role !== "admin") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Reset for re-classification. We deliberately keep image_storage_path
  // (the file itself) and only clear the AI-derived fields.
  const { error: updErr } = await (admin as any)
    .from("bill_captures")
    .update({
      status: "pending",
      classification: null,
      detected_intent: null,
      detection_confidence: null,
      detection_reasoning: null,
      routed_task_id: null,
      routed_event_id: null,
      routed_expense_id: null,
      error_message: null,
      reply_text: null,
    })
    .eq("id", capture.id);
  if (updErr) {
    return NextResponse.json(
      { ok: false, error: updErr.message },
      { status: 500 }
    );
  }

  try {
    await inngest.send({
      name: "capture/classify",
      data: { captureId: capture.id },
    });
  } catch (err) {
    console.error("[reclassify] inngest emit failed", err);
    // Don't unwind the row reset — the cron-style retry of stuck
    // captures (a follow-up todo) can re-emit later.
  }

  return NextResponse.json({ ok: true });
}
