/**
 * Invoice event emails.
 *
 * Four transactional templates:
 *   1. notifyAdminNewInvoice       — admin inbox on vendor submission
 *   2. notifyVendorInvoiceApproved — vendor on approve
 *   3. notifyVendorInvoiceRejected — vendor on reject (includes review note)
 *   4. notifyVendorInvoicePaid     — vendor on mark_paid
 *
 * Design choices:
 *   - All failures are caught and logged. Never let a stuck email block the
 *     actual state transition (invoice already saved, status already flipped).
 *   - Admin destination comes from ADMIN_NOTIFY_EMAIL (comma-separated list
 *     OK). If unset, admin notifications are no-ops — useful in local dev.
 *   - Plain HTML + plaintext twin. Same minimalist style as the approval
 *     email so the vendor sees a consistent "from 17 Hertz" voice.
 *   - No links to PDFs in any email. Reasons:
 *       · Signed URLs expire.
 *       · We don't want invoice PDFs hitting spam filters / forwarded outside
 *         the vendor portal.
 *     Instead, we point them at /vendors/account where they can sign in and
 *     click through to the PDF themselves.
 */
import { sendEmail } from "@/lib/notify/email";

const LOGIN_URL =
  `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://ops.17hertz.io"}/vendors/account`;
const ADMIN_DASH_URL =
  `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://ops.17hertz.io"}/dashboard`;

// ---------- Admin: new invoice submitted -------------------------------

export async function notifyAdminNewInvoice(opts: {
  invoiceId: string;
  invoiceNumber: string;
  vendorLegalName: string;
  amountCents: number;
  description: string;
  generatedBySystem: boolean;
}): Promise<void> {
  const recipients = parseAdminRecipients();
  if (recipients.length === 0) {
    console.info(
      "[invoices/notify] ADMIN_NOTIFY_EMAIL unset — skipping admin alert"
    );
    return;
  }

  const amount = formatMoney(opts.amountCents);
  const subject = `New invoice from ${opts.vendorLegalName} — ${amount}`;
  const reviewUrl = `${ADMIN_DASH_URL}/invoices/${opts.invoiceId}`;

  const text = [
    `${opts.vendorLegalName} just submitted an invoice.`,
    "",
    `Invoice: ${opts.invoiceNumber}`,
    `Amount:  ${amount}`,
    `Note:    ${opts.description}`,
    `Source:  ${opts.generatedBySystem ? "generated via portal form" : "vendor-uploaded PDF"}`,
    "",
    `Review it: ${reviewUrl}`,
    "",
    "— Ronny J Ops",
  ].join("\n");

  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin:0">Ronny J Ops · New invoice</p>
  <h1 style="margin:12px 0 0 0;font-size:22px">${escapeHtml(opts.vendorLegalName)} submitted an invoice.</h1>
  <table style="margin-top:16px;font-size:14px;color:#333;border-collapse:collapse">
    <tr><td style="padding:4px 16px 4px 0;color:#888">Invoice</td><td>${escapeHtml(opts.invoiceNumber)}</td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#888">Amount</td><td><strong>${amount}</strong></td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#888;vertical-align:top">Note</td><td>${escapeHtml(opts.description)}</td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#888">Source</td><td>${opts.generatedBySystem ? "Generated via portal form" : "Vendor-uploaded PDF"}</td></tr>
  </table>
  <p style="margin:24px 0"><a href="${reviewUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:500">Review invoice</a></p>
  <p style="font-size:12px;color:#666">Sent automatically by Ronny J Ops.</p>
</body></html>`.trim();

  await sendToMany(recipients, { subject, html, text });
}

// ---------- Vendor: approved -------------------------------------------

export async function notifyVendorInvoiceApproved(opts: {
  vendorEmail: string;
  vendorLegalName: string;
  invoiceNumber: string;
  amountCents: number;
  achLast4: string | null;
}): Promise<void> {
  const amount = formatMoney(opts.amountCents);
  const payoutLine = opts.achLast4
    ? `We'll remit ${amount} via ACH to ···${opts.achLast4}. You'll get another email from us when it goes out.`
    : `We'll be in touch about payout details for ${amount}.`;

  const subject = `Invoice ${opts.invoiceNumber} approved — ${amount}`;

  const text = [
    `Hey ${opts.vendorLegalName},`,
    "",
    `Your invoice ${opts.invoiceNumber} (${amount}) has been approved.`,
    "",
    payoutLine,
    "",
    `See status anytime: ${LOGIN_URL}`,
    "",
    "— 17 Hertz Inc.",
  ].join("\n");

  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin:0">17 Hertz Inc.</p>
  <h1 style="margin:12px 0 0 0;font-size:22px">Invoice approved.</h1>
  <p>Hey ${escapeHtml(opts.vendorLegalName)},</p>
  <p>Your invoice <strong>${escapeHtml(opts.invoiceNumber)}</strong> for <strong>${amount}</strong> has been approved.</p>
  <p>${escapeHtml(payoutLine)}</p>
  <p style="margin:24px 0"><a href="${LOGIN_URL}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:500">View in your vendor portal</a></p>
  <p style="font-size:12px;color:#666">Questions? Just reply to this email.</p>
</body></html>`.trim();

  await safeSend(opts.vendorEmail, { subject, html, text });
}

// ---------- Vendor: rejected -------------------------------------------

export async function notifyVendorInvoiceRejected(opts: {
  vendorEmail: string;
  vendorLegalName: string;
  invoiceNumber: string;
  amountCents: number;
  reviewNotes: string;
}): Promise<void> {
  const amount = formatMoney(opts.amountCents);
  const subject = `Action needed: invoice ${opts.invoiceNumber}`;

  const text = [
    `Hey ${opts.vendorLegalName},`,
    "",
    `We weren't able to approve invoice ${opts.invoiceNumber} (${amount}) as submitted. Here's why:`,
    "",
    opts.reviewNotes,
    "",
    `You can submit a corrected invoice from the vendor portal: ${LOGIN_URL}`,
    "",
    "If any of this is unclear, reply to this email and we'll sort it out.",
    "",
    "— 17 Hertz Inc.",
  ].join("\n");

  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin:0">17 Hertz Inc.</p>
  <h1 style="margin:12px 0 0 0;font-size:22px">We couldn't approve this invoice yet.</h1>
  <p>Hey ${escapeHtml(opts.vendorLegalName)},</p>
  <p>Invoice <strong>${escapeHtml(opts.invoiceNumber)}</strong> (${amount}) needs a second look before we can pay it.</p>
  <div style="margin:16px 0;padding:16px;border-left:3px solid #d4844d;background:#faf5f0;color:#333;font-size:14px">
    ${escapeHtml(opts.reviewNotes).replace(/\n/g, "<br />")}
  </div>
  <p>You can submit a corrected invoice from your portal.</p>
  <p style="margin:24px 0"><a href="${LOGIN_URL}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:500">Go to vendor portal</a></p>
  <p style="font-size:12px;color:#666">Questions or disagree? Just reply to this email.</p>
</body></html>`.trim();

  await safeSend(opts.vendorEmail, { subject, html, text });
}

