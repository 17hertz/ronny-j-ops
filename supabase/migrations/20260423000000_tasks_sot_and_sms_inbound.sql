-- =========================================================================
-- Migration: unified tasks source-of-truth + inbound SMS audit scaffolding
-- 2026-04-23
--
-- This is step 1 of the "two-way tasks + inbound SMS/WhatsApp" rollout.
-- It is ADDITIVE and SAFE to apply today — no existing running code reads
-- public.tasks (the old definition was unused scaffolding), so replacing
-- it has zero blast radius. public.google_tasks is preserved as-is so the
-- existing sync code keeps working while we migrate reads over.
--
-- What this migration does:
--   1. Drops the unused `public.tasks` table + its `task_status` /
--      `task_priority` enums. Nothing in lib/ or app/ references them.
--   2. Creates a NEW `public.tasks` as the unified source-of-truth for
--      every task in the system — whether created via the dashboard, SMS,
--      WhatsApp, the Claude agent, or pulled from Google Tasks.
--   3. Backfills rows from `public.google_tasks` so the existing synced
--      data surfaces immediately in the new table. google_tasks stays
--      untouched as a rollback safety net for 1-2 releases.
--   4. Creates `public.sms_messages` for inbound audit + idempotence
--      (unique twilio_sid = dedupe key when Twilio retries a webhook).
--   5. Creates `public.sms_rate_limits` for per-phone rolling-window
--      throttling to cap cost-attack exposure on the LLM parser.
--   6. Adds `team_members.sms_command_enabled` (boolean, default false) —
--      opt-in flag so a leaked/stolen phone cannot auto-elevate to
--      command authority. Jason flips it to true for himself and Ronny
--      once TFV or 10DLC clears.
--   7. Enables RLS + grants to match the rest of the schema.
--
-- What this migration does NOT do:
--   - Does NOT modify lib/google/sync.ts — the reverse-sync rewrite lands
--     in a follow-up migration + code change so the two can be reviewed
--     separately.
--   - Does NOT delete public.google_tasks — intentional safety net.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Drop the unused public.tasks scaffolding
-- -------------------------------------------------------------------------
-- The original schema defined public.tasks as a "team-ops task board"
-- but zero code ever queried or wrote to it. Confirmed with grep across
-- the app/ and lib/ directories at 2026-04-23. Dropping to make room for
-- the unified version without triggering a column-shape conflict.
--
-- SAFETY: only drop if the old shape is present (has `priority` column —
-- unique to the legacy definition). Prevents accidentally clobbering the
-- new table on a re-run of this migration.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tasks'
      and column_name = 'priority'
  ) then
    drop table public.tasks cascade;
  end if;
end $$;

drop type if exists public.task_status cascade;
drop type if exists public.task_priority cascade;

