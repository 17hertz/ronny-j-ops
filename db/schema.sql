-- =========================================================================
-- Ronny J Ops — Postgres schema
--
-- Run against your Supabase project. The easiest path:
--   1. Create the project in Supabase.
--   2. Paste this file into the SQL editor and run it.
--   3. Later, use `npm run db:push` to apply migrations via the Supabase CLI.
--
-- Conventions:
--   * UUIDs for every PK (uuid_generate_v4)
--   * created_at/updated_at on every table; trigger fn below
--   * Every "human data" table has RLS enabled; policies at the bottom
--   * Vendor intake is PUBLIC via service-role client, not RLS passthrough
-- =========================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------------------
-- updated_at trigger
-- -------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------------------
-- team_members
-- Each team user (Ronny, Jason, manager, etc.) is linked to a Supabase auth
-- user. `role` drives what they can see/do.
-- -------------------------------------------------------------------------
create type public.team_role as enum ('owner', 'admin', 'operator', 'readonly');

create table public.team_members (
  id uuid primary key default uuid_generate_v4(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  role public.team_role not null default 'operator',
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger team_members_touch before update on public.team_members
  for each row execute function public.touch_updated_at();

-- Helper: is the current request from a team member?
create or replace function public.is_team_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members where auth_user_id = auth.uid()
  );
$$;

-- Helper: is the current request from an admin or owner?
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where auth_user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

-- -------------------------------------------------------------------------
-- contacts
-- Anyone we communicate with: artists, collaborators, venues, managers.
-- This is the "recipient" table for reminders.
-- -------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default uuid_generate_v4(),
  full_name text not null,
  email text,
  phone text,                  -- E.164: +1XXXXXXXXXX
  whatsapp text,               -- E.164 for WhatsApp
  -- Comms consent — track separately per channel, TCPA requires proof
  sms_consent_at timestamptz,
  whatsapp_consent_at timestamptz,
  email_consent_at timestamptz,
  -- Channel preference in order (e.g. {'sms','email'})
  preferred_channels text[] not null default array['sms','email'],
  timezone text default 'America/New_York',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_updated_at();

create index on public.contacts (email);
create index on public.contacts (phone);

-- -------------------------------------------------------------------------
-- tasks
-- Shared team to-do list.
-- -------------------------------------------------------------------------
create type public.task_status as enum ('todo', 'in_progress', 'done', 'cancelled');
create type public.task_priority as enum ('low', 'normal', 'high', 'urgent');

create table public.tasks (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  description text,
  status public.task_status not null default 'todo',
  priority public.task_priority not null default 'normal',
  assigned_to uuid references public.team_members(id) on delete set null,
  created_by uuid references public.team_members(id) on delete set null,
  due_at timestamptz,
  completed_at timestamptz,
  linked_event_id uuid,   -- set after events table
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

create index on public.tasks (status);
create index on public.tasks (assigned_to);
create index on public.tasks (due_at);

-- -------------------------------------------------------------------------
-- events
-- Calendar events. Google is source of truth, iCloud is mirrored.
-- `google_event_id` + `google_calendar_id` let us round-trip updates.
-- -------------------------------------------------------------------------
create type public.event_source as enum ('google', 'manual', 'agent');

create table public.events (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  description text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/New_York',
  source public.event_source not null default 'google',
  google_calendar_id text,
  google_event_id text,
  etag text,                        -- Google etag for optimistic sync
  sync_token text,                  -- per-calendar sync token (not event)
  created_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (google_calendar_id, google_event_id)
);
create trigger events_touch before update on public.events
  for each row execute function public.touch_updated_at();

create index on public.events (starts_at);

alter table public.tasks
  add constraint tasks_linked_event_fk
  foreign key (linked_event_id) references public.events(id) on delete set null;

-- -------------------------------------------------------------------------
-- event_attendees
-- Who's on each event and which channel they opted into for reminders.
-- -------------------------------------------------------------------------
create table public.event_attendees (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references public.events(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  rsvp text check (rsvp in ('yes','no','maybe','pending')) default 'pending',
  created_at timestamptz not null default now(),
  unique (event_id, contact_id)
);
create index on public.event_attendees (event_id);

-- -------------------------------------------------------------------------
-- reminders
-- A scheduled reminder lives here until it's sent. Inngest reads this.
-- We create one row per (event, contact, offset_minutes) tuple.
-- -------------------------------------------------------------------------
create type public.reminder_status as enum (
  'scheduled', 'sending', 'sent', 'failed', 'cancelled'
);

create table public.reminders (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references public.events(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  send_at timestamptz not null,
  offset_minutes int not null,              -- e.g. 1440 (24h), 60 (1h)
  channels text[] not null,                 -- resolved at schedule time
  status public.reminder_status not null default 'scheduled',
  -- Inngest job coordinates so we can cancel/requery
  inngest_run_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, contact_id, offset_minutes)
);
create trigger reminders_touch before update on public.reminders
  for each row execute function public.touch_updated_at();

create index on public.reminders (send_at) where status = 'scheduled';
create index on public.reminders (status);

-- -------------------------------------------------------------------------
-- reminder_dispatches
-- Per-channel send log. One reminder can produce multiple dispatches
-- (e.g. SMS sent, then fallback Email sent if SMS bounced).
-- -------------------------------------------------------------------------
create type public.dispatch_channel as enum ('sms','whatsapp','rcs','email');
create type public.dispatch_status as enum (
  'queued','sent','delivered','failed','bounced','opted_out'
);

create table public.reminder_dispatches (
  id uuid primary key default uuid_generate_v4(),
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  channel public.dispatch_channel not null,
  status public.dispatch_status not null default 'queued',
  provider_message_id text,
  provider_status_payload jsonb,
  sent_at timestamptz,
  delivered_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger dispatches_touch before update on public.reminder_dispatches
  for each row execute function public.touch_updated_at();

create index on public.reminder_dispatches (reminder_id);
create index on public.reminder_dispatches (provider_message_id);

-- -------------------------------------------------------------------------
-- vendors
-- A vendor completes the public intake form. Payment + 1099 lives here.
-- -------------------------------------------------------------------------
create type public.vendor_status as enum (
  'invited','submitted','in_review','approved','rejected'
);
create type public.vendor_type as enum (
  'individual','sole_prop','llc','s_corp','c_corp','partnership','other'
);
-- What service the vendor provides. Drives reporting + reminder routing
-- (a security vendor's "gig reminder" reads differently than a photographer's).
create type public.vendor_service_category as enum (
  'security',
  'photography',
  'video_equipment',
  'rentals',
  'cars',
  'yachts',
  'deposits',
  'stream_engineer',
  'video_editor',
  'graphic_designer',
  'sponsorship',
  'other'
);
-- How 17 Hertz pays the vendor.
-- ACH is the PRIMARY rail and is required for every approved vendor so we
-- can run payroll-style batch payouts. Zelle / PayPal / Venmo are optional
-- secondary rails captured for fast one-off payments (deposits, tips, etc).
-- Full account/routing lives in vendors.ach_bank_details_encrypted
-- (pgsodium-encrypted); only the last4 is stored in cleartext.
create type public.vendor_payment_method as enum (
  'ach','paypal','venmo','zelle','other'
);

create table public.vendors (
  id uuid primary key default uuid_generate_v4(),
  legal_name text not null,
  dba text,
  vendor_type public.vendor_type,
  contact_name text,
  contact_email text not null,
  contact_phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text default 'US',
  -- What service this vendor provides. Required so Jason/Ronny can route
  -- reminders, filter the review queue, and slice 1099 reporting.
  service_category public.vendor_service_category,
  service_notes text,              -- free-form "what you actually do"
  -- W9 fields. tax_id_last4 is safe to store; full is ENCRYPTED via pgsodium.
  tax_id_last4 text,
  tax_id_encrypted bytea,     -- pgsodium-encrypted EIN/SSN
  -- IRS TIN Match result
  tin_match_status text check (tin_match_status in ('pending','match','mismatch','error')),
  tin_match_checked_at timestamptz,
  -- ---------------------------------------------------------------
  -- Payment rails
  -- ACH is required. Full routing + account JSON is encrypted at rest
  -- (pgsodium) — same pattern as tax_id. Only last4s are stored plaintext
  -- so we can display "...1234" in the dashboard without a decrypt round-trip.
  ach_account_holder_name text,
  ach_routing_last4 text,
  ach_account_last4 text,
  ach_account_type text check (ach_account_type in ('checking','savings')),
  ach_bank_name text,
  ach_bank_details_encrypted bytea,
  -- Optional secondary rail for fast one-off payouts. Nullable — vendors
  -- can skip this; ACH alone is sufficient to be approved.
  secondary_payment_method public.vendor_payment_method,
  secondary_payment_handle text,     -- e.g. "ronny@example.com", "@ronnyj", "+15551234567"
  status public.vendor_status not null default 'invited',
  submitted_at timestamptz,
  reviewed_by uuid references public.team_members(id) on delete set null,
  reviewed_at timestamptz,
  -- One-time portal token so vendor can come back and edit until submitted
  portal_token text unique,
  portal_token_expires_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger vendors_touch before update on public.vendors
  for each row execute function public.touch_updated_at();

create index on public.vendors (status);
create index on public.vendors (contact_email);

-- -------------------------------------------------------------------------
-- vendor_documents
-- W9s, invoices, contracts. Stored in Supabase Storage; this row points
-- to the storage path and tracks metadata.
-- -------------------------------------------------------------------------
create type public.document_kind as enum ('w9','invoice','contract','other');

create table public.vendor_documents (
  id uuid primary key default uuid_generate_v4(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  kind public.document_kind not null,
  storage_path text not null,      -- e.g. "vendors/{vendor_id}/w9-2026.pdf"
  original_filename text,
  mime_type text,
  byte_size int,
  -- invoice-specific (nullable for other kinds)
  invoice_number text,
  invoice_amount_cents int,
  invoice_due_at date,
  -- DocuSeal envelope ref for signed W9s
  docuseal_submission_id text,
  signed_at timestamptz,
  uploaded_by_vendor boolean not null default true,
  uploaded_at timestamptz not null default now()
);
create index on public.vendor_documents (vendor_id);
create index on public.vendor_documents (kind);

-- -------------------------------------------------------------------------
-- google_calendar_accounts
-- OAuth tokens for each team member who's connected Google. One user can
-- connect multiple calendars (their personal, Ronny's shared work cal, etc.)
-- -------------------------------------------------------------------------
create table public.google_calendar_accounts (
  id uuid primary key default uuid_generate_v4(),
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  google_email text not null,
  access_token text not null,     -- TODO: encrypt at rest with pgsodium
  refresh_token text not null,
  scope text not null,
  token_expires_at timestamptz not null,
  watch_channel_id text,          -- Google push-notification channel
  watch_resource_id text,
  watch_expires_at timestamptz,
  sync_token text,                -- incremental sync cursor
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_member_id, google_email)
);
create trigger gcal_touch before update on public.google_calendar_accounts
  for each row execute function public.touch_updated_at();

-- -------------------------------------------------------------------------
-- google_tasks
-- Read-only mirror of Google Tasks for each connected Google account.
-- This is separate from public.tasks (which is the team-ops task board)
-- so personal todos don't bleed into the shared workflow.
-- -------------------------------------------------------------------------
create table public.google_tasks (
  id uuid primary key default uuid_generate_v4(),
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  google_account_id uuid not null references public.google_calendar_accounts(id) on delete cascade,
  google_tasklist_id text not null,
  google_task_id text not null,
  title text not null,
  notes text,
  status text not null,                 -- 'needsAction' | 'completed'
  due_at timestamptz,
  completed_at timestamptz,
  parent_task_id text,                  -- Google's parent (for subtasks)
  position text,                        -- Google's lexicographic sort key
  etag text,
  remote_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (google_account_id, google_tasklist_id, google_task_id)
);
create index on public.google_tasks (team_member_id, status, due_at);
create trigger gtasks_touch before update on public.google_tasks
  for each row execute function public.touch_updated_at();

-- -------------------------------------------------------------------------
-- agent_sessions / agent_messages
-- Trace log for the Claude Agent SDK interactions so the team can see why
-- the agent took an action.
-- -------------------------------------------------------------------------
create table public.agent_sessions (
  id uuid primary key default uuid_generate_v4(),
  triggered_by uuid references public.team_members(id) on delete set null,
  trigger_kind text not null,     -- 'manual','cron','webhook'
  summary text,
  created_at timestamptz not null default now()
);

create table public.agent_messages (
  id uuid primary key default uuid_generate_v4(),
  session_id uuid not null references public.agent_sessions(id) on delete cascade,
  role text not null check (role in ('system','user','assistant','tool')),
  content jsonb not null,
  tool_name text,
  created_at timestamptz not null default now()
);
create index on public.agent_messages (session_id);

-- =========================================================================
-- Row-level security
-- =========================================================================

-- Enable RLS everywhere we care about
alter table public.team_members            enable row level security;
alter table public.contacts                enable row level security;
alter table public.tasks                   enable row level security;
alter table public.events                  enable row level security;
alter table public.event_attendees         enable row level security;
alter table public.reminders               enable row level security;
alter table public.reminder_dispatches     enable row level security;
alter table public.vendors                 enable row level security;
alter table public.vendor_documents        enable row level security;
alter table public.google_calendar_accounts enable row level security;
alter table public.google_tasks            enable row level security;
alter table public.agent_sessions          enable row level security;
alter table public.agent_messages          enable row level security;

-- ---- team_members ------------------------------------------------------
-- A logged-in team member sees all team members (small org); only admin writes.
-- The "own row read" policy breaks a chicken-and-egg problem: the "team read"
-- policy calls is_team_member(), which queries team_members — so on a cold
-- fetch the user would never be able to see their own row even though
-- the helper is security definer. This direct-match policy lets the
-- dashboard boot before is_team_member() has any data to check against.
create policy "own row read" on public.team_members
  for select using (auth_user_id = auth.uid());
create policy "team read" on public.team_members
  for select using (public.is_team_member());
create policy "admin write" on public.team_members
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- contacts / tasks / events / attendees / reminders / dispatches ----
-- Any team member can CRUD. Non-team: no access.
do $$
declare t text;
begin
  for t in select unnest(array[
    'contacts','tasks','events','event_attendees',
    'reminders','reminder_dispatches'
  ]) loop
    execute format(
      'create policy "team all" on public.%I for all using (public.is_team_member()) with check (public.is_team_member())',
      t
    );
  end loop;
end$$;

-- ---- vendors -----------------------------------------------------------
-- Team can CRUD. Public intake hits a Route Handler that uses the service-
-- role client, so no RLS passthrough is needed for the public form.
create policy "team vendors all" on public.vendors
  for all using (public.is_team_member()) with check (public.is_team_member());

create policy "team vendor docs all" on public.vendor_documents
  for all using (public.is_team_member()) with check (public.is_team_member());

-- ---- google_calendar_accounts -----------------------------------------
-- Users see their own tokens only; admins see everyone's (for debugging).
create policy "own calendar tokens" on public.google_calendar_accounts
  for all using (
    team_member_id in (
      select id from public.team_members where auth_user_id = auth.uid()
    )
    or public.is_admin()
  ) with check (
    team_member_id in (
      select id from public.team_members where auth_user_id = auth.uid()
    )
    or public.is_admin()
  );

-- ---- google_tasks ------------------------------------------------------
-- Each user sees only the Google Tasks mirrored from their own account.
create policy "own google tasks" on public.google_tasks
  for all using (
    team_member_id in (
      select id from public.team_members where auth_user_id = auth.uid()
    )
    or public.is_admin()
  ) with check (
    team_member_id in (
      select id from public.team_members where auth_user_id = auth.uid()
    )
    or public.is_admin()
  );

-- ---- agent sessions/messages ------------------------------------------
create policy "team agent read" on public.agent_sessions
  for select using (public.is_team_member());
create policy "team agent write" on public.agent_sessions
  for all using (public.is_admin()) with check (public.is_admin());
create policy "team agent msg read" on public.agent_messages
  for select using (public.is_team_member());
create policy "team agent msg write" on public.agent_messages
  for all using (public.is_admin()) with check (public.is_admin());

-- =========================================================================
-- Grants
-- =========================================================================
-- RLS is the row-level filter, but Postgres GRANTs are the table-level gate
-- that runs *before* RLS. Without these, `authenticated` sessions get
-- "permission denied" even when a matching policy exists. `service_role`
-- usually has these by default in Supabase, but applying the schema raw to
-- a fresh project misses them — so we declare them explicitly.

grant usage on schema public to authenticated, anon, service_role;

-- service_role needs full access on everything (it's what server-side
-- route handlers use to bypass RLS for system-managed tables).
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all routines  in schema public to service_role;

-- authenticated users need table-level privileges; RLS still filters rows.
grant select on public.team_members              to authenticated;
grant select, insert, update, delete
  on public.google_calendar_accounts             to authenticated;
grant select on public.google_tasks              to authenticated;
grant select, insert, update, delete
  on public.contacts                             to authenticated;
grant select, insert, update, delete
  on public.tasks                                to authenticated;
grant select, insert, update, delete
  on public.events                               to authenticated;
grant select, insert, update, delete
  on public.event_attendees                      to authenticated;
grant select, insert, update, delete
  on public.reminders                            to authenticated;
grant select, insert, update, delete
  on public.reminder_dispatches                  to authenticated;
grant select, insert, update, delete
  on public.vendors                              to authenticated;
grant select, insert, update, delete
  on public.vendor_documents                     to authenticated;
grant select on public.agent_sessions            to authenticated;
grant select on public.agent_messages            to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- =========================================================================
-- Storage buckets (run in Supabase SQL editor — storage schema is magic)
-- =========================================================================
-- Create a private bucket for vendor docs. Do this in the dashboard UI, or:
--   insert into storage.buckets (id, name, public) values ('vendor-docs','vendor-docs',false)
--     on conflict do nothing;
-- Then set a policy that only team members can read:
--   create policy "team read vendor docs"
--     on storage.objects for select to authenticated
--     using (bucket_id = 'vendor-docs' and public.is_team_member());
-- Service-role uploads (from the vendor portal) bypass this.