// ---------- Vendor: paid -----------------------------------------------

export async function notifyVendorInvoicePaid(opts: {
  vendorEmail: string;
  vendorLegalName: string;
  invoiceNumber: string;
  amountCents: number;
  achLast4: string | null;
}): Promise<void> {
  const amount = formatMoney(opts.amountCents);
  const where = opts.achLast4
    ? `ACH ···${opts.achLast4}`
    : "the payment method we have on file";

  const subject = `Payment sent — invoice ${opts.invoiceNumber}`;

  const text = [
    `Hey ${opts.vendorLegalName},`,
    "",
    `We've sent payment of ${amount} for invoice ${opts.invoiceNumber} to ${where}.`,
    "",
    "ACH usually lands in 1–3 business days. If it's not there by end of next business day, reply to this email and we'll check on it.",
    "",
    `See all your invoices: ${LOGIN_URL}`,
    "",
    "Thanks for working with us.",
    "",
    "— 17 Hertz Inc.",
  ].join("\n");

  const html = `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin:0">17 Hertz Inc.</p>
  <h1 style="margin:12px 0 0 0;font-size:22px">Payment sent.</h1>
  <p>Hey ${escapeHtml(opts.vendorLegalName)},</p>
  <p>We've sent <strong>${amount}</strong> for invoice <strong>${escapeHtml(opts.invoiceNumber)}</strong> to ${escapeHtml(where)}.</p>
  <p style="font-size:13px;color:#555">ACH usually lands in 1–3 business days. If it hasn't arrived by end of next business day, reply and we'll check on it.</p>
  <p style="margin:24px 0"><a href="${LOGIN_URL}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:500">View in your vendor portal</a></p>
  <p>Thanks for working with us.</p>
</body></html>`.trim();

  await safeSend(opts.vendorEmail, { subject, html, text });
}

// ---------- Helpers -----------------------------------------------------

function parseAdminRecipients(): string[] {
  const raw = process.env.ADMIN_NOTIFY_EMAIL;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes("@"));
}

async function safeSend(
  to: string,
  payload: { subject: string; html: string; text: string }
): Promise<void> {
  try {
    const result = await sendEmail({ to, ...payload });
    if (!result.ok) {
      console.error("[invoices/notify] send failed", { to, error: result.error });
    }
  } catch (err) {
    console.error("[invoices/notify] send threw", { to, err });
  }
}

async function sendToMany(
  recipients: string[],
  payload: { subject: string; html: string; text: string }
): Promise<void> {
  await Promise.all(recipients.map((r) => safeSend(r, payload)));
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function escapeHtml(s: string): string {
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
