-- =========================================================================
-- Migration: per-team-member timezone preference
-- 2026-04-23
--
-- Each team member picks the IANA timezone they operate in. Drives:
--   - Dashboard "Today / Tomorrow" grouping + event time rendering.
--   - SMS/WhatsApp digest rendering (morning text in the recipient's zone).
--   - Claude SMS-parser's "tomorrow 2pm" resolution (sender's zone, not
--     the server's UTC clock).
--
-- Backward compat: column defaults to America/New_York (our operational
-- zone to date). Existing rows get the default. Jason (PT) and Ronny
-- (ET) are explicitly set below.
-- =========================================================================

alter table public.team_members
  add column if not exists timezone text not null default 'America/New_York';

-- Jason is on the west coast.
update public.team_members
set timezone = 'America/Los_Angeles'
where email = 'jason@17hertz.io';

-- Ronny is on the east coast.
update public.team_members
set timezone = 'America/New_York'
where email = 'rjstuff14@gmail.com';
