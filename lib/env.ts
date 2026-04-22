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
  // Replies to the From address bounce into Resend's logs; set this to a
  // real mailbox so a human sees them (e.g. a client texting "running late").
  RESEND_REPLY_TO: z.string().email().optional(),

  // Feature flags — SMS stays off until A2P 10DLC registration clears.
  SMS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // Google
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),

  // Shared secret
  WEBHOOK_SECRET: z.string().min(16),

  // 32-byte symmetric key for encrypting vendor PII (EIN, ACH details).
  // Provide as 64-char hex or 44-char base64. Rotating this invalidates
  // every existing encrypted column — migrate rows first.
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => /^[0-9a-fA-F]{64}$/.test(v) || v.length >= 43, {
      message: "ENCRYPTION_KEY must be 64-char hex or base64-encoded 32 bytes",
    }),
});

const clientSchema = serverSchema.pick({
  NEXT_PUBLIC_SITE_URL: true,
  NEXT_PUBLIC_SUPABASE_URL: true,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: true,
});

/**
 * Type-wise we always return the full server schema so consumers can access
 * `env.RESEND_API_KEY` etc. without a narrowing cast at every call site.
 * At runtime:
 *   - On the server: fully validated.
 *   - On the client: only the NEXT_PUBLIC_* fields are populated (the rest
 *     are `undefined`). That's fine because server-only modules aren't
 *     imported into the browser bundle — Next.js's build catches any leak.
 */
type Env = z.infer<typeof serverSchema>;

function parseEnv(): Env {
  const isServer = typeof window === "undefined";
  if (isServer) {
    const parsed = serverSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error(
        "Invalid environment variables:",
        parsed.error.flatten().fieldErrors
      );
      throw new Error("Invalid environment variables — see server logs.");
    }
    return parsed.data;
  }

  // Client: validate just the public subset, then widen to the server
  // shape so TypeScript consumers don't need per-callsite casts. Accessing
  // a server-only key here returns `undefined` at runtime.
  const parsed = clientSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error("Invalid client environment variables");
  }
  return parsed.data as unknown as Env;
}

export const env = parseEnv();
