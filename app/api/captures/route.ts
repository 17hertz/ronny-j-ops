/**
 * POST /api/captures
 *
 * Receives an image upload from the dashboard drag-drop, stores it in
 * the 'captures' Supabase Storage bucket, creates a bill_captures row,
 * and emits the Inngest classify event. Returns the capture id so the
 * UI can poll status (or just refresh later).
 *
 * Auth: logged-in team_member.
 *
 * Form: multipart/form-data with field 'file' = the image.
 *
 * Cap: ~10MB per upload (matches typical phone photo sizes; tighten
 * later if abuse). Rejects non-image MIME types.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCapture } from "@/lib/captures/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

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

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid multipart body" },
      { status: 400 }
    );
  }

  if (!file) {
    return NextResponse.json(
      { ok: false, error: "no 'file' field in form data" },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "image too large (max 10MB)" },
      { status: 400 }
    );
  }
  const mime = file.type || "image/jpeg";
  if (!ALLOWED_MIME.has(mime.toLowerCase())) {
    return NextResponse.json(
      { ok: false, error: `unsupported image type: ${mime}` },
      { status: 400 }
    );
  }

  // Path: captures/<team_member>/<yyyy-mm-dd>/<uuid>-<filename>
  // Time-bucketed for tidy listing; user-prefixed for quick scoping.
  const today = new Date().toISOString().slice(0, 10);
  const safeName = (file.name || "image")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
  const objectPath = `${member.id}/${today}/${crypto.randomUUID()}-${safeName}`;

  const admin = createAdminClient();
  const buf = Buffer.from(await file.arrayBuffer());

  const { error: uploadErr } = await (admin as any).storage
    .from("captures")
    .upload(objectPath, buf, {
      contentType: mime,
      upsert: false,
    });

  if (uploadErr) {
    console.error("[api/captures] upload failed", uploadErr);
    return NextResponse.json(
      { ok: false, error: `upload failed: ${uploadErr.message}` },
      { status: 500 }
    );
  }

  try {
    const capture = await createCapture({
      source: "dashboard",
      teamMemberId: member.id,
      imageStoragePath: objectPath,
      imageMimeType: mime,
      imageByteSize: file.size,
    });
    return NextResponse.json({
      ok: true,
      captureId: capture.id,
      status: capture.status,
    });
  } catch (err: any) {
    console.error("[api/captures] createCapture failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "create capture failed" },
      { status: 500 }
    );
  }
}
