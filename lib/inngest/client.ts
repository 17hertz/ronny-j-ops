/**
 * Inngest client singleton.
 *
 * We use Inngest (not a plain Vercel cron) for reminders because:
 *   - Each reminder needs to fire at a precise per-event time, not a
 *     schedule — a 3pm session reminder going out at 2pm isn't useful.
 *   - Inngest's `step.sleepUntil` holds the job until exactly send_at
 *     without consuming server resources, and persists across deploys.
 *   - Retry/backoff on per-step failure is first-class, so a transient
 *     Twilio outage doesn't drop a reminder silently.
 *
 * In dev: leave INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY blank and run
 * `npm run inngest:dev` to hit http://localhost:8288. In prod: both are
 * required and injected by Inngest Cloud.
 */
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "ronny-j-ops",
  // Optional in dev; mandatory in prod. The server-side SDK reads these
  // from env itself when not passed explicitly.
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// -------------------------------------------------------------------------
// Event type contracts.
//
// Keeping these typed here (rather than inline at each emit site) means
// when we rename a payload field, TypeScript yells at every call site.
// -------------------------------------------------------------------------
export type InngestEvents = {
  /**
   * Emitted by `lib/google/sync.ts` after an event is upserted, and by the
   * intake portal when an attendee is added. The Inngest function reads
   * the reminder row by id and sleeps until `send_at`.
   */
  "reminder/scheduled": {
    data: {
      reminderId: string;
    };
  };
  /**
   * Emitted when an event is deleted or moved so a previously-scheduled
   * reminder can be cancelled. The Inngest function checks the reminder
   * status on wake-up and no-ops if cancelled.
   */
  "reminder/cancelled": {
    data: {
      reminderId: string;
    };
  };
};
