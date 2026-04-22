/**
 * POST /api/vendors/[id]/approve
 *
 * Mark a vendor as `approved` — they become eligible for payout. Called
 * from the ReviewActions client component on the vendor detail page.
 *
 * Auth:
 *   - Supabase session → team_members row. No team membership → 403.
 *   - Any team member can approve. If we ever want an "only admins" rule
 *     we'd check `teamMember.role` here.
 *
 * Body (JSON):
 *   { notes?: string }     // optional internal note, saved to vendors.notes
 *
 * Notes:
 *   - Uses the service-role client for the UPDATE so RLS doesn't bite when
 *     we later tighten policies on vendors.* — ownership is enforced above
 *     via the team_members check.
 *   - `reviewed_by` is the *team_members.id*, not the auth user id. Matches
 *     the FK in the schema and keeps the audit trail scoped to people,
 *     not raw auth accounts.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inviteApprovedVendor } from "@/lib/vendors/invite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };

  if (!teamMember) {
    return NextResponse.json(
      { ok: false, error: "You're not on the team." },
      { status: 403 }
    );
  }

  let body: { notes?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — notes is optional on approval.
  }
  const notes =
    typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";

  const admin = createAdminClient();

  // Fetch the vendor so we have the email + legal name to send the invite.
  // Doing this here (not trusting the client) so the invite can't be
  // redirected to a different address by a tampered request.
  const { data: vendor, error: fetchErr } = (await (admin as any)
    .from("vendors")
    .select("id, legal_name, contact_email, auth_user_id, status")
    .eq("id", params.id)
    .maybeSingle()) as {
    data: {
      id: string;
      legal_name: string;
      contact_email: string;
      auth_user_id: string | null;
      status: string;
    } | null;
    error: { message: string } | null;
  };

  if (fetchErr || !vendor) {
    return NextResponse.json(
      { ok: false, error: fetchErr?.message ?? "Vendor not found." },
      { status: 404 }
    );
  }

  const { error: updateErr } = await (admin as any)
    .from("vendors")
    .update({
      status: "approved",
      reviewed_by: teamMember.id,
      reviewed_at: new Date().toISOString(),
      notes: notes || null,
    })
    .eq("id", params.id);

  if (updateErr) {
    console.error("[vendors/approve] update failed", updateErr);
    return NextResponse.json(
      { ok: false, error: "Could not save approval. Please try again." },
      { status: 500 }
    );
  }

  // Send the invite email with a magic-link sign-in and an explanation of
  // the three login options (Google / magic link / password). This is
  // deliberately AFTER the status update — if the email or user creation
  // fails, the approval is still recorded and an admin can re-trigger the
  // invite later from a future "resend invite" button.
  //
  // We skip re-inviting if the vendor is already linked (e.g. an admin
  // rejected and re-approved them). That keeps us from spamming a second
  // "welcome aboard" email when nothing changed auth-wise.
  let inviteNote: string | undefined;
  if (!vendor.auth_user_id) {
    const invite = await inviteApprovedVendor({
      vendorId: vendor.id,
      email: vendor.contact_email,
      legalName: vendor.legal_name,
    });
    if (!invite.ok) {
      console.error("[vendors/approve] invite failed", invite.error);
      inviteNote = invite.error;
      // Don't fail the request — admin can resend later.
    }
  }

  return NextResponse.json({ ok: true, inviteWarning: inviteNote });
}
