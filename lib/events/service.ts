/**
 * Unified events service — parallel to lib/tasks/service.ts.
 *
 * Every caller that creates or updates a calendar event goes through
 * here:
 *   - Dashboard "new event" form (not built yet)
 *   - SMS / WhatsApp dispatcher ("add lunch w/ Mike Friday 1pm")
 *   - Claude agent chat tool (future)
 *   - Google Calendar pull sync (reads into events table directly; that
 *     path is its own upsert flow in lib/google/sync.ts and does NOT
 *     go through this service)
 *
 * Writes land in public.events with push_status='pending', then an
 * Inngest event fires so the Google Calendar writer worker propagates.
 * Callers get back the local row immediately — the Google push is
 * out-of-band so the HTTP response time isn't held hostage by Google's
 * latency.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export type EventSource =
  | "google"
  | "manual"
  | "agent"
  | "sms"
  | "whatsapp"
  | "email"
  | "dashboard";

export type EventRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  source: EventSource;
  google_calendar_id: string | null;
  google_event_id: string | null;
  google_account_id: string | null;
  etag: string | null;
  push_status: "pending" | "pushed" | "error" | "skip";
  push_error: string | null;
  last_push_attempt_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Create a local event and queue a Google Calendar push.
 *
 * `endsAt` defaults to `startsAt + 1 hour` when omitted — matches
 * Google Calendar's default behavior for quick-add events and is what
 * users expect from SMS commands like "lunch at 1pm."
 *
 * `timezone` defaults to America/New_York — the operational zone for
 * this app. Callers can override when the user explicitly names a zone.
 */
export async function createEvent(opts: {
  teamMemberId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  /** ISO timestamp — will be interpreted in `timezone` on the Google side. */
  startsAt: string;
  /** ISO timestamp. Defaults to startsAt + 1 hour. */
  endsAt?: string | null;
  timezone?: string;
  source: EventSource;
  /** Default true. Set false for local-only events. */
  pushToGoogle?: boolean;
}): Promise<EventRow> {
  const admin = createAdminClient();
  const pushToGoogle = opts.pushToGoogle ?? true;
  const tz = opts.timezone ?? "America/New_York";

  const startsAt = opts.startsAt;
  const endsAt =
    opts.endsAt ??
    new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString();

  const { data, error } = (await (admin as any)
    .from("events")
    .insert({
      title: opts.title.trim(),
      description: opts.description?.trim() || null,
      location: opts.location?.trim() || null,
      starts_at: startsAt,
      ends_at: endsAt,
      timezone: tz,
      source: opts.source,
      created_by: opts.teamMemberId,
      push_status: pushToGoogle ? "pending" : "skip",
    })
    .select("*")
    .single()) as {
    data: EventRow | null;
    error: { message: string } | null;
  };

  if (error || !data) {
    throw new Error(`createEvent failed: ${error?.message ?? "no row"}`);
  }

  if (pushToGoogle) {
    try {
      await inngest.send({
        name: "event/push-to-google-calendar",
        data: { eventId: data.id, teamMemberId: opts.teamMemberId },
      });
    } catch (err) {
      console.error("[events/service] inngest emit failed", err);
    }
  }

  return data;
}

/**
 * Patch an existing event. Re-queues a Google push because any
 * user-visible change should propagate.
 */
export async function updateEvent(opts: {
  eventId: string;
  title?: string;
  description?: string | null;
  location?: string | null;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  teamMemberId: string;
}): Promise<EventRow> {
  const admin = createAdminClient();

  const patch: Record<string, unknown> = {
    push_status: "pending",
    last_push_attempt_at: null,
    push_error: null,
  };
  if (opts.title !== undefined) patch.title = opts.title.trim();
  if (opts.description !== undefined)
    patch.description = opts.description?.trim() || null;
  if (opts.location !== undefined)
    patch.location = opts.location?.trim() || null;
  if (opts.startsAt !== undefined) patch.starts_at = opts.startsAt;
  if (opts.endsAt !== undefined) patch.ends_at = opts.endsAt;
  if (opts.timezone !== undefined) patch.timezone = opts.timezone;

  const { data, error } = (await (admin as any)
    .from("events")
    .update(patch)
    .eq("id", opts.eventId)
    .select("*")
    .single()) as {
    data: EventRow | null;
    error: { message: string } | null;
  };

  if (error || !data) {
    throw new Error(`updateEvent failed: ${error?.message ?? "no row"}`);
  }

  if (data.push_status !== "skip") {
    try {
      await inngest.send({
        name: "event/push-to-google-calendar",
        data: { eventId: data.id, teamMemberId: opts.teamMemberId },
      });
    } catch (err) {
      console.error("[events/service] inngest emit failed", err);
    }
  }

  return data;
}
