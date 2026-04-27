-- =========================================================================
-- Migration: screenshot capture pipeline + direct expense ledger
-- 2026-04-25
--
-- Adds two tables:
--   - bill_captures: every image Jason or Ronny sends in (dashboard
--     drop-zone, SMS MMS, WhatsApp media). One row per capture, with
--     Claude's classification + the artifact it routed to. This is the
--     audit trail: "I sent that receipt yesterday, what happened to it?"
--   - direct_expenses: product purchases that don't need a W9 (gear,
--     supplies, food, gas) — anything where sales tax was paid at the
--     register. Rolls into the existing expense reports.
--
-- Plus a private Storage bucket 'captures' for the original images.
-- =========================================================================

-- ---- bill_captures ---------------------------------------------------
create table if not exists public.bill_captures (
  id uuid primary key default gen_random_uuid(),

  -- Where the image came from. 'mms' = Twilio SMS attachment;
  -- 'whatsapp' = Twilio WhatsApp media; 'dashboard' = web upload.
  source text not null check (source in ('dashboard','mms','whatsapp','email')),

  -- Who sent it (nullable for inbound from unknown/unregistered phone
  -- numbers — those rarely happen but we keep the row for forensic).
  team_member_id uuid references public.team_members(id) on delete set null,

  -- The original image in Storage (bucket 'captures').
  image_storage_path text not null,
  image_mime_type text,
  image_byte_size int,

  -- Claude's classification output (the structured tool-use response).
  -- Stored as jsonb for full debuggability; specific fields like
  -- detected_intent are also broken out for cheap querying.
  classification jsonb,
  detected_intent text check (
    detected_intent is null
    or detected_intent in ('task','event','bill_service','bill_product','contact','other')
  ),
  detection_confidence numeric,
  detection_reasoning text,

  -- Where the capture eventually got routed. Exactly one is non-null
  -- when a capture successfully creates an artifact.
  routed_task_id uuid references public.tasks(id) on delete set null,
  routed_event_id uuid references public.events(id) on delete set null,
  routed_expense_id uuid,    -- FK added below after direct_expenses exists

  -- Lifecycle status:
  --   pending     → just uploaded, classifier hasn't run yet
  --   classifying → Inngest function is processing
  --   done        → routed to an artifact
  --   needs_review → low confidence or 'other' intent; surface in UI
  --   error       → classifier or routing threw
  status text not null default 'pending'
    check (status in ('pending','classifying','done','needs_review','error')),
  error_message text,

  -- A human-readable summary the worker writes after routing, used as
  -- the SMS confirmation reply: "Logged $42.18 expense at Guitar
  -- Center as a product purchase."
  reply_text text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger bill_captures_touch
  before update on public.bill_captures
  for each row execute function public.touch_updated_at();

create index if not exists bill_captures_member_recent_idx
  on public.bill_captures (team_member_id, created_at desc);
create index if not exists bill_captures_status_idx
  on public.bill_captures (status, created_at desc);

-- ---- direct_expenses -------------------------------------------------
-- For product purchases (sales tax visible on receipt) — no W9 needed
-- because sales tax already satisfies state revenue reporting. These
-- ride alongside vendor_documents-based expenses in the reporting.
create table if not exists public.direct_expenses (
  id uuid primary key default gen_random_uuid(),

  team_member_id uuid not null references public.team_members(id) on delete cascade,

  -- "Guitar Center", "Whole Foods", "Shell Gas Station". Free text —
  -- these are merchants we won't have as formal vendors.
  merchant text not null,

  -- Total + the tax portion. Both in cents (integer; avoid float drift).
  amount_cents int not null check (amount_cents >= 0),
  sales_tax_cents int default 0 check (sales_tax_cents >= 0),

  -- Loose category for filtering reports. Free text (with a soft
  -- convention) so we don't have to migrate when Jason invents a new
  -- bucket. Suggestions: 'gear', 'supplies', 'food', 'travel', 'gas',
  -- 'lodging', 'merch', 'other'.
  category text default 'other',

  -- When the purchase happened (date on the receipt). Defaults to today
  -- if classifier couldn't read a date.
  expense_date date not null default current_date,

  description text,    -- "two XLR cables + a stand" if Claude could read it
  receipt_image_path text,  -- pointer back into the captures bucket

  -- Originating capture (nullable; expenses can be hand-added later).
  source_capture_id uuid references public.bill_captures(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger direct_expenses_touch
  before update on public.direct_expenses
  for each row execute function public.touch_updated_at();

create index if not exists direct_expenses_member_date_idx
  on public.direct_expenses (team_member_id, expense_date desc);
create index if not exists direct_expenses_category_idx
  on public.direct_expenses (category, expense_date desc);

-- Now that direct_expenses exists, link bill_captures.routed_expense_id.
alter table public.bill_captures
  add constraint bill_captures_routed_expense_fk
  foreign key (routed_expense_id) references public.direct_expenses(id) on delete set null;

-- ---- RLS + grants ----------------------------------------------------
alter table public.bill_captures enable row level security;
alter table public.direct_expenses enable row level security;

-- Captures: each user sees their own; admins see all (consistent with
-- tasks / google_tasks pattern).
create policy "own captures" on public.bill_captures
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

-- Direct expenses: same scope.
create policy "own expenses" on public.direct_expenses
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

grant select, insert, update, delete on public.bill_captures   to authenticated;
grant select, insert, update, delete on public.direct_expenses to authenticated;

-- ---- Storage bucket --------------------------------------------------
-- Private bucket for capture images. Storage RLS is applied via
-- storage.objects policies; for this app we read/write captures only
-- through the service-role client, so a single permissive policy keyed
-- on bucket_id is enough.
insert into storage.buckets (id, name, public)
values ('captures', 'captures', false)
on conflict (id) do nothing;

-- Allow the service role full access to the captures bucket. Other
-- roles get nothing (the API routes always go through service-role).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'service role manages captures'
  ) then
    create policy "service role manages captures" on storage.objects
      for all
      using (bucket_id = 'captures')
      with check (bucket_id = 'captures');
  end if;
end $$;
