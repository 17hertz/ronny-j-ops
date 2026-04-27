/**
 * Bill captures service — image-in / artifact-out pipeline.
 *
 * createCapture inserts a new bill_captures row with the uploaded image
 * pointer and emits an Inngest event so the classifier worker picks it
 * up. Other helpers update the row through its lifecycle (classifying →
 * done | needs_review | error) and link the routed artifact.
 *
 * The actual classification + routing logic lives in
 * lib/captures/classify.ts (Claude vision call) and the Inngest
 * function captureClassifyRunner (which orchestrates).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export type CaptureSource = "dashboard" | "mms" | "whatsapp" | "email";

export type DetectedIntent =
  | "task"
  | "event"
  | "bill_service"
  | "bill_product"
  | "contact"
  | "other";

export type CaptureRow = {
  id: string;
  source: CaptureSource;
  team_member_id: string | null;
  image_storage_path: string;
  image_mime_type: string | null;
  image_byte_size: number | null;
  classification: unknown | null;
  detected_intent: DetectedIntent | null;
  detection_confidence: number | null;
  detection_reasoning: string | null;
  routed_task_id: string | null;
  routed_event_id: string | null;
  routed_expense_id: string | null;
  status: "pending" | "classifying" | "done" | "needs_review" | "error";
  error_message: string | null;
  reply_text: string | null;
  created_at: string;
  updated_at: string;
};

export async function createCapture(opts: {
  source: CaptureSource;
  teamMemberId: string | null;
  imageStoragePath: string;
  imageMimeType?: string | null;
  imageByteSize?: number | null;
}): Promise<CaptureRow> {
  const admin = createAdminClient();
  const { data, error } = (await (admin as any)
    .from("bill_captures")
    .insert({
      source: opts.source,
      team_member_id: opts.teamMemberId,
      image_storage_path: opts.imageStoragePath,
      image_mime_type: opts.imageMimeType ?? null,
      image_byte_size: opts.imageByteSize ?? null,
      status: "pending",
    })
    .select("*")
    .single()) as {
    data: CaptureRow | null;
    error: { message: string } | null;
  };
  if (error || !data) {
    throw new Error(`createCapture failed: ${error?.message ?? "no row"}`);
  }

  // Fire-and-forget. If Inngest emit fails, the row is still in
  // status='pending' — a future "retry stuck captures" cron (todo)
  // could re-emit. For now log + continue.
  try {
    await inngest.send({
      name: "capture/classify",
      data: { captureId: data.id },
    });
  } catch (err) {
    console.error("[captures/service] inngest emit failed", err);
  }

  return data;
}

export async function getCapture(id: string): Promise<CaptureRow | null> {
  const admin = createAdminClient();
  const { data } = (await (admin as any)
    .from("bill_captures")
    .select("*")
    .eq("id", id)
    .maybeSingle()) as { data: CaptureRow | null };
  return data;
}

/**
 * Update lifecycle + routing fields. Used by the Inngest classifier as
 * it progresses: 'classifying' → 'done' | 'needs_review' | 'error'.
 */
export async function updateCaptureOutcome(
  id: string,
  patch: Partial<{
    status: CaptureRow["status"];
    classification: unknown;
    detected_intent: DetectedIntent | null;
    detection_confidence: number | null;
    detection_reasoning: string | null;
    routed_task_id: string | null;
    routed_event_id: string | null;
    routed_expense_id: string | null;
    error_message: string | null;
    reply_text: string | null;
  }>
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await (admin as any)
    .from("bill_captures")
    .update(patch)
    .eq("id", id);
  if (error) {
    console.error("[captures/service] update failed", error);
    throw new Error(`updateCaptureOutcome failed: ${error.message}`);
  }
}
