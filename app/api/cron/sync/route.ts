import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncAccountsForMember } from "@/lib/google/sync";

export const dynamic = "force-dynamic";
// Cron can touch N accounts × (calendar + tasks APIs). 60s is plenty for
// single-digit accounts; we'll revisit if we ever onboard dozens.
export const maxDuration = 60;

/**
 * GET /api/cron/sync
 *
 * Invoked by Vercel Cron on a schedule (see vercel.json). Syncs every
 * team_member that has at least one connected Google account. Returns a
 * per-member summary for log inspection.
 *
 * Auth model:
 *   Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. We compare
 *   against the env var and 401 anything else — this endpoint must not
 *   be open to the internet because it triggers outbound API calls that
 *   cost money (Google read quota, eventually Twilio).
 *
 * This handler shells out to the same `syncAccountsForMember` the
 * user-triggered endpoint uses — so manual and scheduled syncs are
 * guaranteed to stay in sync logically. Per-member failures are captured
 * but don't halt the cron; a single bad refresh token shouldn't block
 * everyone else's sync.
 */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // If the secret isn't configured, refuse to run rather than silently
    // no-op. A misconfigured cron is a security issue.
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: accounts, error } = (await (admin as any)
    .from("google_calendar_accounts")
    .select("team_member_id")) as {
    data: Array<{ team_member_id: string }> | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[cron/sync] list accounts failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Dedupe — one team member can have multiple connected Google accounts;
  // syncAccountsForMember already iterates through all of theirs.
  const memberIds = Array.from(
    new Set((accounts ?? []).map((a) => a.team_member_id))
  );

  const summaries: Array<
    | { team_member_id: string; ok: true; results: unknown }
    | { team_member_id: string; ok: false; error: string }
  > = [];

  for (const memberId of memberIds) {
    try {
      const results = await syncAccountsForMember(memberId);
      summaries.push({ team_member_id: memberId, ok: true, results });
    } catch (err: any) {
      console.error("[cron/sync] member failed", memberId, err);
      summaries.push({
        team_member_id: memberId,
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, members: summaries.length, summaries });
}
