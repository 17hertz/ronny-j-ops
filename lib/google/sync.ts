/**
 * Google sync orchestrator (Calendar events + Tasks).
 *
 * Called by:
 *   - POST /api/google/sync   (user-triggered, scoped to one team_member)
 *   - Inngest cron            (once wired up; scoped to all accounts)
 *
 * Per-account flow:
 *   1. Refresh the access token if it's expired.
 *   2. Calendar: pull events with `listEvents` — incremental if we have a
 *      sync token, full otherwise. On 410 Gone, wipe the token and retry.
 *      Upsert active events; delete cancelled.
 *   3. Tasks (best effort): list every tasklist, pull tasks updated since
 *      our last remote timestamp, mirror into `google_tasks`.
 *      Tolerates missing scope — existing connections made before we added
 *      tasks.readonly won't have it; we skip and surface a reconnect hint.
 *   4. Save the new sync token back.
 *
 * We use the service-role client here because the `events` / `google_tasks`
 * tables have per-team-member RLS but this function may be invoked out-of-band
 * (scheduled, not user-initiated). Identity is established by the caller.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshAccessToken } from "@/lib/google/oauth";
import {
  listEvents,
  toEventRow,
  SyncTokenInvalidError,
} from "@/lib/google/calendar";
import {
  listTaskLists,
  listTasks,
  toTaskRow,
  TasksScopeMissingError,
} from "@/lib/google/tasks";
import {
  scheduleRemindersForEvent,
  cancelRemindersForEvent,
} from "@/lib/reminders/schedule";

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
  tasks: {
    upserted: number;
    deleted: number;
    scopeMissing: boolean;
  };
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
    results.push(await syncOneAccount(admin, acct, teamMemberId));
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
  acct: AccountRow,
  teamMemberId: string
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
    // Upsert and ask PostgREST to return the ids so we can schedule
    // reminders for each one without a follow-up SELECT round-trip.
    const { data: upsertedRows, error: upsertErr } = (await (admin as any)
      .from("events")
      .upsert(activeRows, {
        onConflict: "google_calendar_id,google_event_id",
      })
      .select("id")) as {
      data: Array<{ id: string }> | null;
      error: { message: string } | null;
    };
    if (upsertErr) throw new Error(`events upsert failed: ${upsertErr.message}`);
    upserted = activeRows.length;

    // Schedule reminders for every attendee already attached to each event.
    // No-op for events with no attendees — calendar sync alone doesn't
    // create attendees; the intake portal / manual attach does.
    for (const row of upsertedRows ?? []) {
      try {
        await scheduleRemindersForEvent(row.id);
      } catch (err) {
        // A reminder scheduling hiccup shouldn't fail the whole sync —
        // worst case the cron will re-schedule on the next pass.
        console.error("[sync] scheduleReminders failed", row.id, err);
      }
    }
  }

  if (cancelledEventIds.length > 0) {
    // Look up local event ids first so we can cancel their reminders
    // before the rows get FK-deleted.
    const { data: toDelete } = (await (admin as any)
      .from("events")
      .select("id")
      .eq("google_calendar_id", calendarId)
      .in("google_event_id", cancelledEventIds)) as {
      data: Array<{ id: string }> | null;
    };

    for (const row of toDelete ?? []) {
      try {
        await cancelRemindersForEvent(row.id);
      } catch (err) {
        console.error("[sync] cancelReminders failed", row.id, err);
      }
    }

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

  // Step 5: Google Tasks (best effort; don't let tasks failure kill calendar).
  const tasksResult = await syncTasksForAccount({
    admin,
    accessToken,
    teamMemberId,
    googleAccountId: acct.id,
  });

  return {
    googleEmail: acct.google_email,
    calendarId,
    upserted,
    deleted,
    fullResync,
    tasks: tasksResult,
  };
}

/**
 * Mirror every tasklist for this Google account into `google_tasks`.
 * Returns counts + `scopeMissing` flag when the token lacks tasks.readonly
 * (i.e. connected before we added the scope — user needs to reconnect).
 */
async function syncTasksForAccount(opts: {
  admin: ReturnType<typeof createAdminClient>;
  accessToken: string;
  teamMemberId: string;
  googleAccountId: string;
}): Promise<{ upserted: number; deleted: number; scopeMissing: boolean }> {
  const { admin, accessToken, teamMemberId, googleAccountId } = opts;

  let lists;
  try {
    lists = await listTaskLists(accessToken);
  } catch (err) {
    if (err instanceof TasksScopeMissingError) {
      return { upserted: 0, deleted: 0, scopeMissing: true };
    }
    throw err;
  }

  // Incremental bound: pull only tasks updated since the newest row we have
  // for this account. On first run there are no rows, so we pull everything
  // (the task API doesn't impose a hard page cap, but active Tasks lists
  // rarely exceed a few hundred rows per user).
  const { data: lastRow } = (await (admin as any)
    .from("google_tasks")
    .select("remote_updated_at")
    .eq("google_account_id", googleAccountId)
    .order("remote_updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()) as { data: { remote_updated_at: string | null } | null };
  const updatedMin = lastRow?.remote_updated_at ?? undefined;

  let upserted = 0;
  let deleted = 0;

  for (const list of lists) {
    const gtasks = await listTasks({
      accessToken,
      tasklistId: list.id,
      updatedMin,
    });

    const rows: Array<NonNullable<ReturnType<typeof toTaskRow>>> = [];
    const deletedTaskIds: string[] = [];
    for (const gt of gtasks) {
      if (gt.deleted) {
        deletedTaskIds.push(gt.id);
        continue;
      }
      const row = toTaskRow(gt, {
        teamMemberId,
        googleAccountId,
        tasklistId: list.id,
      });
      if (row) rows.push(row);
    }

    if (rows.length > 0) {
      const { error: upsertErr } = await (admin as any)
        .from("google_tasks")
        .upsert(rows, {
          onConflict: "google_account_id,google_tasklist_id,google_task_id",
        });
      if (upsertErr) {
        throw new Error(`google_tasks upsert failed: ${upsertErr.message}`);
      }
      upserted += rows.length;
    }

    if (deletedTaskIds.length > 0) {
      const { error: delErr, count } = await (admin as any)
        .from("google_tasks")
        .delete({ count: "exact" })
        .eq("google_account_id", googleAccountId)
        .eq("google_tasklist_id", list.id)
        .in("google_task_id", deletedTaskIds);
      if (delErr) {
        throw new Error(`google_tasks delete failed: ${delErr.message}`);
      }
      deleted += count ?? deletedTaskIds.length;
    }
  }

  return { upserted, deleted, scopeMissing: false };
}
