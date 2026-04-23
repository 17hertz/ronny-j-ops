/**
 * POST /api/admin/team/invite
 *
 * Invites a new teammate (admin-tier member). Uses Supabase Auth's native
 * inviteUserByEmail, which:
 *   1. creates an auth.users row for the email if none exists
 *   2. sends the branded "Invite user" email template (already themed
 *      "17 Hertz Inc / Ronny J" in Supabase dashboard)
 *   3. returns the created user so we can wire them to a team_members row
 *
 * After the auth user exists we insert a matching team_members row with
 * role='admin'. When they click the magic link in the email, they sign in
 * and the dashboard's team_members lookup finds them. All-or-nothing access
 * — they see everything a current admin sees.
 *
 * Auth: caller must already be on team_members (same pattern as
 * /api/admin/vendors/invite).
 *
 * Body:
 *   { email: string, fullName?: string }
 *
 * Returns:
 *   200 { ok: true, teamMemberId }
 *   200 { ok: true, teamMemberId, emailWarning }  // row saved, email bounced
 *   4xx { ok: false, error }
 *
 * Idempotency:
 *   - If the email already has an auth user, we look up or create the
 *     team_members row keyed on that auth_user_id (don't insert dupes).
 *   - If team_members already exists for that user, we return ok:true so
 *     the UI says "sent" — safe because Supabase's inviteUserByEmail will
 *     still re-send the magic link.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().trim().email().toLowerCase(),
  fullName: z.string().trim().max(120).optional().default(""),
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

  // Only existing team members can invite more teammates.
  const { data: inviter } = (await sb
    .from("team_members")
    .select("id, full_name")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string; full_name: string } | null };

  if (!inviter) {
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
      { ok: false, error: first?.message ?? "Validation failed." },
      { status: 400 }
    );
  }

  const { email, fullName } = parsed.data;

  const admin = createAdminClient();

  // ── Step 1: get-or-create the auth user ──────────────────────────────
  //
  // inviteUserByEmail is the happy path: it creates the auth.users row
  // AND sends the email in one shot. But if the user already exists,
  // it errors ("User already registered"). In that case we fall back to
  // looking them up via listUsers and, if they're already a teammate,
  // just return ok (idempotent resend).
  let authUserId: string | null = null;
  let emailWarning: string | undefined;

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://ops.17hertz.io";

  const { data: invited, error: inviteErr } =
    await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${siteUrl}/dashboard`,
      data: fullName ? { full_name: fullName } : undefined,
    });

  if (inviteErr) {
    // User probably already exists. Look them up to continue.
    // (Supabase doesn't expose a getUserByEmail helper, so we page through
    // listUsers; fine for our scale — a handful of admins at most.)
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({
      perPage: 200,
    });
    if (listErr) {
      console.error("[admin/team/invite] listUsers failed", listErr);
      return NextResponse.json(
        { ok: false, error: "Could not invite. Please try again." },
        { status: 500 }
      );
    }
    const existing = list?.users?.find(
      (u) => u.email?.toLowerCase() === email
    );
    if (!existing) {
      // Neither invited nor found — genuine failure.
      console.error("[admin/team/invite] invite failed", inviteErr);
      return NextResponse.json(
        { ok: false, error: inviteErr.message ?? "Could not invite." },
        { status: 500 }
      );
    }
    // Safety gate: if the existing auth user is already a VENDOR, refuse.
    // Otherwise the insert below would silently promote a vendor to admin
    // and the next time they sign in they'd hit /dashboard instead of
    // their vendor portal — not what the admin typing this form thinks
    // they're doing. Force a conscious cleanup instead.
    const { data: vendorRow } = (await (admin as any)
      .from("vendors")
      .select("id")
      .eq("auth_user_id", existing.id)
      .maybeSingle()) as { data: { id: string } | null };
    if (vendorRow) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "That email already belongs to a vendor account. Use a different address for teammates.",
        },
        { status: 409 }
      );
    }

    authUserId = existing.id;
    emailWarning =
      "already registered — no new invite email sent. They can sign in at /login.";
  } else if (invited?.user) {
    authUserId = invited.user.id;
  }

  if (!authUserId) {
    return NextResponse.json(
      { ok: false, error: "Could not resolve invited user." },
      { status: 500 }
    );
  }

  // ── Step 2: upsert the team_members row ──────────────────────────────
  //
  // Check first to avoid a duplicate-key error if this is a re-invite or
  // the user was already on the team. Keep role='admin' always — Option A
  // is all-or-nothing.
  const { data: existingMember } = (await (admin as any)
    .from("team_members")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle()) as { data: { id: string } | null };

  let teamMemberId: string;

  if (existingMember) {
    teamMemberId = existingMember.id;
    // Optional: refresh their full_name if we got a new one.
    if (fullName) {
      await (admin as any)
        .from("team_members")
        .update({ full_name: fullName })
        .eq("id", existingMember.id);
    }
  } else {
    const insertPayload: Record<string, unknown> = {
      auth_user_id: authUserId,
      full_name: fullName || email.split("@")[0],
      role: "admin",
    };
    const { data: inserted, error: insertErr } = await (admin as any)
      .from("team_members")
      .insert(insertPayload)
      .select("id")
      .single();
    if (insertErr || !inserted) {
      console.error("[admin/team/invite] team_members insert failed", insertErr);
      return NextResponse.json(
        {
          ok: false,
          error:
            "Auth user created but couldn't add to team_members. Check schema.",
        },
        { status: 500 }
      );
    }
    teamMemberId = inserted.id;
  }

  return NextResponse.json({
    ok: true,
    teamMemberId,
    ...(emailWarning ? { emailWarning } : {}),
  });
}
