import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-link landing URL. Supabase redirects the user's browser here with
 * `?code=...`; we exchange the code for a session cookie and then bounce the
 * user to `next` (default: /dashboard).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, url.origin));
    }
  }

  // Anything goes wrong: kick them back to /login with a generic error flag.
  return NextResponse.redirect(new URL("/login?error=1", url.origin));
}
