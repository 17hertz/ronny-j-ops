/**
 * Twilio WhatsApp sender — sibling to lib/notify/sms.ts.
 *
 * Why a separate file: WhatsApp uses a different `from` env var
 * (TWILIO_WHATSAPP_FROM, prefixed `whatsapp:`), has its own opt-in rules,
 * and in the Twilio sandbox has different delivery semantics than SMS.
 * Keeping it separate avoids conditional branches clogging sms.ts.
 *
 * Sandbox caveats (development-only, free):
 *   - Recipient must have opted in by texting the sandbox's join phrase
 *     (e.g. "join <code>") to whatsapp:+14155238886 from their phone.
 *   - Opt-in is good for 72h after the recipient's most recent inbound
 *     message; free-form outbound messages work within that window.
 *   - After 24h of recipient silence, outbound must be an approved
 *     template. For daily-digest purposes this is fine because the user
 *     can always message "hi" back to reset the window.
 *
 * Production path: replace TWILIO_WHATSAPP_FROM with a verified WABA
 * sender SID/number. Delivery semantics stay identical from this function's
 * perspective — only the env var changes.
 *
 * NB: WhatsApp is intentionally NOT gated on SMS_ENABLED. That flag tracks
 * A2P 10DLC / toll-free approval on the SMS side. WhatsApp has its own
 * approval ladder and shouldn't be coupled to it.
 */
import twilio from "twilio";
import { env } from "@/lib/env";

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

export type WhatsAppSendResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
};

/**
 * Send a WhatsApp message. `to` should be an E.164 number without the
 * `whatsapp:` prefix — we add it here so call sites look identical to
 * the SMS path.
 */
export async function sendWhatsApp(opts: {
  to: string;
  body: string;
}): Promise<WhatsAppSendResult> {
  if (!opts.to) return { ok: false, error: "no recipient" };

  // Same E.164 check as sms.ts — Twilio accepts variants but mis-routes
  // quietly enough that a guard is worth the three lines.
  if (!/^\+\d{10,15}$/.test(opts.to)) {
    return { ok: false, error: `invalid E.164 number: ${opts.to}` };
  }

  const from = env.TWILIO_WHATSAPP_FROM;
  if (!from) {
    return {
      ok: false,
      error:
        "TWILIO_WHATSAPP_FROM not configured — set to 'whatsapp:+14155238886' (sandbox) or your WABA sender",
    };
  }
  if (!from.startsWith("whatsapp:")) {
    return {
      ok: false,
      error: `TWILIO_WHATSAPP_FROM must start with 'whatsapp:' — got "${from}"`,
    };
  }

  try {
    const msg = await client.messages.create({
      to: `whatsapp:${opts.to}`,
      from,
      body: opts.body,
    });
    return { ok: true, providerMessageId: msg.sid };
  } catch (err: any) {
    // Twilio error shape: { code, message, status, moreInfo, ... }
    // Common WA errors:
    //   63016 — "outside the 24-hour session, need an approved template"
    //   63018 — channel-specific rate limit
    //   63007 — destination hasn't opted into the sandbox
    const code = err?.code ? ` [twilio ${err.code}]` : "";
    return {
      ok: false,
      error: (err?.message ?? "whatsapp send failed") + code,
    };
  }
}
