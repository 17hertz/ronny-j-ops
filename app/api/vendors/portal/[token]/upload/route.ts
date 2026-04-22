/**
 * POST /api/vendors/portal/[token]/upload
 *
 * Accepts a single file (multipart/form-data field "file") plus a "kind"
 * field ("w9" today; future: "invoice", "contract"). The token in the URL
 * authorizes this write — no login required.
 *
 * Flow:
 *   1. Validate token → resolve vendor row (or 404)
 *   2. Validate file size + mime
 *   3. Upload to Supabase Storage bucket "vendor-docs" at
 *      `{vendor_id}/{kind}-{timestamp}.{ext}`
 *   4. Insert vendor_documents row with storage_path
 *   5. If this is the FIRST W9 for a vendor whose status is 'submitted',
 *      bump status to 'in_review' so it shows up on the dashboard panel
 *      with a little urgency.
 *
 * NOTE: The "vendor-docs" bucket needs to exist in Supabase and be
 * private (no public read). See MANUAL_SETUP.md.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const BUCKET = "vendor-docs";
const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPTED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);
const ACCEPTED_KINDS = new Set(["w9", "invoice", "contract", "other"]);

export async function POST(
  req: Request,
  { params }: { params: { token: string } }
) {
  const admin = createAdminClient();

  // 1. Resolve vendor from portal token ------------------------------------
  const { data: vendor } = (await (admin as any)
    .from("vendors")
    .select("id, status, portal_token_expires_at, legal_name")
    .eq("portal_token", params.token)
    .maybeSingle()) as {
    data: {
      id: string;
      status: string;
      portal_token_expires_at: string | null;
      legal_name: string;
    } | null;
  };

  if (!vendor) {
    return NextResponse.json(
      { ok: false, error: "Invalid or expired portal link." },
      { status: 404 }
    );
  }
  if (
    vendor.portal_token_expires_at &&
    new Date(vendor.portal_token_expires_at).getTime() < Date.now()
  ) {
    return NextResponse.json(
      { ok: false, error: "This portal link has expired." },
      { status: 410 }
    );
  }

  // 2. Parse multipart form ------------------------------------------------
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid upload." },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  const kind = String(formData.get("kind") ?? "other");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "No file attached." },
      { status: 400 }
    );
  }
  if (!ACCEPTED_KINDS.has(kind)) {
    return NextResponse.json(
      { ok: false, error: `Unknown document kind: ${kind}` },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "File exceeds 15MB." },
      { status: 413 }
    );
  }
  if (!ACCEPTED_MIME.has(file.type)) {
    return NextResponse.json(
      { ok: false, error: "Only PDF, PNG, or JPG accepted." },
      { status: 415 }
    );
  }

  // 3. Upload to Storage ---------------------------------------------------
  const ext = extFromMime(file.type);
  const path = `${vendor.id}/${kind}-${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await (admin as any).storage
    .from(BUCKET)
    .upload(path, bytes, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadErr) {
    console.error("[vendors/upload] storage upload failed", uploadErr);
    return NextResponse.json(
      {
        ok: false,
        error:
          (uploadErr as { message?: string }).message ??
          "Could not save file. Please try again.",
      },
      { status: 500 }
    );
  }

  // 4. Insert metadata row -------------------------------------------------
  const { error: insertErr } = await (admin as any)
    .from("vendor_documents")
    .insert({
      vendor_id: vendor.id,
      kind,
      storage_path: path,
      original_filename: file.name,
      mime_type: file.type,
      byte_size: file.size,
      uploaded_by_vendor: true,
    });

  if (insertErr) {
    console.error("[vendors/upload] document row insert failed", insertErr);
    // Best effort cleanup so we don't leak orphan storage objects.
    await (admin as any).storage.from(BUCKET).remove([path]);
    return NextResponse.json(
      { ok: false, error: "Upload saved but metadata write failed." },
      { status: 500 }
    );
  }

  // 5. Nudge status to in_review on first W9 -------------------------------
  if (kind === "w9" && vendor.status === "submitted") {
    await (admin as any)
      .from("vendors")
      .update({ status: "in_review" })
      .eq("id", vendor.id);
  }

  return NextResponse.json({ ok: true });
}

function extFromMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  return "bin";
}
