/**
 * Reminder copy — one file per channel shape, one source of truth.
 *
 * All SMS samples match what we submitted to A2P 10DLC so our production
 * sends match the campaign registration exactly. Don't freestyle new wording
 * here without also updating the Twilio campaign, or carriers will flag it.
 *
 * Email copy is more conversational; we aren't subject to the same carrier
 * review. The plain-text alternative is the same prose, un-styled.
 */

export type ReminderKind =
  | "confirm" // "your session is booked"
  | "remind_24h" // 24 hours out
  | "remind_1h" // 1 hour out
  | "reschedule" // we moved it
  | "cancel"; // called off

/**
 * What the dispatcher passes to each template. Keep this small — everything
 * bigger (addresses, booking links) should come off the event itself so we
 * don't drift between templates.
 */
export type ReminderContext = {
  recipientName: string;
  eventTitle: string;
  startsAtDisplay: string; // e.g. "Fri Apr 24, 3:00pm ET"
  location: string | null;
  bookingUrl: string | null; // deep link to session details
  stopInstructions?: boolean; // include "Reply STOP" (SMS only)
};

// -------------------------------------------------------------------------
// SMS
// -------------------------------------------------------------------------

/**
 * Keep each variant under ~320 chars so it fits in a 2-segment SMS. Matching
 * the samples we registered with carriers reduces filtering risk.
 */
export function smsBody(kind: ReminderKind, ctx: ReminderContext): string {
  const stop = ctx.stopInstructions !== false ? " Reply STOP to opt out." : "";
  const where = ctx.location ? ` at ${ctx.location}` : "";

  switch (kind) {
    case "confirm":
      return `17 Hertz: Session confirmed with Ronny J on ${ctx.startsAtDisplay}${where}. We'll send a reminder 24h before.${stop}`;
    case "remind_24h":
      return `17 Hertz: Reminder — your Ronny J session is ${ctx.startsAtDisplay}${where}.${stop}`;
    case "remind_1h":
      return `17 Hertz: Your Ronny J session starts in 1 hour${where}.${stop}`;
    case "reschedule":
      return `17 Hertz: Your Ronny J session has been rescheduled to ${ctx.startsAtDisplay}${where}.${stop}`;
    case "cancel":
      return `17 Hertz: Your Ronny J session on ${ctx.startsAtDisplay} has been cancelled. We'll reach out to reschedule.${stop}`;
  }
}

// -------------------------------------------------------------------------
// Email
// -------------------------------------------------------------------------

export type EmailBody = {
  subject: string;
  html: string;
  text: string;
};

/**
 * Email template. Returns HTML + plain-text alternatives; Resend expects
 * both and we want both so text-only clients don't get a blank message.
 *
 * Styling is intentionally plain (system fonts, muted palette) — the goal
 * is high deliverability, not a brand moment. Too much markup triggers
 * spam filters on cold domains.
 */
