/**
 * POST /api/webhooks/twilio/inbound
 *
 * Twilio calls this endpoint for every inbound SMS or WhatsApp message.
 * We:
 *   1. Verify X-Twilio-Signature. Reject 403 if bad.
 *   2. Normalize From (strip 'whatsapp:' prefix).
 *   3. Look up team_members by phone. Unknown sender → canned reply.
 *   4. Rate-limit check. Over limit → canned reply, no LLM call.
 *   5. Pre-parse short-circuit for help / stop / digest keywords
 *      (doesn't burn an LLM call on trivia).
 *   6. Claude Haiku parser → intent + slots.
 *   7. Dispatch to the right handler → reply text.
 *   8. Audit the full exchange in sms_messages.
 *   9. Reply via TwiML (same HTTP leg — no outbound API call, so we
 *      don't have to pass the toll-free / TFV gate).
 *
 * Twilio configuration: the Messaging Service for your numbers should
 * point to {PUBLIC_ORIGIN}/api/webhooks/twilio/inbound for both SMS and
 * WhatsApp. The signature verification uses the full request URL that
 * Twilio signed with, so we reconstruct it from x-forwarded-proto/host.
 *
 * STOP compliance: Twilio handles STOP / UNSUBSCRIBE at the
 * Messaging-Service level automatically. We intentionally don't handle
 * STOP here — replying would actually complicate compliance. Let Twilio
 * do its job and just not respond when we see STOP.
 */
import { NextResponse } from "next/server";
import twilio from "twilio";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseIntent, type ParsedIntent } from "@/lib/actions/parse";
import { dispatchIntent } from "@/lib/actions/dispatch";

export const dynamic = "force-dynamic";
// Inbound: signature verify + audit write + Haiku call + dispatch + audit
// update. Usually ~1.5s. Give it 30 to weather spikes.
export const maxDuration = 30;

// Rolling window cap — keeps cost attacks from spamming the LLM parser.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 30; // per-phone per-hour

