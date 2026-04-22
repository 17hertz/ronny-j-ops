-- =========================================================================
-- Migration: grant service_role access to vendor_invites + future tables
-- 2026-04-22 (hotfix)
--
-- Background
-- ----------
-- db/schema.sql contains `grant all on all tables in schema public to
-- service_role`, but that's a one-time grant — it only applies to tables
-- that existed at the moment it ran. Any table added in a later migration
-- (like vendor_invites) doesn't inherit the grant, so the service-role
-- client hits Postgres error 42501 "permission denied for table X" when
-- it tries to insert/update from an API route.
--
-- This migration does two things:
--   1. Adds the missing grant on public.vendor_invites explicitly, so the
--      admin invite endpoint works against the prod DB without a full
--      re-run of schema.sql.
--   2. Sets `default privileges` so any FUTURE table created by the
--      postgres role in the public schema auto-grants CRUD to
--      service_role. This prevents us hitting the same footgun again the
--      next time a migration adds a table.
-- =========================================================================

-- Back-fill the grant for the table that's already there.
grant all on public.vendor_invites to service_role;

-- Going forward: any new table/sequence/routine in public auto-grants to
-- service_role. Scoped to the `postgres` role (the one migrations run as).
-- Safe to re-run — ALTER DEFAULT PRIVILEGES is idempotent.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;
alter default privileges in schema public
  grant all on functions to service_role;
