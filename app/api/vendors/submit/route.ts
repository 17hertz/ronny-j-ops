/**
 * POST /api/vendors/submit
 *
 * Public endpoint — no auth. Writes a new row to `public.vendors` via the
 * service-role client. Called from the intake form at /vendors/new.
 *
 * Responsibilities here (and ONLY here):
 *   - Server-side re-validation (never trust the client's zod pass)
 *   - Encrypt tax_id + ACH details with lib/crypto before the values touch
 *     the DB. Only last4s and non-sensitive fields are stored plaintext.
 *   - Generate a portal_token so the vendor can come back to upload a W9
 *     or fix a typo before we lock the record.
 *   - Fire off a confirmation email (best effort — don't fail the submit
 *     if Resend hiccups).
 *
 * Explicitly NOT doing here:
 *   - TIN Match against the IRS (that's an async Inngest job kicked by
 *     the admin "Start TIN match" button in the dashboard).
 *   - W9 upload (separate endpoint; the portal token unlocks it).
 *   - Notifying Jason/Ronny (belongs in an Inngest event handler so
 *     retries / batching are handled there).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptJson, encryptString, last4 } from "@/lib/crypto";
import type { ServiceCategoryId } from "@/lib/vendors/service-categories";
import { sendEmail } from "@/lib/notify/email";

export const runtime = "nodejs"; // crypto module needs Node runtime

const VENDOR_TYPES = [
  "individual",
  "sole_prop",
  "llc",
  "s_corp",
  "c_corp",
  "partnership",
  "other",
] as const;

const SERVICE_CATEGORIES_TUPLE = [
  "security",
  "photography",
  "video_equipment",
  "stream_engineer",
  "video_editor",
  "graphic_designer",
  "rentals",
  "cars",
  "yachts",
  "deposits",
  "sponsorship",
  "other",
] as const satisfies readonly ServiceCategoryId[];

const SECONDARY_METHODS = ["", "zelle", "paypal", "venmo", "other"] as const;

const payloadSchema = z.object({
  legal_name: z.string().trim().min(1).max(200),
  dba: z.string().trim().max(200).optional().default(""),
  vendor_type: z.enum(VENDOR_TYPES),
  contact_name: z.string().trim().max(200).optional().default(""),
  contact_email: z.string().trim().email(),
  contact_phone: z.string().trim().max(40).optional().default(""),
  address_line1: z.string().trim().max(200).optional().default(""),
  address_line2: z.string().trim().max(200).optional().default(""),
  city: z.string().trim().max(120).optional().default(""),
  state: z.string().trim().max(40).optional().default(""),
  postal_code: z.string().trim().max(20).optional().default(""),

  service_category: z.enum(SERVICE_CATEGORIES_TUPLE),
  service_notes: z.string().trim().max(2000).optional().default(""),

  tax_id: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length === 9, "Tax ID must be 9 digits."),

  ach_account_holder_name: z.string().trim().min(1).max(200),
  ach_bank_name: z.string().trim().max(200).optional().default(""),
  ach_routing_number: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length === 9, "Routing number must be 9 digits."),
  ach_account_number: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine(
      (v) => v.length >= 4 && v.length <= 17,
      "Account number must be 4–17 digits."
    ),
  ach_account_type: z.enum(["checking", "savings"]),

  secondary_payment_method: z.enum(SECONDARY_METHODS).optional().default(""),
  secondary_payment_handle: z.string().trim().max(200).optional().default(""),

  // Optional token from an admin-initiated invite (/dashboard/vendors/invite).
  // If present and valid we'll mark the invite claimed so the admin panel
  // flips from "outstanding" to "recently claimed".
  inviteToken: z.string().trim().max(200).nullable().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      fieldErrors[key] = issue.message;
    }
    return NextResponse.json(
      { ok: false, error: "Validation failed.", fieldErrors },
      { status: 400 }
    );
  }
  const d = parsed.data;

  // Encrypt sensitive values in the Node process — never pass cleartext
  // through to the DB in the INSERT statement.
  const taxIdEncrypted = encryptString(d.tax_id);
  const achBundleEncrypted = encryptJson({
    routing: d.ach_routing_number,
    account: d.ach_account_number,
    type: d.ach_account_type,
    holder: d.ach_account_holder_name,
    bank: d.ach_bank_name,
  });

  // One-time portal token so the vendor can upload their W9 / edit the
  // record before Jason or Ronny approves. 32 bytes of URL-safe entropy.
  const portalToken = randomBytes(32).toString("base64url");
  // Give them 30 days to finish.
  const portalExpiry = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const admin = createAdminClient();

  const insertRow = {
    legal_name: d.legal_name,
    dba: d.dba || null,
    vendor_type: d.vendor_type,
    contact_name: d.contact_name || null,
    contact_email: d.contact_email,
    contact_phone: d.contact_phone || null,
    address_line1: d.address_line1 || null,
    address_line2: d.address_line2 || null,
    city: d.city || null,
    state: d.state || null,
    postal_code: d.postal_code || null,
    country: "US",

    service_category: d.service_category,
    service_notes: d.service_notes || null,

    tax_id_last4: last4(d.tax_id),
    tax_id_encrypted: taxIdEncrypted,
    tin_match_status: "pending",

    ach_account_holder_name: d.ach_account_holder_name,
    ach_bank_name: d.ach_bank_name || null,
    ach_routing_last4: last4(d.ach_routing_number),
    ach_account_last4: last4(d.ach_account_number),
    ach_account_type: d.ach_account_type,
    ach_bank_details_encrypted: achBundleEncrypted,

    secondary_payment_method: d.secondary_payment_method || null,
    secondary_payment_handle: d.secondary_payment_handle || null,

    status: "submitted" as const,
    submitted_at: new Date().toISOString(),
    portal_token: portalToken,
    portal_token_expires_at: portalExpiry,
  };

  const { data: inserted, error: insertErr } = await (admin as any)
    .from("vendors")
    .insert(insertRow)
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("[vendors/submit] insert failed", insertErr);
    return NextResponse.json(
      { ok: false, error: "Could not save your submission. Please try again." },
      { status: 500 }
    );
  }

  // If this submission came from an admin invite link, mark the invite
  // claimed so /dashboard/vendors/invite can flip it from "outstanding" to
  // "recently claimed" with a jump-to-review button.
  //
  // This is best-effort: a typo'd / expired / already-claimed token
  // shouldn't block the vendor from submitting. We also check email-matches
  // to stop a leaked token from being used to claim for someone else —
  // if the emails don't line up we just don't claim (the row still exists
  // and Jason can match it manually).
  if (d.inviteToken) {
    const { data: inviteRow } = (await (admin as any)
      .from("vendor_invites")
      .select("id, email, claimed_at, expires_at")
      .eq("token", d.inviteToken)
      .maybeSingle()) as {
      data: {
        id: string;
        email: string;
        claimed_at: string | null;
        expires_at: string;
      } | null;
    };

    if (inviteRow && !inviteRow.claimed_at) {
      const notExpired =
        new Date(inviteRow.expires_at).getTime() > Date.now();
      const emailMatches =
        inviteRow.email.toLowerCase() === d.contact_email.toLowerCase();
      if (notExpired && emailMatches) {
        const { error: claimErr } = await (admin as any)
          .from("vendor_invites")
          .update({
            claimed_at: new Date().toISOString(),
            claimed_vendor_id: inserted.id,
          })
          .eq("id", inviteRow.id);
        if (claimErr) {
          console.error(
            "[vendors/submit] invite claim update failed",
            claimErr
          );
        }
      } else {
        console.warn("[vendors/submit] invite token present but not claimed", {
          notExpired,
          emailMatches,
        });
      }
    }
  }

  // Fire off a confirmation email with the portal link. Don't fail the
  // whole request if Resend is down — the row is already persisted and
  // an admin can resend from the dashboard.
  // IMPORTANT: `sendEmail` returns {ok, error} rather than throwing. The
  // earlier try/catch here was silently swallowing Resend failures (empty
  // Resend log + no terminal output) — inspect the return value instead.
  const portalUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/vendors/portal/${portalToken}`;
  try {
    console.info(
      "[vendors/submit] sending confirmation email",
      {
        to: d.contact_email,
        from: `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`,
      }
    );
    const emailResult = await sendEmail({
      to: d.contact_email,
      subject: "We got your info — 17 Hertz vendor onboarding",
      html: confirmationEmailHtml({
        legalName: d.legal_name,
        portalUrl,
      }),
      text: confirmationEmailText({
        legalName: d.legal_name,
        portalUrl,
      }),
    });
    if (!emailResult.ok) {
      console.error(
        "[vendors/submit] confirmation email failed:",
        emailResult.error
      );
    } else {
      console.info(
        "[vendors/submit] confirmation email sent",
        emailResult.providerMessageId
      );
    }
  } catch (err) {
    console.error("[vendors/submit] confirmation email threw", err);
  }

  return NextResponse.json({ ok: true, vendorId: inserted.id });
}

// ---------- email copy ----------
// Kept inline here because it's tightly coupled to this one endpoint.
// If we add another "you just submitted X" email we'll graduate these
// into lib/notify/templates.ts.

function confirmationEmailText(opts: { legalName: string; portalUrl: string }) {
  return [
    `Hey ${opts.legalName},`,
    "",
    "Thanks for filling out the 17 Hertz Inc. vendor intake form. We've got your tax and bank info securely on file.",
    "",
    "Next step: upload your signed W9 PDF. Use this link (valid for 30 days):",
    opts.portalUrl,
    "",
    "Questions? Reply to this email.",
    "",
    "— 17 Hertz Inc.",
  ].join("\n");
}

function confirmationEmailHtml(opts: { legalName: string; portalUrl: string }) {
  return `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin:0">17 Hertz Inc.</p>
  <h1 style="margin:12px 0 0 0;font-size:24px">Vendor intake received</h1>
  <p>Hey ${escape(opts.legalName)},</p>
  <p>Thanks for filling out the 17 Hertz Inc. vendor intake form. We&rsquo;ve got your tax and bank info securely on file.</p>
  <p><strong>Next step:</strong> upload your signed W9 PDF. Use this link (valid for 30 days):</p>
  <p><a href="${opts.portalUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Upload W9</a></p>
  <p style="font-size:12px;color:#666">Questions? Just reply to this email.</p>
</body></html>`.trim();
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
      ? "&lt;"
      : c === ">"
      ? "&gt;"
      : c === '"'
      ? "&quot;"
      : "&#39;"
  );
}
