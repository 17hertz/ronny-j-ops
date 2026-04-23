-- =========================================================================
-- Migration: events bidirectional push
-- 2026-04-23
--
-- Extends the events table so local creates (from SMS, WhatsApp, agent,
-- dashboard, email) can push TO Google Calendar — mirroring the pattern
-- already working for tasks in 20260423000000_tasks_sot_and_sms_inbound.
--
-- Additive only. Existing rows all came FROM Google, so they're already
-- in sync — default push_status='pushed' so the new push worker doesn't
-- re-emit events for every historical row.
--
-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction
-- (Supabase runs 15+), so the enum extension is safe in this file.
-- =========================================================================

-- Extend event_source enum with the new local-create sources.
alter type public.event_source add value if not exists 'sms';
alter type public.event_source add value if not exists 'whatsapp';
alter type public.event_source add value if not exists 'email';
alter type public.event_source add value if not exists 'dashboard';

-- Push-state columns. Matches public.tasks for consistency.
alter table public.events
  add column if not exists push_status text not null default 'pushed';

-- Constraint added after the column so defaulting existing rows works
-- regardless of column order. Using DO block for IF-NOT-EXISTS safety.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'events_push_status_check'
  ) then
    alter table public.events
      add constraint events_push_status_check
      check (push_status in ('pending', 'pushed', 'error', 'skip'));
  end if;
end $$;

alter table public.events
  add column if not exists push_error text;

alter table public.events
  add column if not exists last_push_attempt_at timestamptz;

alter table public.events
  add column if not exists google_account_id uuid
    references public.google_calendar_accounts(id) on delete set null;

-- Hot-path index for the push worker: "find pending/errored events to
-- retry." Partial index — pushed rows don't need to show up here.
create index if not exists events_pending_push_idx
  on public.events (push_status, last_push_attempt_at)
  where push_status in ('pending', 'error');
