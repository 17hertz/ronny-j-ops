/**
 * Vendor auth onboarding helper.
 *
 * Called from the approve route (and potentially a "resend invite" admin
 * button later). Responsibilities:
 *
 *   1. Ensure a Supabase auth user exists for the vendor's email. If the
 *      user already exists (e.g. Jason approved his own test vendor using
 *      his team email, or a vendor is approved a second time), we just
 *      reuse it instead of erroring.
 *
 *   2. Link vendors.auth_user_id → auth.users.id so RLS policies can
 *      match rows to the signed-in user.
 *
 *   3. Generate a magic-link sign-in URL pointed at /api/auth/callback
 *      so the session cookie gets set on first click.
 *
 *   4. Send the vendor an email (via Resend — keeps all ops email in one
 *      place) with two ways to get in: the magic link, and instructions
 *      for setting a password via the account page.
 *
 * The caller (approve route) should treat invite failure as non-fatal:
 * the vendor row is already marked approved, and an admin can re-trigger
 * the invite later.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/notify/email";

type InviteResult =
  | { ok: true; authUserId: string; magicLink: string }
  | { ok: false; error: string };

export async function inviteApprovedVendor(opts: {
  vendorId: string;
  email: string;
  legalName: string;
}): Promise<InviteResult> {
  const admin = createAdminClient();

  // 1. Resolve-or-create the auth user ------------------------------------
  // listUsers paginates; 100 per page is fine here — we expect <<100 users
  // matching any email (actually zero or one).
  let authUserId: string | null = null;
  try {
    const { data: existing } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    const match = existing?.users?.find(
      (u) => u.email?.toLowerCase() === opts.email.toLowerCase()
    );
    if (match) authUserId = match.id;
  } catch (err) {
    console.warn("[vendors/invite] listUsers failed, will try create", err);
  }

  if (!authUserId) {
    const { data: created, error: createErr } =
      await admin.auth.admin.createUser({
        email: opts.email,
        email_confirm: true, // skip the "confirm your email" flow — the
        // magic link below doubles as proof of email access
        user_metadata: { role: "vendor", vendor_id: opts.vendorId },
      });
    if (createErr || !created?.user) {
      return {
        ok: false,
        error: createErr?.message ?? "could not create auth user",
      };
    }
    authUserId = created.user.id;
  }

  // 2. Link vendors row ---------------------------------------------------
  const { error: linkErr } = await (admin as any)
    .from("vendors")
    .update({ auth_user_id: authUserId })
    .eq("id", opts.vendorId);
  if (linkErr) {
    return { ok: false, error: `link failed: ${linkErr.message}` };
  }

  // 3. Generate magic link ------------------------------------------------
  const redirectTo = `${process.env.NEXT_PUBLIC_SITE_URL}/api/auth/callback?next=/vendors/account`;
  const { data: linkData, error: linkGenErr } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: opts.email,
      options: { redirectTo },
    });
  if (linkGenErr || !linkData?.properties?.action_link) {
    return {
      ok: false,
      error: linkGenErr?.message ?? "could not generate magic link",
    };
  }
  const magicLink = linkData.properties.action_link;

  // 4. Send the email -----------------------------------------------------
  const loginUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/vendors/login`;
  const result = await sendEmail({
    to: opts.email,
    subject: "You're approved — log into your 17 Hertz vendor account",
    html: approvedEmailHtml({
      legalName: opts.legalName,
      magicLink,
      loginUrl,
    }),
    text: approvedEmailText({
      legalName: opts.legalName,
      magicLink,
      loginUrl,
    }),
  });

  if (!result.ok) {
    console.error("[vendors/invite] email send failed", result.error);
    // Don't bail — the link still works, and an admin can resend.
  }

  return { ok: true, authUserId, magicLink };
}

function approvedEmailText(opts: {
  legalName: string;
  magicLink: string;
  loginUrl: string;
}): string {
  return [
    `Hey ${opts.legalName},`,
    "",
    "Good news — 17 Hertz Inc. has approved your vendor application. You're now set up to submit invoices and get paid.",
    "",
    "One-click sign-in (no password needed):",
    opts.magicLink,
    "",
    `If that link expires, you can always log in here: ${opts.loginUrl}`,
    "— we'll email you a fresh link, or you can set a password from your account page after you sign in.",
    "",
    "What's next: open the account page and hit 'Submit invoice' whenever you've done work for us. You can upload your own invoice PDF, or fill out a short form and we'll generate one for you.",
    "",
    "Questions? Reply to this email.",
    "",
    "— 17 Hertz Inc.",
  ].join("\n");
}

function approvedEmailHtml(opts: {
  legalName: string;
  magicLink: string;
  loginUrl: string;
}): string {
  const escaped = escapeHtml(opts.legalName);
  return `
<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin:0">17 Hertz Inc.</p>
  <h1 style="margin:12px 0 0 0;font-size:24px">You're approved.</h1>
  <p>Hey ${escaped},</p>
  <p>17 Hertz Inc. has approved your vendor application. You can now submit invoices and get paid through our vendor portal.</p>
  <p style="margin:24px 0"><a href="${opts.magicLink}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:500">Sign in to your account</a></p>
  <p style="font-size:13px;color:#555">The link above signs you in with one click — no password needed. If it expires, head to <a href="${opts.loginUrl}" style="color:#111">${opts.loginUrl}</a> and we'll email you a fresh one. You can also set a password from your account page once you're in.</p>
  <p><strong>What's next:</strong> Once you're signed in, hit <em>Submit invoice</em> whenever you've done work. You can upload your own invoice PDF, or fill out a short form and we'll generate one for you.</p>
  <p style="font-size:12px;color:#666">Questions? Just reply to this email.</p>
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
