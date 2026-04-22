/**
 * POST /api/admin/vendors/invite
 *
 * Creates a vendor_invites row, sends the prospective vendor a friendly
 * email with a tokenized link to the intake form, and returns the
 * invite record so the caller can show "sent ✓" feedback.
 *
 * Auth: must be a team_members row (same pattern as approve/reject).
 *
 * Body:
 *   { email: string, personalNote?: string }
 *
 * Idempotency / reinvites:
 *   - If there's already an UNCLAIMED invite for this email, we rotate
 *     the token (fresh email), extend expiry, and resend. This handles
 *     "the vendor never got the first email" without creating dupes.
 *   - If there's a CLAIMED invite (they already submitted), we still
 *     let the admin send another — sometimes we need them to resubmit
 *     with corrected info. New row.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/notify/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().trim().email().toLowerCase(),
  personalNote: z.string().trim().max(500).optional().default(""),
});

export async function POST(req: Request) {
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
    const first = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: first?.message ?? "Validation failed.",
      },
      { status: 400 }
    );
  }

  const { email, personalNote } = parsed.data;

  const admin = createAdminClient();

  // Check for an existing unclaimed invite so we don't spam duplicates.
  const { data: existing } = (await (admin as any)
    .from("vendor_invites")
    .select("id")
    .eq("email", email)
    .is("claimed_at", null)
    .maybeSingle()) as { data: { id: string } | null };

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  let inviteId: string;

  if (existing) {
    const { data: updated, error: updateErr } = await (admin as any)
      .from("vendor_invites")
      .update({
        token,
        personal_note: personalNote || null,
        invited_by: teamMember.id,
        sent_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .eq("id", existing.id)
      .select("id")
      .single();
    if (updateErr || !updated) {
      console.error("[admin/vendors/invite] update failed", updateErr);
      return NextResponse.json(
        { ok: false, error: "Could not refresh invite." },
        { status: 500 }
      );
    }
    inviteId = updated.id;
  } else {
    const { data: inserted, error: insertErr } = await (admin as any)
      .from("vendor_invites")
      .insert({
        token,
        email,
        personal_note: personalNote || null,
        invited_by: teamMember.id,
        expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      console.error("[admin/vendors/invite] insert failed", insertErr);
      return NextResponse.json(
        { ok: false, error: "Could not create invite." },
        { status: 500 }
      );
    }
    inviteId = inserted.id;
  }

  const intakeUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/vendors/new?invite=${token}`;

  const emailResult = await sendEmail({
    to: email,
    subject: "17 Hertz wants to add you as a vendor — quick intake inside",
    html: inviteHtml({
      personalNote,
      intakeUrl,
      inviterName: teamMember.full_name,
    }),
    text: inviteText({
      personalNote,
      intakeUrl,
      inviterName: teamMember.full_name,
    }),
  });

  if (!emailResult.ok) {
    console.error(
      "[admin/vendors/invite] email send failed",
      emailResult.error
    );
    // Soft-fail: the row is saved, admin can resend. Surface the error so
    // the UI can show "invite saved but email didn't send".
    return NextResponse.json(
      {
        ok: true,
        inviteId,
        emailWarning: emailResult.error,
      },
      { status: 200 }
    );
  }

  return NextResponse.json({
    ok: true,
    inviteId,
    messageId: emailResult.providerMessageId,
  });
}

// ---------- email copy ----------
// Warm + short. Music/entertainment vendors tune out of long emails.
//
// DEFAULT_GREETING is the fallback opener used when the admin doesn't type
// a personal note. Written to read like something a larger label's
// business-affairs team would send — professional, clear about the "why",
// and subtly signals this is worth filling out because more work is coming.
export const DEFAULT_GREETING =
  "Thanks for working with Ronny J. 17 Hertz Inc. manages vendor onboarding and payments on Ronny's behalf — we'd like to get your info on file so we can pay you promptly on this and any future projects.";

function inviteText(opts: {
  personalNote: string;
  intakeUrl: string;
  inviterName: string;
}): string {
  return [
    "Hey —",
    "",
    opts.personalNote || DEFAULT_GREETING,
    "",
    "Please fill out this short intake form so we can issue payment. Takes ~3 minutes — you'll need your W9 info (EIN or SSN) and the bank account you want paid into.",
    "",
    opts.intakeUrl,
    "",
    "The link above is personal to you — don't share it. It expires in 30 days.",
    "",
    "Questions? Just reply.",
    "",
    `— ${opts.inviterName}, 17 Hertz Inc.`,
  ].join("\n");
}

function inviteHtml(opts: {
  personalNote: string;
  intakeUrl: string;
  inviterName: string;
}): string {
  const greeting = opts.personalNote
    ? `<p>${escapeHtml(opts.personalNote)}</p>`
    : `<p>${escapeHtml(DEFAULT_GREETING)}</p>`;
  return `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin:0">17 Hertz Inc.</p>
  <h1 style="margin:12px 0 0 0;font-size:22px">You've been invited.</h1>
  <p>Hey —</p>
  ${greeting}
  <p>Please fill out this short intake form so we can issue payment. Takes ~3 minutes — you'll need your W9 info (EIN or SSN) and the bank account you want paid into.</p>
  <p style="margin:24px 0"><a href="${opts.intakeUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:500">Start intake form</a></p>
  <p style="font-size:13px;color:#666">The link above is personal to you — please don't share it. It expires in 30 days.</p>
  <p style="font-size:12px;color:#666">Questions? Just reply to this email.</p>
  <p style="font-size:12px;color:#888;margin-top:24px">— ${escapeHtml(opts.inviterName)}, 17 Hertz Inc.</p>
</body></html>`.trim();
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
