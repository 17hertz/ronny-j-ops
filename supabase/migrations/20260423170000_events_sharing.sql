-- =========================================================================
-- Migration: events sharing model + backfill ownership
-- 2026-04-23
--
-- Problem: today the events table has no ownership filter. When a second
-- team member (Ronny) joins, Jason's synced Google Calendar events show
-- up on Ronny's dashboard — a genuine privacy leak. The RLS policy is
-- permissive-by-design from v0.1 when there was only one team member.
--
-- Fix model: events are PRIVATE to their creator by default. A `shared`
-- boolean lets the creator opt-in to showing the event to the whole team.
-- Dashboard + digest queries get a new filter:
--   created_by = me OR shared = true
--
-- Existing rows were all synced by Jason's Google account (he's the only
-- person who has connected Google as of this migration). Backfill assigns
-- them to the team_member behind the first google_calendar_account so
-- they don't become orphaned-and-invisible. Going forward, lib/google/
-- sync.ts is updated to set created_by on every pulled event.
-- =========================================================================

alter table public.events
  add column if not exists shared boolean not null default false;

-- Backfill created_by on historical events that were synced before we
-- started recording ownership. Fallback: pick the earliest google
-- calendar account's team_member_id. If there's ever more than one
-- pre-existing account, the tie-breaker lands on whoever connected
-- first, which is fine for the current single-real-user data.
do $$
declare
  default_owner uuid;
begin
  select gca.team_member_id
  into default_owner
  from public.google_calendar_accounts gca
  order by gca.created_at asc
  limit 1;

  if default_owner is not null then
    update public.events
    set created_by = default_owner
    where created_by is null
      and source = 'google';
  end if;
end $$;

-- Index for the "my events + team-shared" filter. Partial index makes
-- the shared=true scan tiny since most events are private by default.
create index if not exists events_created_by_idx
  on public.events (created_by, starts_at);

create index if not exists events_shared_idx
  on public.events (starts_at)
  where shared = true;
