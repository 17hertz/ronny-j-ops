/**
 * POST /api/admin/invoices/[id]/action
 *
 * Team-member action endpoint for the invoice review flow. One of:
 *   - approve       → invoice_status=approved, reviewed_by/at filled
 *   - reject        → invoice_status=rejected, review_notes required
 *   - under_review  → invoice_status=under_review (keeps on pending list)
 *   - mark_paid     → invoice_status=paid, paid_at=now (only from approved)
 *
 * Auth: must be signed in + have a team_members row. Not scoped by role;
 * any team member can take any action today. Role-based restrictions are
 * a future tightening.
 *
 * Body: { action, review_notes? }
 *
 * The write uses createAdminClient() because we want to bypass RLS for the
 * invoice status update (RLS on vendor_documents is currently vendor-scoped
 * for self-inserts; admin writes need service role).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  notifyVendorInvoiceApproved,
  notifyVendorInvoiceRejected,
  notifyVendorInvoicePaid,
} from "@/lib/invoices/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["approve", "reject", "under_review", "mark_paid"]),
  review_notes: z.string().trim().max(1000).optional(),
});

// We pull everything we need to email the vendor in one shot at the top of
// the handler, so the update + notify flow can use the same snapshot.
type InvoiceRow = {
  id: string;
  invoice_status: string | null;
  kind: string;
  invoice_number: string | null;
  invoice_amount_cents: number | null;
  vendor_id: string;
};

type VendorContact = {
  legal_name: string;
  contact_email: string;
  ach_account_last4: string | null;
};

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
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

  const { data: teamMember } = (await sb
    .from("team_members")
    .select("id, full_name")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string; full_name: string } | null };

  if (!teamMember) {
    return NextResponse.json(
      { ok: false, error: "You're not on the team." },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Validation failed.",
      },
      { status: 400 }
    );
  }

  const { action, review_notes } = parsed.data;

  if (action === "reject" && (!review_notes || review_notes.length === 0)) {
    return NextResponse.json(
      { ok: false, error: "Rejections require a review note." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: invoice } = (await (admin as any)
    .from("vendor_documents")
    .select(
      "id, invoice_status, kind, invoice_number, invoice_amount_cents, vendor_id"
    )
    .eq("id", params.id)
    .maybeSingle()) as { data: InvoiceRow | null };

  if (!invoice || invoice.kind !== "invoice") {
    return NextResponse.json(
      { ok: false, error: "Invoice not found." },
      { status: 404 }
    );
  }

  const { data: vendorContact } = (await (admin as any)
    .from("vendors")
    .select("legal_name, contact_email, ach_account_last4")
    .eq("id", invoice.vendor_id)
    .maybeSingle()) as { data: VendorContact | null };

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {};

  switch (action) {
    case "approve": {
      update.invoice_status = "approved";
      update.reviewed_by = teamMember.id;
      update.reviewed_at = now;
      if (review_notes) update.review_notes = review_notes;
      break;
    }
    case "reject": {
      update.invoice_status = "rejected";
      update.reviewed_by = teamMember.id;
      update.reviewed_at = now;
      update.review_notes = review_notes ?? null;
      break;
    }
    case "under_review": {
      update.invoice_status = "under_review";
      update.reviewed_by = teamMember.id;
      update.reviewed_at = now;
      break;
    }
    case "mark_paid": {
      if (invoice.invoice_status !== "approved") {
        return NextResponse.json(
          {
            ok: false,
            error: "Only approved invoices can be marked paid.",
          },
          { status: 400 }
        );
      }
      update.invoice_status = "paid";
      update.paid_at = now;
      break;
    }
  }

  const { error: updateErr } = await (admin as any)
    .from("vendor_documents")
    .update(update)
    .eq("id", params.id);

  if (updateErr) {
    console.error("[admin/invoices/action] update failed", updateErr);
    return NextResponse.json(
      { ok: false, error: "Could not update invoice." },
      { status: 500 }
    );
  }

  // ----- Notify the vendor (fire-and-forget) ------------------------------
  // Never block the 200 on email. All notify helpers swallow their own errors.
  // "under_review" deliberately sends nothing — it's a private staging state.
  if (vendorContact && invoice.invoice_number && invoice.invoice_amount_cents != null) {
    const base = {
      vendorEmail: vendorContact.contact_email,
      vendorLegalName: vendorContact.legal_name,
      invoiceNumber: invoice.invoice_number,
      amountCents: invoice.invoice_amount_cents,
    };
    switch (action) {
      case "approve":
        void notifyVendorInvoiceApproved({
          ...base,
          achLast4: vendorContact.ach_account_last4,
        });
        break;
      case "reject":
        void notifyVendorInvoiceRejected({
          ...base,
          reviewNotes: review_notes ?? "No note provided.",
        });
        break;
      case "mark_paid":
        void notifyVendorInvoicePaid({
          ...base,
          achLast4: vendorContact.ach_account_last4,
        });
        break;
      // under_review: no notification by design
    }
  }

  return NextResponse.json({ ok: true });
}
