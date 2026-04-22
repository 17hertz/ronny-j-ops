/**
 * Typed env-var access with validation.
 *
 * Fail fast at server boot rather than at the moment a reminder tries to
 * send. Missing Twilio creds at 2am is a bad time to discover the problem.
 */
import { z } from "zod";

const serverSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url(),

  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Inngest
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC"),
  TWILIO_AUTH_TOKEN: z.string().min(10),
  TWILIO_SMS_FROM: z.string().regex(/^\+\d{10,15}$/),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),

  // Resend
  RESEND_API_KEY: z.string().startsWith("re_"),
  RESEND_FROM_EMAIL: z.string().email(),
  RESEND_FROM_NAME: z.string().default("Ronny J Ops"),

  // Google
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),

  // Shared secret
  WEBHOOK_SECRET: z.string().min(16),
});

const clientSchema = serverSchema.pick({
  NEXT_PUBLIC_SITE_URL: true,
  NEXT_PUBLIC_SUPABASE_URL: true,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: true,
});

function parseEnv() {
  // On the server, validate the full schema. On the client, only the
  // NEXT_PUBLIC_* values are available — validate just those.
  const isServer = typeof window === "undefined";
  const schema = isServer ? serverSchema : clientSchema;
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    console.error(
      "Invalid environment variables:",
      parsed.error.flatten().fieldErrors
    );
    throw new Error("Invalid environment variables — see server logs.");
  }
  return parsed.data;
}

export const env = parseEnv();
