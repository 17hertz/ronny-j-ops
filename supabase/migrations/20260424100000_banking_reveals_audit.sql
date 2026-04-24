-- =========================================================================
-- Migration: banking reveals audit trail
-- 2026-04-24
--
-- Every time a team member reveals a vendor's decrypted banking info or
-- tax ID, we log it here. This exists so you can answer "who looked at
-- X's account number and when" — essential for any claim of due care
-- around sensitive PII.
--
-- The reveal ITSELF happens through POST /api/vendors/[id]/reveal-banking
-- which decrypts via lib/crypto.ts at request time. Plaintext is never
-- persisted outside the TLS-encrypted HTTP response and the team member's
-- browser memory.
-- =========================================================================

create table if not exists public.banking_reveals (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references public.team_members(id) on delete set null,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  -- What they revealed: 'ach' / 'tax_id' / 'both'. Future-proofs if we
  -- split reveal endpoints per-field.
  fields text not null check (fields in ('ach', 'tax_id', 'both')),
  -- Optional: free-text reason the team member typed before revealing
  -- (encouraged pattern — "processing April 25 payout" makes audit
  -- more useful later).
  reason text,
  -- IP + user agent for forensic completeness. Nullable; not every
  -- request carries them reliably behind Vercel's edge.
  ip text,
  user_agent text,
  revealed_at timestamptz not null default now()
);

create index if not exists banking_reveals_vendor_idx
  on public.banking_reveals (vendor_id, revealed_at desc);
create index if not exists banking_reveals_member_idx
  on public.banking_reveals (team_member_id, revealed_at desc);

-- RLS: team can read (audit transparency). Only service role writes
-- (the reveal endpoint runs through admin client).
alter table public.banking_reveals enable row level security;

create policy "team read banking_reveals" on public.banking_reveals
  for select using (public.is_team_member());

grant select on public.banking_reveals to authenticated;
