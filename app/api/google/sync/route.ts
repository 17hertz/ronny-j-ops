import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncAccountsForMember } from "@/lib/google/sync";

export const dynamic = "force-dynamic";
// Google sync can take a few seconds (token refresh + events.list).
// Give Vercel's default 10s a bit more headroom.
export const maxDuration = 60;

/**
 * POST /api/google/sync
 *
 * Syncs every Google Calendar account connected to the *currently logged-in*
 * team member. Returns a JSON summary the dashboard can toast.
 *
 * Auth model: relies on the Supabase session cookie. Not reachable
 * unauthenticated. The Inngest cron (coming later) will use a separate
 * path with a signing-header check.
 */
export async function POST() {
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { data: member } = (await sb
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };

  if (!member) {
    return NextResponse.json({ error: "not_team_member" }, { status: 403 });
  }

  try {
    const results = await syncAccountsForMember(member.id);
    return NextResponse.json({ ok: true, results });
  } catch (err: any) {
    console.error("[google/sync] failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "sync failed" },
      { status: 500 }
    );
  }
}
