/**
 * Google Calendar sync orchestrator.
 *
 * Called by:
 *   - POST /api/google/sync   (user-triggered, scoped to one team_member)
 *   - Inngest cron            (once wired up; scoped to all accounts)
 *
 * Per-account flow:
 *   1. Refresh the access token if it's expired.
 *   2. Pull events with `listEvents` — incremental if we have a sync token,
 *      full otherwise. On 410 Gone, wipe the token and retry.
 *   3. For each event, either upsert the row (active) or delete it
 *      (status=cancelled).
 *   4. Save the new sync token back.
 *
 * We use the service-role client here because the `events` table has
 * per-team-member RLS but this function may be invoked out-of-band
 * (scheduled, not user-initiated). Identity is established by the caller.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshAccessToken } from "@/lib/google/oauth";
import {
  listEvents,
  toEventRow,
  SyncTokenInvalidError,
} from "@/lib/google/calendar";

// Google access tokens are valid for 1 hour; refresh early to avoid
// racing a token expiry mid-sync.
const REFRESH_BUFFER_SECONDS = 120;

// On first sync, how far back to pull. Anything older than this is
// probably not actionable for an ops dashboard.
const INITIAL_WINDOW_DAYS = 30;

export type SyncResult = {
  googleEmail: string;
  calendarId: string;
  upserted: number;
  deleted: number;
  fullResync: boolean;
};

export async function syncAccountsForMember(
  teamMemberId: string
): Promise<SyncResult[]> {
  const admin = createAdminClient();

  // Pull every Google account this team member has connected.
  const { data: accounts, error: acctsErr } = (await (admin as any)
    .from("google_calendar_accounts")
    .select(
      "id, google_email, access_token, refresh_token, token_expires_at, sync_token"
    )
    .eq("team_member_id", teamMemberId)) as {
    data:
      | Array<{
          id: string;
          google_email: string;
          access_token: string;
          refresh_token: string;
          token_expires_at: string;
          sync_token: string | null;
        }>
      | null;
    error: { message: string } | null;
  };

  if (acctsErr) throw new Error(`list accounts failed: ${acctsErr.message}`);
  if (!accounts || accounts.length === 0) return [];

  const results: SyncResult[] = [];
  for (const acct of accounts) {
    results.push(await syncOneAccount(admin, acct));
  }
  return results;
}

type AccountRow = {
  id: string;
  google_email: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  sync_token: string | null;
};

async function syncOneAccount(
  admin: ReturnType<typeof createAdminClient>,
  acct: AccountRow
): Promise<SyncResult> {
  // The Google "primary" calendar ID resolves to the user's main cal.
  // Later we can discover additional calendars via /users/me/calendarList.
  const calendarId = "primary";

  // Step 1: refresh token if needed.
  let accessToken = acct.access_token;
  const expiresAt = new Date(acct.token_expires_at).getTime();
  const now = Date.now();
  if (expiresAt - now < REFRESH_BUFFER_SECONDS * 1000) {
    const refreshed = await refreshAccessToken(acct.refresh_token);
    accessToken = refreshed.access_token;
    const newExpiresAt = new Date(
      Date.now() + refreshed.expires_in * 1000
    ).toISOString();
    await (admin as any)
      .from("google_calendar_accounts")
      .update({
        access_token: accessToken,
        token_expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", acct.id);
  }

  // Step 2: list events. Retry once with a full sync on 410 Gone.
  let listed;
  let fullResync = !acct.sync_token;
  try {
    listed = await listEvents({
      accessToken,
      calendarId,
      syncToken: acct.sync_token,
      timeMin: acct.sync_token
        ? undefined
        : new Date(
            Date.now() - INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000
          ).toISOString(),
    });
  } catch (err) {
    if (err instanceof SyncTokenInvalidError) {
      // Google expired our sync token (≥7 days stale). Wipe it and do
      // a full resync — any upserts still dedupe via the unique index.
      fullResync = true;
      await (admin as any)
        .from("google_calendar_accounts")
        .update({ sync_token: null })
        .eq("id", acct.id);
      listed = await listEvents({
        accessToken,
        calendarId,
        syncToken: null,
        timeMin: new Date(
          Date.now() - INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000
        ).toISOString(),
      });
    } else {
      throw err;
    }
  }

  // Step 3: apply changes.
  let upserted = 0;
  let deleted = 0;

  // Partition into active vs cancelled so we can batch each side.
  const activeRows: Array<ReturnType<typeof toEventRow>> = [];
  const cancelledEventIds: string[] = [];

  for (const gev of listed.items) {
    if (gev.status === "cancelled") {
      cancelledEventIds.push(gev.id);
      continue;
    }
    const row = toEventRow(gev, calendarId, "America/New_York");
    if (row) activeRows.push(row);
  }

  if (activeRows.length > 0) {
    const { error: upsertErr } = await (admin as any)
      .from("events")
      .upsert(activeRows, {
        onConflict: "google_calendar_id,google_event_id",
      });
    if (upsertErr) throw new Error(`events upsert failed: ${upsertErr.message}`);
    upserted = activeRows.length;
  }

  if (cancelledEventIds.length > 0) {
    const { error: delErr, count } = await (admin as any)
      .from("events")
      .delete({ count: "exact" })
      .eq("google_calendar_id", calendarId)
      .in("google_event_id", cancelledEventIds);
    if (delErr) throw new Error(`events delete failed: ${delErr.message}`);
    deleted = count ?? cancelledEventIds.length;
  }

  // Step 4: save the new sync token (only if Google gave us one).
  if (listed.nextSyncToken) {
    await (admin as any)
      .from("google_calendar_accounts")
      .update({
        sync_token: listed.nextSyncToken,
        updated_at: new Date().toISOString(),
      })
      .eq("id", acct.id);
  }

  return {
    googleEmail: acct.google_email,
    calendarId,
    upserted,
    deleted,
    fullResync,
  };
}
