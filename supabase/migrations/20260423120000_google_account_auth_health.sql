-- =========================================================================
-- Migration: Google account auth-health tracking
-- 2026-04-23
--
-- Adds three columns to google_calendar_accounts so the app can tell the
-- difference between "token expired, we refreshed fine" (normal, invisible)
-- and "refresh token itself is dead, user must reconnect" (surface a
-- banner, don't keep thrashing Google).
--
-- needs_reconnect = true    → refresh_token is dead (Google returned
--                             invalid_grant or similar permanent error).
--                             Dashboard shows reconnect banner. Cron
--                             skips the account until user reconnects.
-- last_auth_error          → latest human-readable error string from a
--                             failed refresh — shown in the dashboard
--                             banner tooltip for debugging.
-- last_auth_error_at       → when that error happened, so a stale flag
--                             (e.g. user fixed it out-of-band) can be
--                             cleared after a successful refresh.
--
-- Safe additive migration. Defaults prevent any existing code from
-- breaking. The OAuth callback route will be updated to clear these
-- columns on a successful reconnect.
-- =========================================================================

alter table public.google_calendar_accounts
  add column if not exists needs_reconnect boolean not null default false;

alter table public.google_calendar_accounts
  add column if not exists last_auth_error text;

alter table public.google_calendar_accounts
  add column if not exists last_auth_error_at timestamptz;

-- Partial index for the proactive refresh cron: "find accounts that need
-- refreshing soon AND aren't dead." Skips dead ones so we don't hammer
-- Google's endpoint with tokens it already rejected.
create index if not exists google_calendar_accounts_refresh_target_idx
  on public.google_calendar_accounts (token_expires_at)
  where needs_reconnect = false;