-- -------------------------------------------------------------------------
-- 2. New public.tasks — unified source of truth
-- -------------------------------------------------------------------------
-- Every task lives here. `source` records origin for audit + debugging;
-- the google_* columns carry the remote identity when the row is synced
-- to Google Tasks. `push_status` drives the Inngest write-back job.
--
-- Status uses Google's vocabulary ('needsAction' | 'completed') with an
-- added 'cancelled' for soft deletes — translates to a Google DELETE on
-- push, but we keep the local row for audit.
create table public.tasks (
  id uuid primary key default gen_random_uuid(),

  -- Ownership: who the task belongs to. For Google-synced rows this is
  -- the team_member whose Google account the task came from. For locally-
  -- created rows, it's whoever created it (SMS sender, dashboard user).
  team_member_id uuid not null references public.team_members(id) on delete cascade,

  -- Content
  title text not null,
  notes text,                                    -- body / description

  -- Lifecycle
  status text not null default 'needsAction'
    check (status in ('needsAction','completed','cancelled')),
  due_at timestamptz,
  completed_at timestamptz,

  -- Provenance — where did this task originate?
  -- Purely informational; does not gate any access decisions.
  -- 'email' is included for future inbound-email ingestion (e.g. Resend
  -- inbound webhook or a dedicated inbox watcher) so we don't have to
  -- migrate the CHECK constraint when that feature ships.
  source text not null default 'dashboard'
    check (source in ('dashboard','sms','whatsapp','agent','email','google')),

  -- Google mirror state. NULL for rows that have never been pushed.
  google_account_id uuid references public.google_calendar_accounts(id) on delete set null,
  google_tasklist_id text,
  google_task_id text,
  remote_etag text,
  remote_updated_at timestamptz,

  -- Outbound push queue state. 'pending' = local change awaiting push,
  -- 'pushed' = in sync, 'error' = push failed (see push_error), 'skip' =
  -- intentionally local-only (not currently used; reserved for future
  -- "don't sync this one to Google" flag).
  push_status text not null default 'pending'
    check (push_status in ('pending','pushed','error','skip')),
  push_error text,
  last_push_attempt_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotence for Google-synced rows — (account, list, task) is unique
-- in Google's world, so mirror that here. Partial index so local-only
-- rows (google_task_id is null) don't interact with the uniqueness check.
create unique index tasks_google_identity_idx
  on public.tasks (google_account_id, google_tasklist_id, google_task_id)
  where google_task_id is not null;

-- Hot-path index for the dashboard + digest renderer: "open tasks for
-- this member, by due date." Partial so completed/cancelled rows don't
-- bloat the index.
create index tasks_member_open_due_idx
  on public.tasks (team_member_id, due_at)
  where status = 'needsAction';

-- Index for the Inngest push worker: "find me pending pushes."
create index tasks_pending_push_idx
  on public.tasks (push_status, last_push_attempt_at)
  where push_status in ('pending','error');

create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

-- -------------------------------------------------------------------------
-- 3. Backfill from public.google_tasks
-- -------------------------------------------------------------------------
-- Copy every row in google_tasks into the new tasks table so Ronny's
-- current Google-synced items are immediately visible in the unified
-- view. push_status='pushed' because these rows are already in sync on
-- the Google side (they came FROM Google).
insert into public.tasks (
  team_member_id, title, notes, status, due_at, completed_at,
  source, google_account_id, google_tasklist_id, google_task_id,
  remote_etag, remote_updated_at, push_status, created_at, updated_at
)
select
  gt.team_member_id,
  gt.title,
  gt.notes,
  case
    when gt.status = 'completed' then 'completed'
    else 'needsAction'
  end as status,
  gt.due_at,
  gt.completed_at,
  'google' as source,
  gt.google_account_id,
  gt.google_tasklist_id,
  gt.google_task_id,
  gt.etag as remote_etag,
  gt.remote_updated_at,
  'pushed' as push_status,
  gt.created_at,
  gt.updated_at
from public.google_tasks gt;

-- -------------------------------------------------------------------------
-- 4. sms_messages — inbound audit + idempotence
-- -------------------------------------------------------------------------
-- Every Twilio inbound (SMS + WhatsApp) gets written here BEFORE parsing
-- so we capture even crashed runs. Outbound replies also land here so a
-- thread-style log is possible. The unique twilio_sid makes Twilio's
-- webhook retries a no-op.
create table public.sms_messages (
  id uuid primary key default gen_random_uuid(),

  direction text not null check (direction in ('in','out')),
  channel text not null check (channel in ('sms','whatsapp')),

  from_number text not null,   -- E.164, 'whatsapp:' prefix stripped
  to_number text not null,
  body text not null,

  -- Twilio's MessageSid — same key whether inbound or outbound. Unique
  -- so retried webhooks collide on insert instead of creating duplicates.
  twilio_sid text unique,

  -- Who we identified the sender as (nullable for unknown senders —
  -- those get a canned "not registered" reply and we don't call Claude).
  team_member_id uuid references public.team_members(id) on delete set null,

  -- Parser output — populated async by the dispatcher.
  intent text,                 -- 'create_event','create_task', etc.
  intent_slots jsonb,          -- structured args parsed by Claude

  -- Action outcome
  action_status text check (action_status in ('pending','done','error','ignored')),
  reply_text text,             -- what we replied back to the user
  action_artifact_id uuid,     -- e.g. id of the task/event we created
  error text,

  created_at timestamptz not null default now()
);

create index sms_messages_member_recent_idx
  on public.sms_messages (team_member_id, created_at desc);

-- -------------------------------------------------------------------------
-- 5. sms_rate_limits — per-phone rolling-window throttle
-- -------------------------------------------------------------------------
-- Prevents a compromised/spamming number from running up the LLM bill.
-- Simple counter-per-window; reset when window_start ages out. The
-- dispatcher handles the arithmetic in-code — this table just stores
-- state across requests (since serverless).
create table public.sms_rate_limits (
  phone text primary key,
  window_start timestamptz not null default now(),
  count int not null default 0
);

-- -------------------------------------------------------------------------
-- 6. team_members.sms_command_enabled
-- -------------------------------------------------------------------------
-- Default false so an attacker who learns a team_member's phone number
-- cannot immediately start issuing commands. Jason flips this to true
-- per member once we're confident in the inbound path.
alter table public.team_members
  add column if not exists sms_command_enabled boolean not null default false;

-- -------------------------------------------------------------------------
-- 7. RLS + grants
-- -------------------------------------------------------------------------
alter table public.tasks enable row level security;
alter table public.sms_messages enable row level security;
alter table public.sms_rate_limits enable row level security;

-- Tasks: each user sees their own rows; admins see all. Matches the
-- old google_tasks policy since these rows come from the same source.
create policy "own tasks" on public.tasks
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

-- SMS messages: readable by any team member (shared ops log); only the
-- service role writes (the webhook runs with service-role because there's
-- no auth session on an inbound Twilio POST).
create policy "team read sms" on public.sms_messages
  for select using (public.is_team_member());

-- Rate limits: no app-level access needed. Service-role only, which
-- bypasses RLS. Enabling RLS with no policies means "deny all" for
-- authenticated users by default.

grant select, insert, update, delete on public.tasks          to authenticated;
grant select                          on public.sms_messages to authenticated;
-- sms_rate_limits intentionally has no authenticated grants.

-- Service role can do whatever. Your existing
-- 20260422120000_grant_service_role_future_tables.sql migration already
-- grants future tables to service_role via the ALTER DEFAULT PRIVILEGES
-- setup, so new tables inherit that automatically.

-- =========================================================================
-- End of migration.
-- Next steps (not in this file):
--   - Build lib/tasks/service.ts (CRUD used by dashboard, SMS, agent).
--   - Build lib/inngest/functions.ts → add taskPushRunner.
--   - Modify lib/google/sync.ts to upsert into public.tasks, adding
--     etag conflict handling.
--   - Build app/api/webhooks/twilio/inbound/route.ts.
-- =========================================================================
