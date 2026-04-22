import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  exchangeCodeForTokens,
  fetchGoogleEmail,
} from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

/**
 * Google redirects the user here after they approve (or decline) access on
 * the consent screen. We:
 *   1. Verify the `state` cookie matches `?state=`.
 *   2. Exchange the auth code for access + refresh tokens.
 *   3. Look up which team_member this corresponds to using the *user-session*
 *      Supabase client (RLS applies).
 *   4. Upsert the row with the service-role client (RLS bypassed) because
 *      google_calendar_accounts is server-managed.
 *   5. Bounce the user back to /dashboard.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? url.origin;
  const dash = (msg: string) =>
    NextResponse.redirect(
      new URL(
        `/dashboard?google=${encodeURIComponent(msg)}`,
        site
      )
    );

  if (error) return dash(`denied:${error}`);
  if (!code || !state) return dash("missing_params");

  const cookieStore = cookies();
  const expected = cookieStore.get("google_oauth_state")?.value;
  cookieStore.delete("google_oauth_state");

  if (!expected || expected !== state) return dash("bad_state");

  // Who is the user right now? (Session cookie is still valid.)
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", site));

  // Map auth_user_id -> team_members.id
  const { data: member } = await sb
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!member) return dash("not_team_member");

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (e) {
    console.error("[google/callback] token exchange failed", e);
    return dash("token_exchange_failed");
  }

  let googleEmail: string;
  try {
    googleEmail = await fetchGoogleEmail(tokens.access_token);
  } catch (e) {
    console.error("[google/callback] userinfo failed", e);
    return dash("userinfo_failed");
  }

  if (!tokens.refresh_token) {
    // This happens if the user already granted us access in the past and we
    // re-prompted without `prompt=consent`. We always send prompt=consent on
    // start, so treat this as an error worth surfacing.
    return dash("no_refresh_token");
  }

  const tokenExpiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  // Write with service-role (bypasses RLS) since there's no user-scoped
  // policy that allows inserts into google_calendar_accounts. The user
  // identity check above is what secures this.
  //
  // The `as any` casts here are intentional until `types/supabase.ts` is
  // regenerated from the live schema via `supabase gen types typescript`.
  // The stub `Database` type collapses Insert/Update to `never` through the
  // Record<string, any> lookup, which makes upsert unusable without a cast.
  const admin = createAdminClient();
  const { error: upsertErr } = await (admin
    .from("google_calendar_accounts") as any)
    .upsert(
      {
        team_member_id: member.id,
        google_email: googleEmail,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_expires_at: tokenExpiresAt,
        sync_token: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "team_member_id,google_email" }
    );

  if (upsertErr) {
    console.error("[google/callback] upsert failed", upsertErr);
    return dash("store_failed");
  }

  return NextResponse.redirect(
    new URL("/dashboard?google=connected", site)
  );
}