export function emailBody(
  kind: ReminderKind,
  ctx: ReminderContext
): EmailBody {
  const headline = headlineFor(kind, ctx);
  const body = bodyFor(kind, ctx);

  const link =
    ctx.bookingUrl &&
    `<p style="margin:24px 0"><a href="${escapeAttr(
      ctx.bookingUrl
    )}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font:500 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">View session details</a></p>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f7f7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;max-width:100%">
        <tr><td>
          <p style="margin:0 0 8px;font:500 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#888">17 Hertz</p>
          <h1 style="margin:0 0 20px;font:600 24px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${escapeHtml(
            headline
          )}</h1>
          <p style="margin:0 0 16px">Hi ${escapeHtml(ctx.recipientName)},</p>
          <p style="margin:0 0 16px">${body}</p>
          ${detailsTable(ctx)}
          ${link ?? ""}
          <p style="margin:32px 0 0;color:#888;font-size:13px">— Ronny J / 17 Hertz</p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#999">17 Hertz Inc. · ronnyj.17hertz.com</p>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    headline,
    "",
    `Hi ${ctx.recipientName},`,
    "",
    plainText(body),
    "",
    `When: ${ctx.startsAtDisplay}`,
    ctx.location ? `Where: ${ctx.location}` : null,
    ctx.bookingUrl ? `Details: ${ctx.bookingUrl}` : null,
    "",
    "— Ronny J / 17 Hertz",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject: subjectFor(kind, ctx),
    html,
    text,
  };
}

function subjectFor(kind: ReminderKind, ctx: ReminderContext): string {
  switch (kind) {
    case "confirm":
      return `Session confirmed — ${ctx.startsAtDisplay}`;
    case "remind_24h":
      return `Reminder: session tomorrow with Ronny J`;
    case "remind_1h":
      return `Session in 1 hour with Ronny J`;
    case "reschedule":
      return `Your session has been rescheduled`;
    case "cancel":
      return `Session cancelled — ${ctx.startsAtDisplay}`;
  }
}

function headlineFor(kind: ReminderKind, ctx: ReminderContext): string {
  switch (kind) {
    case "confirm":
      return "Your session is confirmed.";
    case "remind_24h":
      return "Your session is tomorrow.";
    case "remind_1h":
      return "Your session starts in 1 hour.";
    case "reschedule":
      return "Your session has been rescheduled.";
    case "cancel":
      return "Your session has been cancelled.";
  }
}

function bodyFor(kind: ReminderKind, ctx: ReminderContext): string {
  switch (kind) {
    case "confirm":
      return `You're booked with Ronny J. We'll send a reminder 24 hours before, and another 1 hour out.`;
    case "remind_24h":
      return `This is a heads-up that your session with Ronny J is tomorrow.`;
    case "remind_1h":
      return `Quick reminder that your session with Ronny J is in about an hour.`;
    case "reschedule":
      return `Heads up — the time for your session with Ronny J has moved. Updated details below.`;
    case "cancel":
      return `Your session with Ronny J has been cancelled. We'll reach out to set up a new time.`;
  }
}

function detailsTable(ctx: ReminderContext): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#888;width:80px">${escapeHtml(
      label
    )}</td><td style="padding:6px 0">${escapeHtml(value)}</td></tr>`;
  const rows = [
    row("When", ctx.startsAtDisplay),
    ctx.location ? row("Where", ctx.location) : null,
    row("Session", ctx.eventTitle),
  ].filter(Boolean);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;font-size:15px;border-top:1px solid #eee;border-bottom:1px solid #eee;padding:4px 0">${rows.join(
    ""
  )}</table>`;
}

// -------------------------------------------------------------------------
// Voice — short TwiML-safe script
// -------------------------------------------------------------------------

/**
 * Plain text we feed into Twilio's <Say>. Keep it under ~30 seconds at
 * normal cadence (~80 words). Punctuation becomes pauses when read aloud,
 * which helps comprehension on a noisy phone line.
 */
export function voiceScript(kind: ReminderKind, ctx: ReminderContext): string {
  const where = ctx.location ? ` at ${ctx.location}` : "";
  switch (kind) {
    case "remind_24h":
      return `Hi ${ctx.recipientName}, this is 17 Hertz. Just a reminder that your session with Ronny J is ${ctx.startsAtDisplay}${where}. See you then.`;
    case "remind_1h":
      return `Hi ${ctx.recipientName}, this is 17 Hertz. Your session with Ronny J${where} starts in about one hour. See you soon.`;
    case "confirm":
      return `Hi ${ctx.recipientName}, this is 17 Hertz. Your session with Ronny J is confirmed for ${ctx.startsAtDisplay}. Goodbye.`;
    case "reschedule":
      return `Hi ${ctx.recipientName}, this is 17 Hertz. Your session with Ronny J has been rescheduled to ${ctx.startsAtDisplay}. Check your email for the full details. Goodbye.`;
    case "cancel":
      return `Hi ${ctx.recipientName}, this is 17 Hertz. Your session with Ronny J on ${ctx.startsAtDisplay} has been cancelled. We will reach out to reschedule. Goodbye.`;
  }
}

// -------------------------------------------------------------------------
// escaping helpers
// -------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
function plainText(htmlish: string): string {
  // Strip any stray tags just in case a body ever contains inline markup.
  return htmlish.replace(/<[^>]+>/g, "");
}
