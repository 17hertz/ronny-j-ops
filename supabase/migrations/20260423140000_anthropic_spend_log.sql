-- =========================================================================
-- Migration: Anthropic API spend log
-- 2026-04-23
--
-- Tracks every call made to the Anthropic API with enough data to (a) cap
-- monthly spend in-code, (b) audit unusual usage, and (c) produce a
-- per-purpose cost breakdown when deciding where to optimize.
--
-- Pre-flight check in lib/agent/spend-gate.ts reads sum(cost_cents) for
-- the current month and refuses to call Claude when it exceeds the
-- configured cap (default $20/mo via ANTHROPIC_MONTHLY_CAP_USD env var).
--
-- Cost modeling:
--   Input and output tokens billed separately; cached input is billed
--   at 10% of normal input price (per Anthropic prompt-caching docs).
--   We compute cost_cents at call time so the log is authoritative even
--   if we change pricing tables later.
-- =========================================================================

create table if not exists public.api_spend_log (
  id uuid primary key default gen_random_uuid(),

  -- Which path spent — lets us break down cost by feature after the fact.
  -- "agent" = the dashboard chat; "sms-parse" = inbound SMS intent parser.
  purpose text not null check (purpose in ('agent','sms-parse','other')),

  -- Model string as sent to Anthropic (e.g. "claude-sonnet-4-5-20250929").
  model text not null,

  input_tokens int not null default 0,
  cached_input_tokens int not null default 0,
  output_tokens int not null default 0,

  -- Cost in cents (integer — avoid floating-point drift in aggregates).
  -- Computed from the tokens + model's unit pricing at call time.
  cost_cents int not null default 0,

  -- Optional free-text notes for debugging — e.g. "refused: monthly cap"
  -- so refusal events are visible in the same log.
  note text,

  -- Who triggered this (nullable for cron / unknown-sender paths).
  team_member_id uuid references public.team_members(id) on delete set null,

  created_at timestamptz not null default now()
);

-- Hot-path index: "total cents spent this month" is the pre-flight query.
create index if not exists api_spend_log_month_idx
  on public.api_spend_log (created_at desc);

-- Secondary index for per-purpose analytics.
create index if not exists api_spend_log_purpose_idx
  on public.api_spend_log (purpose, created_at desc);

-- RLS + grants
alter table public.api_spend_log enable row level security;

-- Team can read (auditing). Only service role writes (inline from spend-gate).
create policy "team read spend log" on public.api_spend_log
  for select using (public.is_team_member());

grant select on public.api_spend_log to authenticated;
