/**
 * POST /api/vendors/invoices/submit
 *
 * Endpoint powering both tabs on /vendors/invoices/new:
 *   - multipart/form-data  → "Upload PDF" mode: vendor attaches their own
 *     invoice PDF.
 *   - application/json     → "Generate invoice" mode: server renders a
 *     PDF from form fields (line items, amounts, etc.)
 *
 * Both paths land in the same place: a vendor_documents row with
 * `kind = "invoice"` and the PDF sitting in the "vendor-docs" bucket.
 *
 * Auth:
 *   - Must be signed in (RLS-scoped supabase client).
 *   - Must own a vendors row whose status is "approved".
 *   Anything else → 403. We don't want half-approved vendors sneaking
 *   invoices in.
 *
 * Storage: service-role client for the actual upload. Upload path is
 *   `{vendor_id}/invoice-{timestamp}.pdf`. If the metadata insert later
 *   fails, we best-effort remove the uploaded file so storage doesn't
 *   leak orphans.
 *
 * What this does NOT do:
 *   - Does NOT email anyone. That's on a downstream notifier (Inngest or
 *     a simple webhook — TBD).
 *   - Does NOT change vendor status. Invoicing is independent of vendor
 *     approval state transitions.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateInvoicePdf } from "@/lib/invoices/generate-pdf";
import { notifyAdminNewInvoice } from "@/lib/invoices/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "vendor-docs";
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_AMOUNT_CENTS = 10_000_000; // $100,000 defensive cap

// Issuer info is hardcoded — 17 Hertz Inc. is the registering entity for
// every vendor relationship under Ronny J today.
const ISSUER = {
  name: "17 Hertz Inc.",
  line1: "Managing vendor services on behalf of Ronny J",
  line2: "Payments remitted via ACH / Zelle",
};

const sharedFields = {
  invoice_number: z.string().trim().min(1).max(60),
  invoice_description: z.string().trim().min(1).max(500),
  invoice_amount_cents: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_AMOUNT_CENTS),
  invoice_due_at: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
};

const generateSchema = z.object({
  mode: z.literal("generate"),
  ...sharedFields,
  line_items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        quantity: z.coerce.number().int().min(1).max(9999),
        unit_amount_cents: z.coerce.number().int().min(0),
      })
    )
    .min(1),
});

// Simple shape for the form-data path (all values come in as strings).
const uploadSchema = z.object(sharedFields);

type VendorRow = {
  id: string;
  legal_name: string;
  status: string;
  ach_account_last4: string | null;
};

export async function POST(req: Request) {
  // ----- Auth ---------------------------------------------------------
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not signed in." },
      { status: 401 }
    );
  }

  const { data: vendor } = (await sb
    .from("vendors")
    .select("id, legal_name, status, ach_account_last4")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: VendorRow | null };

  if (!vendor) {
    return NextResponse.json(
      { ok: false, error: "No vendor account on file." },
      { status: 403 }
    );
  }
  if (vendor.status !== "approved") {
    return NextResponse.json(
      {
        ok: false,
        error: "Only approved vendors can submit invoices.",
      },
      { status: 403 }
    );
  }

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    return handleUpload(req, vendor);
  }
  if (contentType.includes("application/json")) {
    return handleGenerate(req, vendor);
  }
  return NextResponse.json(
    { ok: false, error: "Unsupported content type." },
    { status: 415 }
  );
}

// ---------- Upload mode -------------------------------------------------

async function handleUpload(req: Request, vendor: VendorRow) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid upload payload." },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "Attach a PDF file." },
      { status: 400 }
    );
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json(
      { ok: false, error: "Invoice must be a PDF." },
      { status: 415 }
    );
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json(
      { ok: false, error: "PDF exceeds 15MB." },
      { status: 413 }
    );
  }

  const parsed = uploadSchema.safeParse({
    invoice_number: formData.get("invoice_number"),
    invoice_description: formData.get("invoice_description"),
    invoice_amount_cents: formData.get("invoice_amount_cents"),
    invoice_due_at: formData.get("invoice_due_at"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Validation failed.",
      },
      { status: 400 }
    );
  }

  const fields = parsed.data;
  const bytes = new Uint8Array(await file.arrayBuffer());

  return storeInvoice({
    vendor,
    pdfBytes: bytes,
    byteSize: file.size,
    originalFilename: file.name,
    invoiceNumber: fields.invoice_number,
    invoiceDescription: fields.invoice_description,
    invoiceAmountCents: fields.invoice_amount_cents,
    invoiceDueAt: fields.invoice_due_at,
    generatedBySystem: false,
    formPayload: null,
  });
}

// ---------- Generate mode ----------------------------------------------

async function handleGenerate(req: Request, vendor: VendorRow) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Validation failed.",
      },
      { status: 400 }
    );
  }

  const {
    invoice_number,
    invoice_description,
    invoice_amount_cents,
    invoice_due_at,
    line_items,
  } = parsed.data;

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateInvoicePdf({
      invoiceNumber: invoice_number,
      description: invoice_description,
      dueDate: invoice_due_at,
      lineItems: line_items,
      totalAmountCents: invoice_amount_cents,
      vendor: {
        legalName: vendor.legal_name,
        achLast4: vendor.ach_account_last4,
      },
      issuer: ISSUER,
    });
  } catch (err) {
    console.error("[vendors/invoices/submit] pdf render failed", err);
    return NextResponse.json(
      { ok: false, error: "Could not render invoice PDF." },
      { status: 500 }
    );
  }

  const formPayload = {
    line_items,
    vendor_snapshot: {
      legal_name: vendor.legal_name,
      ach_last4: vendor.ach_account_last4,
    },
    issuer_snapshot: ISSUER,
  };

  return storeInvoice({
    vendor,
    pdfBytes: pdfBuffer,
    byteSize: pdfBuffer.length,
    originalFilename: `invoice-${invoice_number}.pdf`,
    invoiceNumber: invoice_number,
    invoiceDescription: invoice_description,
    invoiceAmountCents: invoice_amount_cents,
    invoiceDueAt: invoice_due_at,
    generatedBySystem: true,
    formPayload,
  });
}

// ---------- Shared storage + insert ------------------------------------

async function storeInvoice(args: {
  vendor: VendorRow;
  pdfBytes: Uint8Array | Buffer;
  byteSize: number;
  originalFilename: string;
  invoiceNumber: string;
  invoiceDescription: string;
  invoiceAmountCents: number;
  invoiceDueAt: string | null;
  generatedBySystem: boolean;
  formPayload: Record<string, unknown> | null;
}) {
  const admin = createAdminClient();
  const path = `${args.vendor.id}/invoice-${Date.now()}.pdf`;

  const { error: uploadErr } = await (admin as any).storage
    .from(BUCKET)
    .upload(path, args.pdfBytes, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadErr) {
    console.error(
      "[vendors/invoices/submit] storage upload failed",
      uploadErr
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          (uploadErr as { message?: string }).message ??
          "Could not save invoice. Please try again.",
      },
      { status: 500 }
    );
  }

  const now = new Date().toISOString();

  const insertPayload: Record<string, unknown> = {
    vendor_id: args.vendor.id,
    kind: "invoice",
    storage_path: path,
    original_filename: args.originalFilename,
    mime_type: "application/pdf",
    byte_size: args.byteSize,
    uploaded_by_vendor: true,
    invoice_number: args.invoiceNumber,
    invoice_description: args.invoiceDescription,
    invoice_amount_cents: args.invoiceAmountCents,
    invoice_due_at: args.invoiceDueAt,
    invoice_status: "submitted",
    generated_by_system: args.generatedBySystem,
    submitted_at: now,
  };
  if (args.formPayload) {
    insertPayload.invoice_form_payload = args.formPayload;
  }

  const { data: inserted, error: insertErr } = await (admin as any)
    .from("vendor_documents")
    .insert(insertPayload)
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error(
      "[vendors/invoices/submit] document insert failed",
      insertErr
    );
    // Best-effort cleanup so we don't leave an orphan PDF in storage.
    await (admin as any).storage.from(BUCKET).remove([path]);
    return NextResponse.json(
      { ok: false, error: "Invoice saved to storage but metadata write failed." },
      { status: 500 }
    );
  }

  // Fire-and-forget admin alert. Don't await — the vendor is already staring
  // at a spinner, and an email blip shouldn't make the submission look failed.
  // notifyAdminNewInvoice swallows its own errors into console.error.
  void notifyAdminNewInvoice({
    invoiceId: inserted.id,
    invoiceNumber: args.invoiceNumber,
    vendorLegalName: args.vendor.legal_name,
    amountCents: args.invoiceAmountCents,
    description: args.invoiceDescription,
    generatedBySystem: args.generatedBySystem,
  });

  return NextResponse.json({ ok: true, invoiceId: inserted.id });
}
