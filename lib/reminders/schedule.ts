/**
 * Reminder scheduling helper.
 *
 * Given an event id, create a `reminders` row per (attendee × offset)
 * tuple and emit `reminder/scheduled` to Inngest for each. Idempotent on
 * `(event_id, contact_id, offset_minutes)` via the table's unique index —
 * if a sync pass runs twice, we don't double-schedule.
 *
 * Called from:
 *   - `lib/google/sync.ts` after each calendar upsert
 *   - Intake portal, when a vendor/client opts into reminders
 *   - Admin panel, when an attendee is manually added to a session
 *
 * Offsets we currently schedule:
 *   - 24h before (1440 min) — the heads-up
 *   - 1h before (60 min)    — the "walking in now" nudge
 *
 * Add more later (e.g. 15m for internal crew) by appending to OFFSETS.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

const OFFSETS_MIN = [1440, 60]; // 24h, 1h

type EventRow = {
  id: string;
  starts_at: string;
};

type AttendeeRow = {
  contact_id: string;
};

/**
 * Schedule reminders for every attendee on a given event. Safe to call
 * repeatedly — existing rows are reused.
 *
 * Returns the number of *new* reminders created. Does not block on the
 * Inngest emits — those are fire-and-forget; the engine's own retry loop
 * handles transient delivery issues.
 */
export async function scheduleRemindersForEvent(
  eventId: string
): Promise<{ created: number; skipped: number }> {
  const admin = createAdminClient();

  const { data: event } = (await (admin as any)
    .from("events")
    .select("id, starts_at")
    .eq("id", eventId)
    .maybeSingle()) as { data: EventRow | null };
  if (!event) return { created: 0, skipped: 0 };

  const startsMs = new Date(event.starts_at).getTime();

  const { data: attendees } = (await (admin as any)
    .from("event_attendees")
    .select("contact_id")
    .eq("event_id", eventId)) as { data: AttendeeRow[] | null };
  if (!attendees || attendees.length === 0) {
    // No one's on the event yet — nothing to remind. This is the common
    // case for calendar-synced events until the intake portal attaches
    // real contacts; not an error.
    return { created: 0, skipped: 0 };
  }

  let created = 0;
  let skipped = 0;

  for (const a of attendees) {
    for (const offset of OFFSETS_MIN) {
      const sendAt = new Date(startsMs - offset * 60 * 1000);
      // Skip reminders whose send time has already passed — no point
      // scheduling a 24h reminder for something in 2 hours.
      if (sendAt.getTime() < Date.now()) {
        skipped += 1;
        continue;
      }

      // Upsert with ignoreDuplicates so the unique index is the source of
      // truth. We then check whether the row is "fresh" (i.e. we just
      // inserted it) by reading the created_at — if it equals now-ish,
      // we treat it as new and emit the Inngest event.
      const insertRes = (await (admin as any)
        .from("reminders")
        .insert({
          event_id: eventId,
          contact_id: a.contact_id,
          send_at: sendAt.toISOString(),
          offset_minutes: offset,
          channels: ["sms", "email"],
          status: "scheduled",
        })
        .select("id")
        .maybeSingle()) as {
        data: { id: string } | null;
        error: { code?: string; message: string } | null;
      };

      if (insertRes.error) {
        // 23505 = unique violation = already scheduled. Fine, move on.
        if (insertRes.error.code === "23505") {
          skipped += 1;
          continue;
        }
        // Any other error: log but don't throw — we don't want one bad
        // row to block the rest of a sync.
        console.error(
          "[reminders/schedule] insert failed",
          insertRes.error,
          { eventId, contactId: a.contact_id, offset }
        );
        skipped += 1;
        continue;
      }

      if (insertRes.data) {
        created += 1;
        // Emit the Inngest event that will drive the send. If the Inngest
        // event key is unset (dev without the inngest:dev server), this
        // silently no-ops — the row still exists in the DB and a future
        // emit will pick it up.
        try {
          await inngest.send({
            name: "reminder/scheduled",
            data: { reminderId: insertRes.data.id },
          });
        } catch (err) {
          console.error(
            "[reminders/schedule] inngest.send failed",
            err,
            { reminderId: insertRes.data.id }
          );
          // Don't unwind the DB row — a nightly reconciler (todo) can
          // re-emit `reminder/scheduled` for any scheduled rows whose
          // send_at has passed without being dispatched.
        }
      }
    }
  }

  return { created, skipped };
}

/**
 * Cancel all scheduled reminders for an event (e.g. calendar event was
 * deleted or moved more than a few minutes). Emits `reminder/cancelled`
 * so in-flight Inngest runs short-circuit on wake-up.
 */
export async function cancelRemindersForEvent(eventId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: rows } = (await (admin as any)
    .from("reminders")
    .select("id")
    .eq("event_id", eventId)
    .eq("status", "scheduled")) as { data: { id: string }[] | null };
  if (!rows || rows.length === 0) return;

  await (admin as any)
    .from("reminders")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("event_id", eventId)
    .eq("status", "scheduled");

  for (const r of rows) {
    try {
      await inngest.send({
        name: "reminder/cancelled",
        data: { reminderId: r.id },
      });
    } catch (err) {
      // Not fatal — the in-flight function will notice status !== scheduled
      // on wake-up and bail.
      console.error("[reminders/cancel] inngest.send failed", err);
    }
  }
}
