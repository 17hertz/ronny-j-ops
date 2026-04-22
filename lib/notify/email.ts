/**
 * Resend email sender.
 *
 * One function: `sendEmail`. Takes a recipient and a pre-rendered body
 * (subject/html/text) and hands it to Resend. We do NOT render templates
 * in here — that's `lib/notify/templates.ts`'s job. Separation keeps the
 * sender reusable for non-reminder transactional mail later (vendor intake
 * confirmations, agent status digests, etc.) without hardcoding reminder
 * logic into the SMTP layer.
 */
import { Resend } from "resend";
import { env } from "@/lib/env";

const client = new Resend(env.RESEND_API_KEY);

export type EmailSendResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
};

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Override the configured reply-to for one-off sends. */
  replyTo?: string;
}): Promise<EmailSendResult> {
  if (!opts.to) return { ok: false, error: "no recipient" };

  const from = `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`;
  const replyTo = opts.replyTo ?? env.RESEND_REPLY_TO;

  try {
    const res = await client.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      // Resend accepts either replyTo (string) or reply_to (legacy). Use
      // the camelCase form the SDK expects.
      ...(replyTo ? { replyTo } : {}),
    });

    if (res.error) {
      return { ok: false, error: res.error.message ?? String(res.error) };
    }
    return {
      ok: true,
      providerMessageId: res.data?.id,
    };
  } catch (err: any) {
    // Network / unexpected failures surface here. We log at the dispatcher
    // layer so the caller has an end-to-end view.
    return { ok: false, error: err?.message ?? "email send failed" };
  }
}
