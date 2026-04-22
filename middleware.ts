import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Refreshes the Supabase session cookie on every request so the user stays
 * logged in, and gates authenticated routes behind auth.
 *
 * Public:    /, /vendors/new, /vendors/portal/:token (token-gated),
 *            /vendors/login, /login, /privacy, /terms, api webhooks
 * Auth'd:    /dashboard/*       (team members only — enforced at page too)
 *            /vendors/account/* (logged-in vendor only — page also checks
 *                                 auth_user_id match on the vendors row)
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isDashboard = path.startsWith("/dashboard");
  const isVendorAccount = path.startsWith("/vendors/account");

  if (isDashboard && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", path);
    return NextResponse.redirect(loginUrl);
  }

  if (isVendorAccount && !user) {
    // Vendors go to /vendors/login (not /login — that's the team page).
    const loginUrl = new URL("/vendors/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Run on every path except Next.js internals, static assets, and webhooks
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/inngest).*)",
  ],
};
