-- =========================================================================
-- Migration: event_vendors crew/assignment join table
-- 2026-04-24
--
-- Models "which vendors are working which events, in what role, during
-- what window, and who's the specific person on-site." Powers both the
-- dashboard Crew UI and the Claude SMS assistant's answers to questions
-- like "who's my security tonight?" or "what time's my set?".
--
-- Design choices (see the chat where Jason and the assistant aligned):
--   - Single join table (not per-role tables). One row per vendor
--     attached to an event. Multiple rows allowed for same (event,
--     vendor) — covers cases like two security vendors on different
--     rooms, or a primary + backup photographer.
--   - `role` is a text column with a CHECK constraint (not an enum),
--     so adding 'pyrotechnics' / 'tour_manager' later doesn't need a
--     migration — we just update the CHECK.
--   - `service_window_start/end` is intentionally generic: security
--     uses it for call-time/leave, artist uses it for set start/end,
--     driver uses it for pickup/dropoff. Claude reads role + window
--     and gives a role-appropriate answer.
--   - `contact_on_site` is free text ("Mike 555-1234"). A future
--     migration can add on_site_contact_id → contacts(id) for formal
--     linkage if/when that matters.
-- =========================================================================

create table if not exists public.event_vendors (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,

  -- Role this vendor plays on this specific event. Extend the CHECK
  -- list when we need new roles; no data migration required.
  role text not null default 'other'
    check (role in (
      'security','photography','videography','catering','lighting',
      'sound','driver','transportation','promoter','venue',
      'artist','opener','hair_makeup','stylist','stage','runner',
      'hospitality','streamer','performer','model','other'
    )),

  -- When this vendor is on-site / active for this event. Semantics
  -- depend on the role:
  --   security   → guards' call time to leave time
  --   driver     → pickup to dropoff
  --   artist/performer/streamer/model → set / performance window
  --   photographer/videographer → shooting window
  --   catering   → serving window
  --   other      → arrival / departure
  service_window_start timestamptz,
  service_window_end timestamptz,

  -- Specific person working tonight — free text since many vendors
  -- are companies and the point-of-contact varies show-to-show.
  -- Example: "Mike 555-1234" or "call the main office, ask for Dee".
  contact_on_site text,

  notes text,

  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep-in-touch trigger so updated_at bumps on edits.
drop trigger if exists event_vendors_touch on public.event_vendors;
create trigger event_vendors_touch before update on public.event_vendors
  for each row execute function public.touch_updated_at();

-- Hot-path indexes.
create index if not exists event_vendors_event_idx
  on public.event_vendors (event_id);
create index if not exists event_vendors_vendor_idx
  on public.event_vendors (vendor_id);
-- Role lookups ("find all security assignments today") go through this.
create index if not exists event_vendors_role_idx
  on public.event_vendors (role, service_window_start);

-- RLS + grants. Match the events table's visibility model:
--   - Team members can read + write assignments for events they can
--     read (via the events privacy filter: created_by = me OR shared).
--   - Service role (admin client) bypasses — used by Claude SMS tools.
alter table public.event_vendors enable row level security;

create policy "team read event_vendors" on public.event_vendors
  for select using (public.is_team_member());

create policy "team write event_vendors" on public.event_vendors
  for all using (public.is_team_member()) with check (public.is_team_member());

grant select, insert, update, delete
  on public.event_vendors to authenticated;
