/**
 * Inngest webhook handler.
 *
 * Inngest Cloud calls this route to:
 *   - Sync the function registry (`PUT`) — so the dashboard knows what
 *     functions exist and their triggers.
 *   - Execute function steps (`POST`) — one step per request, signed with
 *     the signing key.
 *
 * The `serve()` helper handles GET/PUT/POST automatically. We re-export
 * all three.
 */
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";

// Each step invocation is its own HTTP call. Give it headroom — Twilio +
// Resend are usually sub-second but can spike to a few seconds under load.
export const maxDuration = 60;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
  // Only set in prod. Inngest's SDK reads INNGEST_SIGNING_KEY from env
  // when unspecified, but being explicit makes the wiring easy to audit.
  signingKey: process.env.INNGEST_SIGNING_KEY,
});
