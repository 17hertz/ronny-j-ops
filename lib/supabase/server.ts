import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/supabase";

/**
 * Server-side Supabase client scoped to the current user session. Reads/writes
 * the auth cookies via Next.js `cookies()`. RLS applies to every query.
 *
 * Use this in Server Components, Route Handlers, and Server Actions when you
 * want queries to run as the logged-in user.
 */
export function createClient() {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // `set` throws in Server Components where cookies are readonly.
            // Safe to ignore — middleware will refresh the session on the
            // next request.
          }
        },
      },
    }
  );
}
