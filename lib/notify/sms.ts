/**
 * Twilio SMS sender.
 *
 * Gated behind SMS_ENABLED. Leave off until A2P 10DLC registration has
 * fully cleared (brand approved AND campaign approved) and a 10DLC phone
 * number is linked to the messaging service. Sending before that gets you
 * silently dropped by carriers with no refund.
 *
 * We prefer the Messaging Service SID over the bare phone number when it's
 * set, because Twilio's sender pool / fallback / STOP compliance are
 * applied at the service level. Configure TWILIO_MESSAGING_SERVICE_SID once
 * the campaign is live and it takes over automatically.
 */
import twilio from "twilio";
import { env } from "@/lib/env";

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

// A real Twilio Messaging Service SID is "MG" + 32 hex chars. Anything
// else (empty string, the placeholder "MGxxxx..." from .env.example, or
// a malformed paste) should be treated as unset so we fall back to the
// bare `from` number instead of handing garbage to Twilio and 21705'ing.
const MG_SID_RE = /^MG[0-9a-fA-F]{32}$/;
function validMessagingServiceSid(): string | null {
  const v = env.TWILIO_MESSAGING_SERVICE_SID;
  if (!v) return null;
  return MG_SID_RE.test(v) ? v : null;
}

export type SmsSendResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** True when we short-circuited because SMS is disabled in this env. */
  skipped?: boolean;
};

export async function sendSms(opts: {
  to: string;
  body: string;
}): Promise<SmsSendResult> {
  if (!env.SMS_ENABLED) {
    return {
      ok: false,
      skipped: true,
      error: "SMS_ENABLED is false — waiting on A2P 10DLC approval",
    };
  }
  if (!opts.to) return { ok: false, error: "no recipient" };

  // E.164 sanity — Twilio accepts variants but silently mis-routes in
  // enough cases that it's worth the 3-line guard.
  if (!/^\+\d{10,15}$/.test(opts.to)) {
    return { ok: false, error: `invalid E.164 number: ${opts.to}` };
  }

  const msgSid = validMessagingServiceSid();

  // Sanity-check that *something* is configured to send from. If neither
  // a valid MG SID nor a TWILIO_SMS_FROM number is set, fail loudly rather
  // than letting Twilio 400 with a cryptic "missing 'from' parameter".
  if (!msgSid && !env.TWILIO_SMS_FROM) {
    return {
      ok: false,
      error:
        "No Twilio sender configured — set TWILIO_MESSAGING_SERVICE_SID (MG…) or TWILIO_SMS_FROM (+1…)",
    };
  }

  try {
    const msg = await client.messages.create({
      to: opts.to,
      body: opts.body,
      ...(msgSid
        ? { messagingServiceSid: msgSid }
        : { from: env.TWILIO_SMS_FROM }),
    });

    return {
      ok: true,
      providerMessageId: msg.sid,
    };
  } catch (err: any) {
    // Twilio error shape: { code, message, status, moreInfo, ... }
    const code = err?.code ? ` [twilio ${err.code}]` : "";
    return {
      ok: false,
      error: (err?.message ?? "sms send failed") + code,
    };
  }
}
