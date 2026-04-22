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

  const from =
    env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_SMS_FROM;

  try {
    const msg = await client.messages.create({
      to: opts.to,
      body: opts.body,
      ...(env.TWILIO_MESSAGING_SERVICE_SID
        ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID }
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
