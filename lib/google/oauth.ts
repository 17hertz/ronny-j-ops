/**
 * Google OAuth 2.0 helpers for the Calendar + People APIs.
 *
 * We're doing this by hand against Google's token endpoint rather than
 * pulling in the full `googleapis` client for the auth leg — it's a few
 * HTTPS calls and avoids a heavy dep on the login path. When we wire the
 * actual calendar reads, the heavier SDK will show up in lib/google/calendar.ts.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  // Read + write on Google Tasks. We mirror into `google_tasks` (read path)
  // AND let the dashboard check things off, PATCHing the remote task so the
  // state travels back to Ronny's phone / tasks.google.com.
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: requireEnv("GOOGLE_REDIRECT_URI"),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES.join(" "),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
  id_token?: string;
};

export async function exchangeCodeForTokens(
  code: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: requireEnv("GOOGLE_REDIRECT_URI"),
    grant_type: "authorization_code",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

/**
 * Thrown when Google returns `invalid_grant` on a refresh attempt, meaning
 * the refresh token itself is permanently dead. Common causes: user
 * revoked access, changed their password, token went unused for >6 months,
 * or the OAuth app moved between Testing / Published modes.
 *
 * Callers should NOT retry — flag the account for user reconnect and
 * move on. Retrying just burns quota.
 */
export class RefreshTokenDeadError extends Error {
  readonly body: string;
  constructor(body: string) {
    super(`Google refresh token dead (invalid_grant): ${body.slice(0, 200)}`);
    this.name = "RefreshTokenDeadError";
    this.body = body;
  }
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<Omit<TokenResponse, "refresh_token"> & { refresh_token?: string }> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    // Google returns 400 + {"error":"invalid_grant",...} for dead refresh
    // tokens. Other 4xx/5xx are transient (rate limit, Google outage) and
    // callers should retry with backoff.
    if (res.status === 400 && /"invalid_grant"/.test(text)) {
      throw new RefreshTokenDeadError(text);
    }
    throw new Error(`Google token refresh failed (${res.status}): ${text}`);
  }

  return await res.json();
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Google userinfo failed (${res.status})`);
  }

  const body = (await res.json()) as { email?: string };
  if (!body.email) throw new Error("Google userinfo returned no email");
  return body.email;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
