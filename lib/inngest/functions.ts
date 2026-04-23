/**
 * Inngest functions.
 *
 * One "reminder runner" function. When `reminder/scheduled` fires with
 * `{ reminderId }`, we:
 *   1. Read the reminder row to get `send_at`.
 *   2. `sleepUntil(send_at)` — Inngest holds the job durably.
 *   3. Re-read the row (it may have been cancelled while we slept).
 *   4. Load the event + contact and hand off to `sendReminder()`.
 *
 * The dispatcher itself owns writing the outcome to `reminder_dispatches`
 * and marking the `reminders` row sent / failed. This function is glue.
 *
 * Idempotency: if `reminder.status` is not 'scheduled' by the time we
 * wake up, we bail — no double-send. The upstream scheduler can safely
 * re-emit the event (Inngest dedupes on `step.run` ids within a run, but
 * we guard the DB mutations too).
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendReminder } from "@/lib/notify";
import type { ReminderKind } from "@/lib/notify/templates";
import { refreshAccessToken, RefreshTokenDeadError } from "@/lib/google/oauth";
import {
  createGoogleTask,
  patchGoogleTask,
  deleteGoogleTask,
  getGoogleTask,
  listTaskLists,
  TaskEtagConflictError,
  TasksScopeMissingError,
  TasksUnauthorizedError,
} from "@/lib/google/tasks";
import {
  createGoogleEvent,
  patchGoogleEvent,
  getGoogleEvent,
  EventEtagConflictError,
  EventPermissionError,
  EventUnauthorizedError,
} from "@/lib/google/calendar";

export const reminderRunner = inngest.createFunction(
  {
    id: "reminder-runner",
    name: "Send scheduled reminder",
    // If a reminder raises mid-dispatch (rare — most failures are logged
    // without throwing), retry twice with exponential backoff before the
    // row lands in 'failed'. Don't retry forever — a bad phone number
    // shouldn't loop for days.
    retries: 2,
  },
  { event: "reminder/scheduled" },
  async ({ event, step }) => {
    const { reminderId } = event.data as { reminderId: string };
    const admin = createAdminClient();

    // Step 1: load the scheduled send time. We read only what we need
    // here so the payload Inngest persists for the sleep step is small.
    const reminder = await step.run("load-reminder", async () => {
      const { data, error } = (await (admin as any)
        .from("reminders")
        .select("id, event_id, contact_id, send_at, status, offset_minutes")
        .eq("id", reminderId)
        .maybeSingle()) as {
        data: {
          id: string;
          event_id: string;
          contact_id: string;
          send_at: string;
          status: string;
          offset_minutes: number;
        } | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(`load reminder failed: ${error.message}`);
      if (!data) throw new Error(`reminder not found: ${reminderId}`);
      return data;
    });

    if (reminder.status !== "scheduled") {
      // Cancelled or already sent — bail cleanly.
      return { skipped: true, reason: `status=${reminder.status}` };
    }

    // Step 2: sleep until the scheduled time. Inngest persists the run and
    // wakes us back up at the right moment, even across deploys.
    await step.sleepUntil("wait-until-send-time", reminder.send_at);

    // Step 3: re-check status on wake-up. If an event was cancelled or
    // rescheduled while we slept, the reminder row should reflect that.
    const latest = await step.run("recheck-status", async () => {
      const { data } = (await (admin as any)
        .from("reminders")
        .select("status")
        .eq("id", reminderId)
        .maybeSingle()) as { data: { status: string } | null };
      return data?.status ?? "missing";
    });
    if (latest !== "scheduled") {
      return { skipped: true, reason: `woke up with status=${latest}` };
    }

    // Flip to 'sending' so any concurrent wake-up (shouldn't happen, but)
    // sees we've claimed this send.
    await step.run("mark-sending", async () => {
      await (admin as any)
        .from("reminders")
        .update({ status: "sending", updated_at: new Date().toISOString() })
        .eq("id", reminderId);
    });

    // Step 4: load the event + contact, then dispatch.
    const { event: ev, contact, kind } = await step.run(
      "load-event-contact",
      async () => {
        const { data: event } = (await (admin as any)
          .from("events")
          .select("id, title, location, starts_at, ends_at, timezone")
          .eq("id", reminder.event_id)
          .maybeSingle()) as {
          data: {
            id: string;
            title: string;
            location: string | null;
            starts_at: string;
            ends_at: string;
            timezone: string;
          } | null;
        };
        if (!event) throw new Error(`event missing: ${reminder.event_id}`);

        const { data: contact } = (await (admin as any)
          .from("contacts")
          .select(
            "id, full_name, email, phone, sms_consent_at, email_consent_at, preferred_channels"
          )
          .eq("id", reminder.contact_id)
          .maybeSingle()) as {
          data: {
            id: string;
            full_name: string;
            email: string | null;
            phone: string | null;
            sms_consent_at: string | null;
            email_consent_at: string | null;
            preferred_channels: string[];
          } | null;
        };
        if (!contact)
          throw new Error(`contact missing: ${reminder.contact_id}`);

        const kind: ReminderKind =
          reminder.offset_minutes >= 1440 ? "remind_24h" : "remind_1h";
        return { event, contact, kind };
      }
    );

    // Do NOT wrap the dispatcher in step.run — the dispatcher itself writes
    // to reminder_dispatches and updates the reminder row, and step.run
    // memoization would cause double-writes on retry. Keeping this outside
    // a step means Inngest's retry semantics retry the whole function,
    // which is fine — the DB writes are idempotent via status checks.
    const outcomes = await sendReminder({
      reminderId,
      kind,
      contact,
      event: ev,
    });

    return { reminderId, outcomes };
  }
);

// Google access tokens are valid for 1 hour; refresh early to avoid
// racing a token expiry mid-push. Matches the constant in lib/google/sync.ts.
const GOOGLE_TOKEN_REFRESH_BUFFER_SECONDS = 120;

/**
 * Force-refresh a Google access token out-of-band (regardless of our
 * locally-stored expiry) and persist the new pair. Used when we 401 on
 * an API call with a token that our clock says is still valid — Google
 * can revoke tokens out-of-band (user changed password, revoked access,
 * etc.) and we need to recover without waiting for an Inngest retry.
 *
 * Returns the fresh access token. Rotated refresh tokens are persisted
 * too (Google rotates them silently sometimes).
 */
