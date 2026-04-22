-- =========================================================================
-- Migration: vendor-side auth + invoice lifecycle
-- 2026-04-22 (second migration of the day)
--
-- Adds the ability for approved vendors to log into their own account
-- (separate from team_members — vendors are auth.users with a link back
-- to their vendors row) and to submit invoices, either by uploading a PDF
-- or by filling a form we render to PDF.
--
-- Idempotent via IF NOT EXISTS / DO blocks.
-- =========================================================================

-- 1. vendors.auth_user_id -------------------------------------------------
-- When we approve a vendor, we invite them via Supabase auth. This is the
-- one-to-one link from the vendor record to the auth.users row. Nullable
-- because invited/submitted vendors won't have one yet.
alter table public.vendors
  add column if not exists auth_user_id uuid
    references auth.users(id) on delete set null;

create unique index if not exists vendors_auth_user_id_key
  on public.vendors (auth_user_id)
  where auth_user_id is not null;

-- 2. invoice lifecycle on vendor_documents --------------------------------
-- The existing table already has invoice_number / invoice_amount_cents /
-- invoice_due_at. What we were missing is a status field so we can tell
-- "vendor just submitted it" from "paid, move on".
do $$
begin
  if not exists (select 1 from pg_type where typname = 'invoice_status') then
    create type public.invoice_status as enum (
      'submitted','under_review','approved','paid','rejected','void'
    );
  end if;
end $$;

alter table public.vendor_documents
  add column if not exists invoice_status public.invoice_status,
  -- Free-text description typed by the vendor when they GENERATED an
  -- invoice via our form (vs uploaded a PDF). Lets the review UI show
  -- "what they're charging for" without re-opening the PDF.
  add column if not exists invoice_description text,
  -- When we GENERATE an invoice, we stash the structured form payload
  -- here (line items, tax, etc.) so we can regenerate the PDF later if
  -- the template changes or if the vendor asks us to fix a typo.
  add column if not exists invoice_form_payload jsonb,
  -- Flag: did WE generate this PDF, or did the vendor upload their own?
  add column if not exists generated_by_system boolean not null default false,
  -- When the vendor clicked "Submit" (for uploads this equals uploaded_at,
  -- but generated invoices have a form-submit event distinct from the
  -- subsequent PDF render).
  add column if not exists submitted_at timestamptz,
  -- Review trail on the admin side
  add column if not exists reviewed_by uuid
    references public.team_members(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_notes text,
  add column if not exists paid_at timestamptz;

-- Invoices will frequently be queried by status for the "pending invoices"
-- panel on the dashboard. Partial index so we only index the open states.
create index if not exists vendor_documents_open_invoices_idx
  on public.vendor_documents (invoice_status, submitted_at desc)
  where kind = 'invoice'
    and invoice_status in ('submitted','under_review');

-- 3. RLS: vendors can see their own rows ---------------------------------
-- The existing policies on vendors + vendor_documents assumed only team
-- members touch these tables. Now vendors themselves (auth.users with a
-- vendors.auth_user_id match) need read access to their own record and
-- full access to their own invoices.
--
-- IMPORTANT: team_members already have broad policies. These are
-- ADDITIVE — we're not loosening team access, just allowing vendors to
-- see the subset of rows that belongs to them.

-- Does the current auth user own this vendor row?
create or replace function public.is_vendor_self(vid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.vendors
    where id = vid
      and auth_user_id = auth.uid()
  );
$$;

do $$
begin
  -- vendors: vendor reads own row
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'vendors' and policyname = 'vendor self read'
  ) then
    create policy "vendor self read" on public.vendors
      for select using (auth_user_id = auth.uid());
  end if;

  -- vendors: vendor updates own row (limited columns enforced at the app
  -- layer — RLS only gates the write; we don't let them flip their own
  -- status, but we DO let them correct a typo in their phone number).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'vendors' and policyname = 'vendor self update'
  ) then
    create policy "vendor self update" on public.vendors
      for update using (auth_user_id = auth.uid())
      with check (auth_user_id = auth.uid());
  end if;

  -- vendor_documents: vendor reads their own docs
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'vendor_documents' and policyname = 'vendor self read docs'
  ) then
    create policy "vendor self read docs" on public.vendor_documents
      for select using (public.is_vendor_self(vendor_id));
  end if;

  -- vendor_documents: vendor inserts their own docs (invoices, extra W9s)
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'vendor_documents' and policyname = 'vendor self insert docs'
  ) then
    create policy "vendor self insert docs" on public.vendor_documents
      for insert with check (public.is_vendor_self(vendor_id));
  end if;
end $$;
