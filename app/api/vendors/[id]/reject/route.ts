/**
 * POST /api/vendors/[id]/reject
 *
 * Mark a vendor as `rejected` — they're flagged so nobody on the team
 * accidentally pays them. Called from the ReviewActions client component
 * on the vendor detail page.
 *
 * Auth: same as /approve — must be a team_members row for the signed-in user.
 *
 * Body (JSON):
 *   { notes: string }     // REQUIRED — "why we said no" is the whole point
 *                         // of a reject audit trail. Min 1 char, max 4000.
 *
 * Why require notes here but not on /approve:
 *   - Approvals are common and usually self-explanatory ("looks fine, W9 in
 *     order, moving on"). Notes are optional.
 *   - Rejections are the thing the next person will have to re-review or
 *     argue with the vendor about. A blank reject is a landmine.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const notes =
    typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
  if (!notes) {
    return NextResponse.json(
      {
        ok: false,
        error: "Leave a note explaining why you're rejecting this vendor.",
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { error: updateErr } = await (admin as any)
    .from("vendors")
    .update({
      status: "rejected",
      reviewed_by: teamMember.id,
      reviewed_at: new Date().toISOString(),
      notes,
    })
    .eq("id", params.id);

  if (updateErr) {
    console.error("[vendors/reject] update failed", updateErr);
    return NextResponse.json(
      { ok: false, error: "Could not save rejection. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
