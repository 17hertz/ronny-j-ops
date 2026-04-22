import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { buildAuthUrl } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

/**
 * Kicks off Google OAuth. Only signed-in team members may call this;
 * unauthenticated hits go to /login.
 *
 * We issue a signed state cookie here and verify it in the callback so a
 * stray redirect from another tab can't trick us into binding tokens to the
 * wrong user.
 */
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(
      new URL(
        "/login?next=/dashboard",
        process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"
      )
    );
  }

  const state = randomBytes(24).toString("hex");

  cookies().set("google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10, // 10 minutes
  });

  return NextResponse.redirect(buildAuthUrl(state));
}