export async function POST(request: Request) {
  // ---- 1. Parse form + verify signature ------------------------------
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const signature = request.headers.get("x-twilio-signature") ?? "";

  const fullUrl = reconstructRequestUrl(request);
  const isValid = twilio.validateRequest(
    env.TWILIO_AUTH_TOKEN,
    signature,
    fullUrl,
    params
  );

  if (!isValid) {
    console.warn("[twilio/inbound] signature mismatch", {
      url: fullUrl,
      from: params.From,
    });
    return new NextResponse("invalid signature", { status: 403 });
  }

  const rawFrom = String(params.From ?? "");
  const rawTo = String(params.To ?? "");
  const body = String(params.Body ?? "").trim();
  const twilioSid = String(params.MessageSid ?? "");

  // Determine channel from the From prefix — WhatsApp senders come in
  // as "whatsapp:+14155551234"; SMS as bare "+14155551234".
  const channel: "sms" | "whatsapp" = rawFrom.startsWith("whatsapp:")
    ? "whatsapp"
    : "sms";
  const fromE164 = rawFrom.replace(/^whatsapp:/, "");

  const admin = createAdminClient();

  // ---- 2. Idempotence: same MessageSid won't create duplicate rows.
  // Unique index on sms_messages.twilio_sid enforces this; we surface
  // the 23505 and return early with 200 so Twilio stops retrying.
  // ---- 3. Find the sender (if they're one of us).
  const { data: member } = (await (admin as any)
    .from("team_members")
    .select("id, full_name, sms_command_enabled, timezone")
    .eq("phone", fromE164)
    .maybeSingle()) as {
    data: {
      id: string;
      full_name: string;
      sms_command_enabled: boolean;
      timezone: string;
    } | null;
  };

  // Unknown sender — canned reply, no LLM, no audit-body storage concerns.
  if (!member) {
    await auditInbound(admin, {
      channel,
      fromE164,
      toNumber: rawTo,
      body,
      twilioSid,
      teamMemberId: null,
      intent: null,
      slots: null,
      actionStatus: "ignored",
      replyText: null,
      error: "unknown_sender",
    });
    return twimlReply(
      "Sorry — this number isn't registered for Ronny J Ops commands."
    );
  }

  // Sender known but not opted in — don't run any commands for them even
  // though the audit log remembers the attempt.
  if (!member.sms_command_enabled) {
    await auditInbound(admin, {
      channel,
      fromE164,
      toNumber: rawTo,
      body,
      twilioSid,
      teamMemberId: member.id,
      intent: null,
      slots: null,
      actionStatus: "ignored",
      replyText: null,
      error: "sms_command_disabled",
    });
    return twimlReply(
      "SMS commands aren't enabled for your account. Ask Jason to flip sms_command_enabled on."
    );
  }

  // ---- 4. Rate limit ------------------------------------------------
  const rateLimited = await checkAndBumpRateLimit(admin, fromE164);
  if (rateLimited) {
    await auditInbound(admin, {
      channel,
      fromE164,
      toNumber: rawTo,
      body,
      twilioSid,
      teamMemberId: member.id,
      intent: null,
      slots: null,
      actionStatus: "ignored",
      replyText: null,
      error: "rate_limited",
    });
    return twimlReply(
      "Too many messages in the last hour. Try again in a bit."
    );
  }

  // ---- 5. STOP: Twilio handles it at the Messaging Service level.
  // Just don't reply — replying can confuse compliance.
  if (/^\s*stop(\s|$)/i.test(body) || /^\s*unsubscribe/i.test(body)) {
    return new NextResponse("<Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  // Sender's timezone drives parser date-math ("tomorrow noon") AND
  // digest / confirmation rendering. Falls back to the operational
  // default if the row predates the column.
  const senderTz = member.timezone || "America/New_York";

  // ---- 6. Short-circuit common keywords (no LLM burn) --------------
  // Pre-detect the 'claude '/'gpt ' prefixes here so we don't spend a
  // Haiku parse call classifying them — they're unambiguous. The rest
  // of the body after the prefix is the actual question.
  const lowered = body.toLowerCase().trim();
  let intent: ParsedIntent;
  const claudeMatch = body.match(/^\s*claude\s+(.+)$/is);
  const gptMatch = body.match(/^\s*gpt\s+(.+)$/is);
  if (claudeMatch) {
    intent = { kind: "ask_claude", question: claudeMatch[1].trim() };
  } else if (gptMatch) {
    intent = { kind: "ask_gpt", question: gptMatch[1].trim() };
  } else if (/^\s*help\s*$/.test(lowered) || /^\s*\?\s*$/.test(lowered)) {
    intent = { kind: "help" };
  } else if (
    /^(what'?s (on |up )?(today|on today|happening)|digest|today)\??$/i.test(lowered)
  ) {
    intent = { kind: "get_digest" };
  } else {
    // ---- 7. Full parser -------------------------------------------
    intent = await parseIntent(body, { senderTz });
  }

  // ---- 8. Dispatch -------------------------------------------------
  const outcome = await dispatchIntent(intent, member.id, senderTz);

  // ---- 9. Audit + reply --------------------------------------------
  await auditInbound(admin, {
    channel,
    fromE164,
    toNumber: rawTo,
    body,
    twilioSid,
    teamMemberId: member.id,
    intent: outcome.intent,
    slots: intent, // the full parsed intent as JSON — useful for debugging
    actionStatus: outcome.actionStatus,
    replyText: outcome.replyText,
    error: outcome.error ?? null,
    actionArtifactId: outcome.artifactId ?? null,
  });

  return twimlReply(outcome.replyText);
}

/**
 * Build the URL Twilio signed against. Vercel terminates TLS at the
 * edge, so `request.url` shows http:// inside the function — we have
 * to reconstruct with x-forwarded-proto. Also trust x-forwarded-host.
 */
function reconstructRequestUrl(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

/**
 * Send a TwiML reply — same HTTP leg Twilio used for the webhook, so
 * no outbound API call needed. This is key: our toll-free number is
 * still TFV-pending, but TwiML replies are delivered on the same
 * message session and don't re-trigger the carrier filter.
 */
function twimlReply(text: string): NextResponse {
  const safe = escapeXml(text);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
  return new NextResponse(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Per-phone rolling-window rate limit. Returns true if THIS message
 * should be rejected as over-limit, false otherwise. Also increments
 * the counter as a side effect so the next message inside the window
 * sees the new count.
 */
async function checkAndBumpRateLimit(
  admin: ReturnType<typeof createAdminClient>,
  phone: string
): Promise<boolean> {
  const now = new Date();
  const { data } = (await (admin as any)
    .from("sms_rate_limits")
    .select("phone, window_start, count")
    .eq("phone", phone)
    .maybeSingle()) as {
    data: { phone: string; window_start: string; count: number } | null;
  };

  if (!data) {
    await (admin as any).from("sms_rate_limits").insert({
      phone,
      window_start: now.toISOString(),
      count: 1,
    });
    return false;
  }

  const windowExpired =
    now.getTime() - new Date(data.window_start).getTime() > RATE_LIMIT_WINDOW_MS;

  if (windowExpired) {
    await (admin as any)
      .from("sms_rate_limits")
      .update({ window_start: now.toISOString(), count: 1 })
      .eq("phone", phone);
    return false;
  }

  if (data.count >= RATE_LIMIT_MAX) return true;

  await (admin as any)
    .from("sms_rate_limits")
    .update({ count: data.count + 1 })
    .eq("phone", phone);
  return false;
}

/**
 * Write an sms_messages audit row. The unique index on twilio_sid means
 * a retried webhook becomes a no-op insert (we swallow the 23505) —
 * caller's existing reply is still accurate and returned to Twilio.
 */
async function auditInbound(
  admin: ReturnType<typeof createAdminClient>,
  opts: {
    channel: "sms" | "whatsapp";
    fromE164: string;
    toNumber: string;
    body: string;
    twilioSid: string;
    teamMemberId: string | null;
    intent: string | null;
    slots: unknown | null;
    actionStatus: "done" | "error" | "ignored";
    replyText: string | null;
    error: string | null;
    actionArtifactId?: string | null;
  }
): Promise<void> {
  const row: Record<string, unknown> = {
    direction: "in",
    channel: opts.channel,
    from_number: opts.fromE164,
    to_number: opts.toNumber,
    body: opts.body.slice(0, 1600), // SMS segment ceiling
    twilio_sid: opts.twilioSid,
    team_member_id: opts.teamMemberId,
    intent: opts.intent,
    intent_slots: opts.slots as any,
    action_status: opts.actionStatus,
    reply_text: opts.replyText,
    error: opts.error,
  };
  if (opts.actionArtifactId !== undefined) {
    row.action_artifact_id = opts.actionArtifactId;
  }
  const { error } = await (admin as any).from("sms_messages").insert(row);
  if (error && !String(error.code ?? "").startsWith("23505")) {
    // Not a uniqueness violation — log it, but don't fail the webhook
    // because audit isn't the user's problem.
    console.error("[twilio/inbound] audit insert failed", error);
  }
}
