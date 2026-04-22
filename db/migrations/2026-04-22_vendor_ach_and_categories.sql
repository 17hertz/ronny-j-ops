  -- =========================================================================
  -- Migration: vendor ACH + service categories (v2 — defensive)
  -- 2026-04-22
  --
  -- State as of pre-migration:
  --   - public.vendors exists (but without any service/ACH/secondary fields)
  --   - public.vendor_documents exists
  --   - None of the vendor enums exist yet (columns were plain text with CHECKs)
  --
  -- This migration:
  --   1. Creates public.vendor_payment_method with 'ach' already included
  --   2. Creates public.vendor_service_category
  --   3. Adds all the new columns to vendors (idempotent — safe to re-run)
  --
  -- Idempotent via DO-blocks (for types) and ADD COLUMN IF NOT EXISTS.
  -- =========================================================================

  -- 1. vendor_payment_method enum -------------------------------------------
  do $$
  begin
    if not exists (select 1 from pg_type where typname = 'vendor_payment_method') then
      create type public.vendor_payment_method as enum (
        'ach','paypal','venmo','zelle','other'
      );
    end if;
  end $$;

  -- 2. vendor_service_category enum -----------------------------------------
  do $$
  begin
    if not exists (select 1 from pg_type where typname = 'vendor_service_category') then
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
    end if;
  end $$;

  -- 3. Columns on vendors ---------------------------------------------------
  alter table public.vendors
    add column if not exists service_category public.vendor_service_category,
    add column if not exists service_notes text,
    add column if not exists ach_account_holder_name text,
    add column if not exists ach_routing_last4 text,
    add column if not exists ach_account_last4 text,
    add column if not exists ach_account_type text
      check (ach_account_type in ('checking','savings')),
    add column if not exists ach_bank_name text,
    add column if not exists ach_bank_details_encrypted bytea,
    add column if not exists secondary_payment_method public.vendor_payment_method,
    add column if not exists secondary_payment_handle text;
