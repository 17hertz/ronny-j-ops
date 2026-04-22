import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

/**
 * Service-role Supabase client. BYPASSES RLS. Use only in:
 *   - Inngest functions (sending reminders, marking dispatches)
 *   - Webhook handlers that don't run in a user context (Twilio status,
 *     Google Calendar push, Resend bounce)
 *   - Vendor intake portal submissions (no logged-in user)
 *
 * NEVER import this from a client component.
 * NEVER pass the service-role key to the browser.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}
