/**
 * Unified reminder dispatcher.
 *
 * Call shape:
 *   await sendReminder({ reminderId, kind, contact, event })
 *
 * Steps:
 *   1. Resolve which channel(s) to attempt based on
 *      contact.preferred_channels ∩ channels we actually have credentials
 *      for ∩ valid consent for this contact.
 *   2. For each chosen channel, render the template and hand to the
 *      channel sender. Write a `reminder_dispatches` row per attempt with
 *      the outcome.
 *   3. If the first channel succeeds, we still attempt the remaining ones
 *      if they're on the same reminder (matches what Ronny's real ops team
 *      does — people miss SMS, so a belt-and-braces email is fine).
 *
 * This function is purely transactional — it doesn't own scheduling. The
 * Inngest reminder function is responsible for "when"; this function is
 * responsible for "what".
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import {
  ReminderKind,
  ReminderContext,
  emailBody,
  smsBody,
} from "./templates";

export type DispatchChannel = "sms" | "email" | "whatsapp";

export type ContactInput = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  sms_consent_at: string | null;
  email_consent_at: string | null;
  preferred_channels: string[];
};

export type EventInput = {
  id: string;
  title: string;
  location: string | null;
  starts_at: string;
  timezone: string;
};

export type DispatchOutcome = {
  channel: DispatchChannel;
  ok: boolean;
  skipped?: boolean;
  providerMessageId?: string;
  error?: string;
};

export async function sendReminder(input: {
  reminderId: string;
  kind: ReminderKind;
  contact: ContactInput;
  event: EventInput;
  bookingUrl?: string | null;
}): Promise<DispatchOutcome[]> {
  const admin = createAdminClient();
  const results: DispatchOutcome[] = [];

  const ctx: ReminderContext = {
    recipientName: input.contact.full_name,
    eventTitle: input.event.title,
    startsAtDisplay: formatEventTime(input.event.starts_at, input.event.timezone),
    location: input.event.location,
    bookingUrl: input.bookingUrl ?? null,
  };

  // Channel resolution: honor preference order, but only attempt a channel
  // if we have both (a) contact info for it and (b) explicit consent.
  const channels = resolveChannels(input.contact);

  for (const channel of channels) {
    const out = await dispatch(channel, input.kind, input.contact, ctx);
    results.push(out);
    await recordDispatch(admin, input.reminderId, out);
  }

  // If at least one channel succeeded, mark the reminder sent. If all
  // failed (including "skipped"), leave it failed so the Inngest retry
  // can take another pass (or an operator can investigate).
  const anySent = results.some((r) => r.ok);
  const status = anySent ? "sent" : "failed";
  await (admin as any)
    .from("reminders")
    .update({
      status,
      last_error: anySent
        ? null
        : results.find((r) => !r.ok && !r.skipped)?.error ??
          results.find((r) => r.skipped)?.error ??
          "no channels available",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.reminderId);

  return results;
}

function resolveChannels(c: ContactInput): DispatchChannel[] {
  const out: DispatchChannel[] = [];
  for (const pref of c.preferred_channels) {
    if (pref === "sms" && c.phone && c.sms_consent_at) out.push("sms");
    if (pref === "email" && c.email && c.email_consent_at) out.push("email");
    // whatsapp not yet wired — intentional.
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

async function dispatch(
  channel: DispatchChannel,
  kind: ReminderKind,
  contact: ContactInput,
  ctx: ReminderContext
): Promise<DispatchOutcome> {
  if (channel === "email") {
    const body = emailBody(kind, ctx);
    const r = await sendEmail({
      to: contact.email!,
      subject: body.subject,
      html: body.html,
      text: body.text,
    });
    return {
      channel,
      ok: r.ok,
      providerMessageId: r.providerMessageId,
      error: r.error,
    };
  }
  if (channel === "sms") {
    const body = smsBody(kind, { ...ctx, stopInstructions: true });
    const r = await sendSms({ to: contact.phone!, body });
    return {
      channel,
      ok: r.ok,
      skipped: r.skipped,
      providerMessageId: r.providerMessageId,
      error: r.error,
    };
  }
  return { channel, ok: false, error: `unsupported channel: ${channel}` };
}

async function recordDispatch(
  admin: ReturnType<typeof createAdminClient>,
  reminderId: string,
  out: DispatchOutcome
): Promise<void> {
  const status = out.ok
    ? "sent"
    : out.skipped
      ? "opted_out" // reusing the enum — "skipped" isn't a member; opted_out is the closest semantic fit for "we chose not to send"
      : "failed";
  await (admin as any).from("reminder_dispatches").insert({
    reminder_id: reminderId,
    channel: out.channel,
    status,
    provider_message_id: out.providerMessageId ?? null,
    error: out.error ?? null,
    sent_at: out.ok ? new Date().toISOString() : null,
  });
}

/**
 * Render an event time as "Fri Apr 24, 3:00pm ET" in the event's own zone.
 * Using the event's zone (not the viewer's) matches what SMS recipients
 * will see on the ground — a session at "3pm LA time" should read "3pm PT"
 * in the reminder regardless of where Ronny is when the send fires.
 */
function formatEventTime(iso: string, tz: string): string {
  const d = new Date(iso);
  const zone = tz || "America/New_York";
  const date = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: zone,
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  });
  // Abbreviate the zone — e.g. America/New_York → ET when rendered.
  const zoneShort = d
    .toLocaleTimeString("en-US", { timeZone: zone, timeZoneName: "short" })
    .split(" ")
    .pop();
  return `${date}, ${time} ${zoneShort ?? ""}`.trim();
}
