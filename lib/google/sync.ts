/**
 * Google sync orchestrator (Calendar events + Tasks).
 *
 * Called by:
 *   - POST /api/google/sync   (user-triggered, scoped to one team_member)
 *   - Inngest cron            (once wired up; scoped to all accounts)
 *
 * Per-account flow:
 *   1. Refresh the access token if it's within REFRESH_BUFFER_SECONDS of
 *      expiry. Rotated refresh tokens (when Google sends one) are persisted.
 *   2. Calendar: pull events with `listEvents` — incremental if we have a
 *      sync token, full otherwise.
 *      On 410 Gone: wipe the sync token and retry with a full resync.
 *      On 401:      force-refresh the access token (ignore local expiry)
 *                   and retry once. A second 401 means the refresh token
 *                   itself is dead — the user has to reconnect.
 *      Upsert active events; delete cancelled.
 *   3. Tasks (best effort): list every tasklist, pull tasks updated since
 *      our last remote timestamp, mirror into `google_tasks`.
 *      Tolerates missing scope — existing connections made before we added
 *      tasks.readonly won't have it; we skip and surface a reconnect hint.
 *   4. Save the new sync token back.
 *
 * Per-account failures are captured on SyncResult.error rather than thrown,
 * so one bad connection doesn't kill syncs for the member's other accounts
 * (or — in the cron path — for other members).
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
  UnauthorizedError,
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
  /** Populated when this account failed; other accounts still ran. */
  error?: string;
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

  // Soft-fail per account: one bad Google account (revoked token, scope
  // mismatch, Cloud project API disabled) shouldn't kill syncs for the
  // member's other accounts. Collect successes; let the caller surface
  // failures via the returned SyncResult.error field.
  const results: SyncResult[] = [];
  for (const acct of accounts) {
    try {
      results.push(await syncOneAccount(admin, acct, teamMemberId));
    } catch (err) {
      console.error(
        "[sync] account failed",
        acct.google_email,
        err instanceof Error ? err.message : err
      );
      results.push({
        googleEmail: acct.google_email,
        calendarId: "primary",
        upserted: 0,
        deleted: 0,
        fullResync: false,
        tasks: { upserted: 0, deleted: 0, scopeMissing: false },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Call Google's refresh endpoint and persist the new access_token (+ rotated
 * refresh_token if Google sent one). Returns the fresh access_token.
 *
 * Google *usually* returns the same refresh_token on refresh, but it CAN
 * rotate it silently — if we don't persist the new one, the old one stops
 * working and the user has to reconnect. Storing every returned refresh
 * token is the safe move.
 */
async function refreshAndPersistToken(
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  refreshToken: string
): Promise<string> {
  const refreshed = await refreshAccessToken(refreshToken);
  const newExpiresAt = new Date(
    Date.now() + refreshed.expires_in * 1000
  ).toISOString();
  const patch: Record<string, unknown> = {
    access_token: refreshed.access_token,
    token_expires_at: newExpiresAt,
    updated_at: new Date().toISOString(),
  };
  if (refreshed.refresh_token) {
    patch.refresh_token = refreshed.refresh_token;
  }
  await (admin as any)
    .from("google_calendar_accounts")
    .update(patch)
    .eq("id", accountId);
  return refreshed.access_token;
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

  // Step 1: refresh token proactively if it's near expiry. The 401-retry
  // block below handles the case where Google rejects a token we think is
  // still valid (which happens more often than you'd expect — tokens get
  // revoked out-of-band when users change their Google password, revoke
  // access, or when the OAuth app changes state).
  let accessToken = acct.access_token;
  const expiresAt = new Date(acct.token_expires_at).getTime();
  const now = Date.now();
  if (expiresAt - now < REFRESH_BUFFER_SECONDS * 1000) {
    accessToken = await refreshAndPersistToken(
      admin,
      acct.id,
      acct.refresh_token
    );
  }

  // Step 2: list events. Two retry paths:
  //   a) 410 Gone → sync token is ≥7 days stale; wipe it and do full resync.
  //   b) 401     → access token is dead in Google's eyes even if our clock
  //                says it's fresh. Force a refresh and try once more.
  //                If it 401s again, the refresh_token is dead too — the
  //                user has to reconnect. Don't loop forever.
  let listed;
  let fullResync = !acct.sync_token;
  const doList = (token: string, syncToken: string | null) =>
    listEvents({
      accessToken: token,
      calendarId,
      syncToken,
      timeMin: syncToken
        ? undefined
        : new Date(
            Date.now() - INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000
          ).toISOString(),
    });

  try {
    listed = await doList(accessToken, acct.sync_token);
  } catch (err) {
    if (err instanceof SyncTokenInvalidError) {
      // 410 Gone — sync token is too stale. Wipe + full resync.
      fullResync = true;
      await (admin as any)
        .from("google_calendar_accounts")
        .update({ sync_token: null })
        .eq("id", acct.id);
      listed = await doList(accessToken, null);
    } else if (err instanceof UnauthorizedError) {
      // Stored access_token was rejected. Force-refresh and try once.
      // If this second call 401s, bubble up — the refresh token is dead.
      console.warn(
        "[sync] 401 on events.list, forcing refresh:",
        err.body.slice(0, 200)
      );
      accessToken = await refreshAndPersistToken(
        admin,
        acct.id,
        acct.refresh_token
      );
      try {
        listed = await doList(accessToken, acct.sync_token);
      } catch (retryErr) {
        if (retryErr instanceof UnauthorizedError) {
          throw new Error(
            `Google auth failed after refresh — user must reconnect (${acct.google_email}): ${retryErr.body.slice(0, 200)}`
          );
        }
        throw retryErr;
      }
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
    // createdBy = the team_member whose Google account this row came
    // from. Drives per-user privacy on the dashboard (Ronny doesn't see
    // Jason's events unless Jason flips shared=true).
    const row = toEventRow(gev, calendarId, "America/New_York", teamMemberId);
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

    // Schedule reminders only for events that actually have attendees.
    // Calendar sync alone doesn't create attendees (the intake portal /
    // manual attach does), so the vast majority of upserted events here
    // have zero attendees and would just be wasted round-trips.
    //
    // Earlier we called scheduleRemindersForEvent on EVERY upserted event
    // in a serial for-loop; each call did 2 SELECTs before returning empty.
    // On a 30-day first-sync that's ~600 serial round-trips — the reason
    // a full resync took 2 minutes. One batched query + parallel scheduling
    // for the small set that actually needs it is dramatically faster.
    const upsertedIds = (upsertedRows ?? []).map((r) => r.id);
    if (upsertedIds.length > 0) {
      const { data: withAttendees } = (await (admin as any)
        .from("event_attendees")
        .select("event_id")
        .in("event_id", upsertedIds)) as {
        data: Array<{ event_id: string }> | null;
      };
      const eventIdsWithAttendees = Array.from(
        new Set((withAttendees ?? []).map((r) => r.event_id))
      );
      // Run the real scheduling in parallel — each call makes a few DB
      // round-trips + inngest.send, which shouldn't serialize.
      await Promise.all(
        eventIdsWithAttendees.map(async (id) => {
          try {
            await scheduleRemindersForEvent(id);
          } catch (err) {
            // A reminder scheduling hiccup shouldn't fail the whole sync —
            // worst case the cron will re-schedule on the next pass.
            console.error("[sync] scheduleReminders failed", id, err);
          }
        })
      );
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
