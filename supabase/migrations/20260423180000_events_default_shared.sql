-- =========================================================================
-- Migration: per-team-member event-sharing default
-- 2026-04-23
--
-- Each team member now has their own default for whether new events
-- they create (or pull via Google sync) are shared with the team or
-- private by default. Matches the roles:
--   - Ronny (rjstuff14@gmail.com): runs ops, wants everything visible by
--     default. events_default_shared = true. He flips the toggle to go
--     private on a specific event.
--   - Jason (jason@17hertz.io): builder / admin, wants everything
--     private by default. events_default_shared = false (the column's
--     default). He flips the toggle to share.
--
-- The per-event `shared` toggle introduced in 20260423170000 still
-- works the same way — this just changes the starting value.
--
-- Backfill updates Ronny's historical events too, so his view stops
-- hiding stuff from the team retroactively.
-- =========================================================================

alter table public.team_members
  add column if not exists events_default_shared boolean not null default false;

-- Set Ronny's preference to public-by-default. Jason keeps the column
-- default (false → private). New team members default to private too;
-- Jason can flip preferences individually as the team grows.
update public.team_members
set events_default_shared = true
where email = 'rjstuff14@gmail.com';

-- Backfill: for any team_member with events_default_shared=true, flip
-- their historical events to shared=true. This keeps the preference
-- consistent with the dashboard view they'd expect — they shouldn't
-- have to toggle 50 historical events one by one.
update public.events e
set shared = true
from public.team_members tm
where e.created_by = tm.id
  and tm.events_default_shared = true;

-- Trigger: on INSERT, set shared from the creator's preference so new
-- events automatically honor the team member's default. Only fires on
-- INSERT — UPDATEs (including the UPDATE half of upserts) leave shared
-- alone, so a user's manual toggle isn't clobbered when Google sync
-- re-pulls the event later.
create or replace function public.events_apply_default_shared()
returns trigger
language plpgsql
as $$
begin
  select coalesce(events_default_shared, false)
  into new.shared
  from public.team_members
  where id = new.created_by;
  -- Null-safe fallback: if the lookup missed (shouldn't happen given
  -- the WHEN clause below), default to private.
  new.shared = coalesce(new.shared, false);
  return new;
end;
$$;

drop trigger if exists events_apply_default_shared_before_insert
  on public.events;

create trigger events_apply_default_shared_before_insert
  before insert on public.events
  for each row
  when (new.created_by is not null)
  execute function public.events_apply_default_shared();