async function forceRefreshGoogleToken(
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  refreshToken: string
): Promise<string> {
  const refreshed = await refreshAccessToken(refreshToken);
  const patch: Record<string, unknown> = {
    access_token: refreshed.access_token,
    token_expires_at: new Date(
      Date.now() + refreshed.expires_in * 1000
    ).toISOString(),
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

/**
 * Push a locally-modified task to Google Tasks.
 *
 * Fires on `task/push-to-google` emitted by lib/tasks/service.ts and the
 * toggle endpoint. Handles three cases:
 *   - CREATE:  local row has no google_task_id → POST a new task on the
 *              user's default tasklist. Save the returned google_task_id
 *              + etag.
 *   - UPDATE:  local row has google_task_id → PATCH with If-Match etag.
 *              On 412 etag-conflict, refetch and merge (local wins title/
 *              notes, remote wins status — matches the reconciliation
 *              rule in the architecture plan).
 *   - CANCEL:  local row has status='cancelled' → DELETE on Google side.
 *
 * On any permanent failure (no Google account, scope missing, bad row),
 * push_status flips to 'error' and push_error is filled so the dashboard
 * can surface it. Inngest retries twice for transient failures before
 * giving up.
 */
export const taskPushRunner = inngest.createFunction(
  {
    id: "task-push-to-google",
    name: "Push local task to Google Tasks",
    // Same retry budget as reminders. A consistent 401/403 is scope or
    // permission; don't thrash.
    retries: 2,
  },
  { event: "task/push-to-google" },
  async ({ event, step }) => {
    const { taskId } = event.data as { taskId: string };
    const admin = createAdminClient();

    // Step 1: load the task. Bail early if someone marked it pushed/skip
    // between emit and wake — prevents double-pushes when the service
    // layer re-emits on every mutation.
    const task = await step.run("load-task", async () => {
      const { data, error } = (await (admin as any)
        .from("tasks")
        .select("*")
        .eq("id", taskId)
        .maybeSingle()) as {
        data: {
          id: string;
          team_member_id: string;
          title: string;
          notes: string | null;
          status: "needsAction" | "completed" | "cancelled";
          due_at: string | null;
          google_account_id: string | null;
          google_tasklist_id: string | null;
          google_task_id: string | null;
          remote_etag: string | null;
          push_status: "pending" | "pushed" | "error" | "skip";
        } | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(`load task failed: ${error.message}`);
      if (!data) throw new Error(`task not found: ${taskId}`);
      return data;
    });

    if (task.push_status === "pushed" || task.push_status === "skip") {
      return { skipped: true, reason: `push_status=${task.push_status}` };
    }

    // Step 2: find the Google account for this team member. We use the
    // team member's MOST-RECENTLY-UPDATED account as the target — same
    // pattern the dashboard uses when picking which calendar to display.
    // Future: let users pick which account (multi-account edge case).
    const acct = await step.run("load-google-account", async () => {
      // If the task already has a google_account_id, use it. Otherwise
      // pick the member's primary account.
      if (task.google_account_id) {
        const { data } = (await (admin as any)
          .from("google_calendar_accounts")
          .select(
            "id, access_token, refresh_token, token_expires_at, google_email"
          )
          .eq("id", task.google_account_id)
          .maybeSingle()) as {
          data: {
            id: string;
            access_token: string;
            refresh_token: string;
            token_expires_at: string;
            google_email: string;
          } | null;
        };
        return data;
      }
      const { data } = (await (admin as any)
        .from("google_calendar_accounts")
        .select(
          "id, access_token, refresh_token, token_expires_at, google_email"
        )
        .eq("team_member_id", task.team_member_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()) as {
        data: {
          id: string;
          access_token: string;
          refresh_token: string;
          token_expires_at: string;
          google_email: string;
        } | null;
      };
      return data;
    });

    if (!acct) {
      // User has no Google account connected — nothing to push to. This
      // is NOT retryable; mark permanent skip so we don't loop.
      await markPushOutcome(admin, taskId, {
        push_status: "skip",
        push_error: "No Google account connected for this team member",
      });
      return { skipped: true, reason: "no-google-account" };
    }

    // Re-bind the narrowed (non-null) acct into a local. TS's
    // control-flow analysis doesn't propagate null-narrowing into inner
    // function closures (step.run callbacks, withRefreshOn401), even
    // when the captured variable is const. Capturing `acctSafe` instead
    // of `acct` keeps the narrowing alive across those closures.
    const acctSafe = acct;

    // Step 3: refresh token if it's near expiry. Same buffer as sync.
    // We persist the rotated refresh_token too (Google occasionally
    // rotates silently — dropping it means eventual re-auth prompts).
    let accessToken = acctSafe.access_token;
    const expiresAt = new Date(acctSafe.token_expires_at).getTime();
    if (expiresAt - Date.now() < GOOGLE_TOKEN_REFRESH_BUFFER_SECONDS * 1000) {
      accessToken = await step.run("refresh-token", async () => {
        const refreshed = await refreshAccessToken(acctSafe.refresh_token);
        const patch: Record<string, unknown> = {
          access_token: refreshed.access_token,
          token_expires_at: new Date(
            Date.now() + refreshed.expires_in * 1000
          ).toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (refreshed.refresh_token) {
          patch.refresh_token = refreshed.refresh_token;
        }
        await (admin as any)
          .from("google_calendar_accounts")
          .update(patch)
          .eq("id", acctSafe.id);
        return refreshed.access_token;
      });
    }

    // Small wrapper: run a Google Tasks API call; if it 401s even though
    // our clock thought the token was valid, force-refresh once and retry
    // inline. Scope/403 errors bubble up — those aren't token problems.
    //
    // `accessToken` is captured by reference via a holder object so that
    // after a refresh, subsequent calls in the same run see the new token
    // without re-plumbing through function args. `acctSafe` is the
    // null-narrowed rebind of acct; see where it's declared above.
    const tokenRef = { current: accessToken };
    async function withRefreshOn401<T>(fn: (token: string) => Promise<T>): Promise<T> {
      try {
        return await fn(tokenRef.current);
      } catch (err) {
        if (err instanceof TasksUnauthorizedError) {
          tokenRef.current = await forceRefreshGoogleToken(
            admin,
            acctSafe.id,
            acctSafe.refresh_token
          );
          return await fn(tokenRef.current);
        }
        throw err;
      }
    }

    // Step 4: resolve a target tasklist for CREATE. If the local task
    // already has a google_tasklist_id (because it was pulled from
    // Google originally), reuse it. Otherwise pick the first list —
    // Google always returns at least one ("My Tasks") for a connected
    // account.
    let tasklistId = task.google_tasklist_id;
    if (!tasklistId && task.status !== "cancelled") {
      tasklistId = await step.run("pick-tasklist", async () => {
        const lists = await withRefreshOn401((t) => listTaskLists(t));
        if (lists.length === 0) {
          throw new Error("no task lists available on this Google account");
        }
        return lists[0].id;
      });
    }

    // Step 5: dispatch. Each branch is its own step.run so Inngest can
    // show exactly which call failed if something goes wrong.

    // --- CANCEL ---------------------------------------------------------
    if (task.status === "cancelled") {
      if (task.google_task_id && tasklistId) {
        try {
          await step.run("delete-google-task", async () =>
            withRefreshOn401((t) =>
              deleteGoogleTask({
                accessToken: t,
                tasklistId: tasklistId!,
                taskId: task.google_task_id!,
              })
            )
          );
        } catch (err) {
          const scopeMissing = err instanceof TasksScopeMissingError;
          const msg = err instanceof Error ? err.message : String(err);
          await markPushOutcome(admin, taskId, {
            push_status: scopeMissing ? "skip" : "error",
            push_error: msg,
          });
          if (scopeMissing) return { skipped: true, reason: "scope-missing" };
          throw err;
        }
      }
      await markPushOutcome(admin, taskId, {
        push_status: "pushed",
        push_error: null,
      });
      return { pushed: true, action: "cancel" };
    }

    // --- CREATE ---------------------------------------------------------
    if (!task.google_task_id) {
      // We already returned early for status='cancelled' above, so the
      // narrowed shape is safe here. TS doesn't track that narrowing
      // through the function body, so re-assert with a cast.
      const liveStatus = task.status as "needsAction" | "completed";
      try {
        const created = await step.run("create-google-task", async () =>
          withRefreshOn401((t) =>
            createGoogleTask({
              accessToken: t,
              tasklistId: tasklistId!,
              title: task.title,
              notes: task.notes ?? null,
              due: task.due_at ?? null,
              status: liveStatus,
            })
          )
        );
        await markPushOutcome(admin, taskId, {
          push_status: "pushed",
          push_error: null,
          google_account_id: acctSafe.id,
          google_tasklist_id: tasklistId!,
          google_task_id: created.id,
          remote_etag: created.etag ?? null,
          remote_updated_at: created.updated ?? null,
        });
        return { pushed: true, action: "create", googleTaskId: created.id };
      } catch (err) {
        const scopeMissing = err instanceof TasksScopeMissingError;
        const msg = err instanceof Error ? err.message : String(err);
        await markPushOutcome(admin, taskId, {
          push_status: scopeMissing ? "skip" : "error",
          push_error: msg,
        });
        if (scopeMissing) return { skipped: true, reason: "scope-missing" };
        throw err;
      }
    }

    // --- UPDATE ---------------------------------------------------------
    // Status is narrowed to needsAction|completed here too — the cancelled
    // branch returned early above.
    const liveUpdateStatus = task.status as "needsAction" | "completed";
    try {
      let updated;
      try {
        updated = await step.run("patch-google-task", async () =>
          withRefreshOn401((t) =>
            patchGoogleTask({
              accessToken: t,
              tasklistId: tasklistId!,
              taskId: task.google_task_id!,
              expectedEtag: task.remote_etag,
              title: task.title,
              notes: task.notes ?? null,
              due: task.due_at ?? null,
              status: liveUpdateStatus,
            })
          )
        );
      } catch (err) {
        if (err instanceof TaskEtagConflictError) {
          // Conflict — Google's version is newer than what we remember.
          // Pull fresh, merge (local wins title/notes, remote wins
          // status), and retry WITHOUT If-Match so we overwrite with
          // the merged fields regardless of another concurrent write.
          updated = await step.run("resolve-etag-conflict", async () => {
            const remote = await withRefreshOn401((t) =>
              getGoogleTask({
                accessToken: t,
                tasklistId: tasklistId!,
                taskId: task.google_task_id!,
              })
            );
            return await withRefreshOn401((t) =>
              patchGoogleTask({
                accessToken: t,
                tasklistId: tasklistId!,
                taskId: task.google_task_id!,
                expectedEtag: null, // force overwrite
                title: task.title,
                notes: task.notes ?? null,
                due: task.due_at ?? null,
                // Respect remote status if Ronny checked it off on his
                // phone while we were mid-push.
                status: remote.status,
              })
            );
          });
        } else {
          throw err;
        }
      }
      await markPushOutcome(admin, taskId, {
        push_status: "pushed",
        push_error: null,
        remote_etag: updated.etag ?? null,
        remote_updated_at: updated.updated ?? null,
      });
      return { pushed: true, action: "update" };
    } catch (err) {
      const scopeMissing = err instanceof TasksScopeMissingError;
      const msg = err instanceof Error ? err.message : String(err);
      await markPushOutcome(admin, taskId, {
        push_status: scopeMissing ? "skip" : "error",
        push_error: msg,
      });
      if (scopeMissing) return { skipped: true, reason: "scope-missing" };
      throw err;
    }
  }
);

/**
 * Small helper: flip push_status + associated fields on a task row.
 * Kept separate so the function body above stays readable — each branch
 * ends with a single call here regardless of outcome.
 */
async function markPushOutcome(
  admin: ReturnType<typeof createAdminClient>,
  taskId: string,
  patch: {
    push_status: "pending" | "pushed" | "error" | "skip";
    push_error: string | null;
    google_account_id?: string;
    google_tasklist_id?: string;
    google_task_id?: string;
    remote_etag?: string | null;
    remote_updated_at?: string | null;
  }
): Promise<void> {
  const update: Record<string, unknown> = {
    push_status: patch.push_status,
    push_error: patch.push_error,
    last_push_attempt_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (patch.google_account_id !== undefined)
    update.google_account_id = patch.google_account_id;
  if (patch.google_tasklist_id !== undefined)
    update.google_tasklist_id = patch.google_tasklist_id;
  if (patch.google_task_id !== undefined)
    update.google_task_id = patch.google_task_id;
  if (patch.remote_etag !== undefined) update.remote_etag = patch.remote_etag;
  if (patch.remote_updated_at !== undefined)
    update.remote_updated_at = patch.remote_updated_at;

  await (admin as any).from("tasks").update(update).eq("id", taskId);
}

/**
 * Proactive Google token refresh — runs every 30 minutes and refreshes
 * any account whose access_token expires within 40 minutes. Access
 * tokens last 60 minutes, so this keeps every token always <20 min from
 * fresh → users cannot hit a stale-token 401 in normal traffic. That's
 * the "professional" baseline: auth errors exist but are invisible.
 *
 * Dead refresh_tokens (invalid_grant) are flagged with needs_reconnect=
 * true and skipped on subsequent runs. The dashboard banner surfaces
 * the reconnect prompt to the user.
 *
 * Cost: one HTTP call per account per half hour. For a team of 5 users
 * that's 240 refreshes/day — trivial on both our side and Google's
 * quota. Each call is ~200ms, total function runtime ~1s per execution
 * for our current user count.
 */
export const googleTokenRefreshCron = inngest.createFunction(
  {
    id: "google-token-refresh-cron",
    name: "Proactively refresh Google access tokens",
    // If Google itself is down, retry twice with backoff — but don't
    // thrash if the failures are persistent. The next 30-min tick is
    // the real retry boundary.
    retries: 2,
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    const admin = createAdminClient();

    // Target: tokens expiring within REFRESH_WINDOW_MIN from now.
    // 40 min > 30 min cron interval, so every token gets refreshed at
    // least once before its 1h TTL runs out.
    const REFRESH_WINDOW_MIN = 40;
    const cutoff = new Date(
      Date.now() + REFRESH_WINDOW_MIN * 60 * 1000
    ).toISOString();

    const accounts = await step.run("list-targets", async () => {
      const { data, error } = (await (admin as any)
        .from("google_calendar_accounts")
        .select(
          "id, google_email, refresh_token, token_expires_at, needs_reconnect"
        )
        // Partial index covers this filter — see migration
        // 20260423120000_google_account_auth_health.sql.
        .eq("needs_reconnect", false)
        .lt("token_expires_at", cutoff)) as {
        data:
          | Array<{
              id: string;
              google_email: string;
              refresh_token: string;
              token_expires_at: string;
              needs_reconnect: boolean;
            }>
          | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(`list accounts failed: ${error.message}`);
      return data ?? [];
    });

    const results: Array<{
      id: string;
      email: string;
      outcome: "refreshed" | "dead" | "error";
      error?: string;
    }> = [];

    // Sequential on purpose — parallel would hammer Google if we ever
    // scaled to many accounts, and the total runtime is bounded (each
    // refresh ~200ms; 20 accounts = 4s). Convert to Promise.all later
    // if needed.
    for (const acct of accounts) {
      try {
        const refreshed = await refreshAccessToken(acct.refresh_token);
        const patch: Record<string, unknown> = {
          access_token: refreshed.access_token,
          token_expires_at: new Date(
            Date.now() + refreshed.expires_in * 1000
          ).toISOString(),
          updated_at: new Date().toISOString(),
          // A successful refresh confirms we're healthy — clear any
          // stale error residue from a previous failed attempt that
          // resolved out-of-band.
          last_auth_error: null,
          last_auth_error_at: null,
        };
        if (refreshed.refresh_token) {
          patch.refresh_token = refreshed.refresh_token;
        }
        await (admin as any)
          .from("google_calendar_accounts")
          .update(patch)
          .eq("id", acct.id);
        results.push({
          id: acct.id,
          email: acct.google_email,
          outcome: "refreshed",
        });
      } catch (err) {
        if (err instanceof RefreshTokenDeadError) {
          // Permanent — flag for reconnect banner. Don't retry ever;
          // the token is dead and Google will keep saying so.
          await (admin as any)
            .from("google_calendar_accounts")
            .update({
              needs_reconnect: true,
              last_auth_error: err.body.slice(0, 500),
              last_auth_error_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", acct.id);
          results.push({
            id: acct.id,
            email: acct.google_email,
            outcome: "dead",
          });
          console.warn(
            "[token-refresh-cron] refresh_token dead",
            acct.google_email
          );
        } else {
          // Transient — record the error but keep needs_reconnect=false
          // so the next cron tick will try again.
          const msg = err instanceof Error ? err.message : String(err);
          await (admin as any)
            .from("google_calendar_accounts")
            .update({
              last_auth_error: msg.slice(0, 500),
              last_auth_error_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", acct.id);
          results.push({
            id: acct.id,
            email: acct.google_email,
            outcome: "error",
            error: msg,
          });
          console.error(
            "[token-refresh-cron] transient refresh failure",
            acct.google_email,
            msg
          );
        }
      }
    }

    return {
      targeted: accounts.length,
      refreshed: results.filter((r) => r.outcome === "refreshed").length,
      dead: results.filter((r) => r.outcome === "dead").length,
      errors: results.filter((r) => r.outcome === "error").length,
    };
  }
);

/**
 * Push a locally-created/edited event to Google Calendar.
 *
 * Fires on `event/push-to-google-calendar` emitted by
 * lib/events/service.ts. Handles:
 *   - CREATE:  local row has no google_event_id → POST a new event on
 *              the user's primary calendar. Save google_event_id + etag.
 *   - UPDATE:  local row has google_event_id → PATCH with If-Match etag.
 *              On 412 etag-conflict, refetch + merge (local wins the
 *              title/description/location/time, we don't try to undo
 *              a remote delete).
 *
 * This is essentially taskPushRunner's cousin — same retry-on-401
 * pattern, same scope-missing handling, same etag-conflict approach.
 */
export const eventPushRunner = inngest.createFunction(
  {
    id: "event-push-to-google-calendar",
    name: "Push local event to Google Calendar",
    retries: 2,
  },
  { event: "event/push-to-google-calendar" },
  async ({ event, step }) => {
    const { eventId, teamMemberId } = event.data as {
      eventId: string;
      teamMemberId: string;
    };
    const admin = createAdminClient();

    // Step 1: load the local row. Bail if someone already flipped
    // push_status to pushed/skip between emit and wake.
    const row = await step.run("load-event", async () => {
      const { data, error } = (await (admin as any)
        .from("events")
        .select("*")
        .eq("id", eventId)
        .maybeSingle()) as {
        data: {
          id: string;
          title: string;
          description: string | null;
          location: string | null;
          starts_at: string;
          ends_at: string;
          timezone: string;
          google_calendar_id: string | null;
          google_event_id: string | null;
          google_account_id: string | null;
          etag: string | null;
          push_status: "pending" | "pushed" | "error" | "skip";
        } | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(`load event failed: ${error.message}`);
      if (!data) throw new Error(`event not found: ${eventId}`);
      return data;
    });

    if (row.push_status === "pushed" || row.push_status === "skip") {
      return { skipped: true, reason: `push_status=${row.push_status}` };
    }

    // Step 2: find the Google account to push to. Same logic as tasks —
    // use the linked account if present, else the team member's primary.
    const acct = await step.run("load-google-account", async () => {
      if (row.google_account_id) {
        const { data } = (await (admin as any)
          .from("google_calendar_accounts")
          .select(
            "id, access_token, refresh_token, token_expires_at, google_email"
          )
          .eq("id", row.google_account_id)
          .maybeSingle()) as {
          data: {
            id: string;
            access_token: string;
            refresh_token: string;
            token_expires_at: string;
            google_email: string;
          } | null;
        };
        return data;
      }
      const { data } = (await (admin as any)
        .from("google_calendar_accounts")
        .select(
          "id, access_token, refresh_token, token_expires_at, google_email"
        )
        .eq("team_member_id", teamMemberId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()) as {
        data: {
          id: string;
          access_token: string;
          refresh_token: string;
          token_expires_at: string;
          google_email: string;
        } | null;
      };
      return data;
    });

    if (!acct) {
      await markEventPushOutcome(admin, eventId, {
        push_status: "skip",
        push_error: "No Google account connected for this team member",
      });
      return { skipped: true, reason: "no-google-account" };
    }

    const acctSafe = acct;

    // Step 3: refresh the token if it's near expiry.
    let accessToken = acctSafe.access_token;
    const expiresAt = new Date(acctSafe.token_expires_at).getTime();
    if (expiresAt - Date.now() < GOOGLE_TOKEN_REFRESH_BUFFER_SECONDS * 1000) {
      accessToken = await step.run("refresh-token", async () =>
        forceRefreshGoogleToken(admin, acctSafe.id, acctSafe.refresh_token)
      );
    }

    // Step 4: resolve which calendar to write to. Events sync uses
    // "primary" as the default which resolves to the user's main cal.
    const calendarId = row.google_calendar_id ?? "primary";

    // Retry-on-401 wrapper — same pattern as taskPushRunner.
    const tokenRef = { current: accessToken };
    async function withRefreshOn401<T>(
      fn: (token: string) => Promise<T>
    ): Promise<T> {
      try {
        return await fn(tokenRef.current);
      } catch (err) {
        if (err instanceof EventUnauthorizedError) {
          tokenRef.current = await forceRefreshGoogleToken(
            admin,
            acctSafe.id,
            acctSafe.refresh_token
          );
          return await fn(tokenRef.current);
        }
        throw err;
      }
    }

    // --- CREATE ---------------------------------------------------------
    if (!row.google_event_id) {
      try {
        const created = await step.run("create-google-event", async () =>
          withRefreshOn401((t) =>
            createGoogleEvent({
              accessToken: t,
              calendarId,
              title: row.title,
              description: row.description,
              location: row.location,
              startIso: row.starts_at,
              endIso: row.ends_at,
              timeZone: row.timezone,
            })
          )
        );
        await markEventPushOutcome(admin, eventId, {
          push_status: "pushed",
          push_error: null,
          google_account_id: acctSafe.id,
          google_calendar_id: calendarId,
          google_event_id: created.id,
          etag: created.etag ?? null,
        });
        return { pushed: true, action: "create", googleEventId: created.id };
      } catch (err) {
        const permDenied = err instanceof EventPermissionError;
        const msg = err instanceof Error ? err.message : String(err);
        await markEventPushOutcome(admin, eventId, {
          push_status: permDenied ? "skip" : "error",
          push_error: msg,
        });
        if (permDenied) return { skipped: true, reason: "permission-denied" };
        throw err;
      }
    }

    // --- UPDATE ---------------------------------------------------------
    try {
      let updated;
      try {
        updated = await step.run("patch-google-event", async () =>
          withRefreshOn401((t) =>
            patchGoogleEvent({
              accessToken: t,
              calendarId,
              googleEventId: row.google_event_id!,
              expectedEtag: row.etag,
              title: row.title,
              description: row.description,
              location: row.location,
              startIso: row.starts_at,
              endIso: row.ends_at,
              timeZone: row.timezone,
            })
          )
        );
      } catch (err) {
        if (err instanceof EventEtagConflictError) {
          // Conflict — remote changed. Pull fresh, then push again
          // without If-Match. Events favor the local side (the user
          // just edited something and wants it to stick); we let
          // status alone since there's no "cancelled" state in our
          // local events model yet.
          updated = await step.run("resolve-event-etag-conflict", async () => {
            await withRefreshOn401((t) =>
              getGoogleEvent({
                accessToken: t,
                calendarId,
                googleEventId: row.google_event_id!,
              })
            );
            return await withRefreshOn401((t) =>
              patchGoogleEvent({
                accessToken: t,
                calendarId,
                googleEventId: row.google_event_id!,
                expectedEtag: null, // force overwrite
                title: row.title,
                description: row.description,
                location: row.location,
                startIso: row.starts_at,
                endIso: row.ends_at,
                timeZone: row.timezone,
              })
            );
          });
        } else {
          throw err;
        }
      }
      await markEventPushOutcome(admin, eventId, {
        push_status: "pushed",
        push_error: null,
        etag: updated.etag ?? null,
      });
      return { pushed: true, action: "update" };
    } catch (err) {
      const permDenied = err instanceof EventPermissionError;
      const msg = err instanceof Error ? err.message : String(err);
      await markEventPushOutcome(admin, eventId, {
        push_status: permDenied ? "skip" : "error",
        push_error: msg,
      });
      if (permDenied) return { skipped: true, reason: "permission-denied" };
      throw err;
    }
  }
);

/**
 * Flip push_status + identity columns on an events row. Sibling to
 * markPushOutcome above — separate because the events table has
 * slightly different column names (etag vs remote_etag, etc).
 */
async function markEventPushOutcome(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
  patch: {
    push_status: "pending" | "pushed" | "error" | "skip";
    push_error: string | null;
    google_account_id?: string;
    google_calendar_id?: string;
    google_event_id?: string;
    etag?: string | null;
  }
): Promise<void> {
  const update: Record<string, unknown> = {
    push_status: patch.push_status,
    push_error: patch.push_error,
    last_push_attempt_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (patch.google_account_id !== undefined)
    update.google_account_id = patch.google_account_id;
  if (patch.google_calendar_id !== undefined)
    update.google_calendar_id = patch.google_calendar_id;
  if (patch.google_event_id !== undefined)
    update.google_event_id = patch.google_event_id;
  if (patch.etag !== undefined) update.etag = patch.etag;

  await (admin as any).from("events").update(update).eq("id", eventId);
}

/**
 * Collect all functions the serve handler should register. If we add more
 * functions later (e.g. a nightly digest), just append to this array.
 */
export const functions = [
  reminderRunner,
  taskPushRunner,
  googleTokenRefreshCron,
  eventPushRunner,
];
