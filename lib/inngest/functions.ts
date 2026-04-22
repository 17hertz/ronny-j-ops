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

/**
 * Collect all functions the serve handler should register. If we add more
 * functions later (e.g. a nightly digest), just append to this array.
 */
export const functions = [reminderRunner];
