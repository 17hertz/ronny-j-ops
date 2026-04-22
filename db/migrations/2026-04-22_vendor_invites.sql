-- =========================================================================
-- Migration: vendor invites (admin-initiated)
-- 2026-04-22 (third migration today — vendor flow is moving fast)
--
-- Lets a team member click "Invite vendor", type an email + optional note,
-- and send the vendor a friendly email with a tokenized link to the intake
-- form. When the vendor submits, we mark the invite claimed so the
-- dashboard shows pending-vs-claimed at a glance.
-- =========================================================================

create table if not exists public.vendor_invites (
  id uuid primary key default uuid_generate_v4(),
  -- URL-safe base64 of 24 random bytes (see app/api/admin/vendors/invite)
  token text not null unique,
  email text not null,
  -- Optional personal line we inject into the greeting so the email
  -- doesn't read like cold spam. E.g. "Thanks for shooting last Friday
  -- — here's the paperwork so we can pay you."
  personal_note text,
  invited_by uuid references public.team_members(id) on delete set null,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  -- Set when the vendor actually fills out the intake form using this
  -- token. claimed_vendor_id then points to the vendors row so we can
  -- jump straight to their review page.
  claimed_at timestamptz,
  claimed_vendor_id uuid references public.vendors(id) on delete set null
);

create index if not exists vendor_invites_email_idx
  on public.vendor_invites (email);
create index if not exists vendor_invites_open_idx
  on public.vendor_invites (sent_at desc)
  where claimed_at is null;

-- RLS: team members only. No self-service reads. The public intake form
-- uses the service-role client to validate + claim the token server-side.
alter table public.vendor_invites enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'vendor_invites'
      and policyname = 'team full access invites'
  ) then
    create policy "team full access invites" on public.vendor_invites
      for all using (public.is_team_member())
      with check (public.is_team_member());
  end if;
end $$;

grant select, insert, update, delete
  on public.vendor_invites to authenticated;

-- service_role is used by lib/supabase/admin (createAdminClient) from our
-- API routes. The blanket "grant all on all tables to service_role" in
-- db/schema.sql was a one-time grant — it only covers tables that existed
-- at the moment it ran, so every new table needs its own explicit grant
-- here. Without this the admin client gets Postgres 42501
-- "permission denied for table vendor_invites".
grant all on public.vendor_invites to service_role;
