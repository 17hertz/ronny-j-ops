# Supabase migrations

This is the **canonical** location for DB schema changes. Everything else
(old `db/migrations/`, pasting SQL into the dashboard, etc.) should get
deleted and replaced by a proper timestamped file here.

## How the DB is built

1. **Initial schema** — `db/schema.sql` at the repo root. This is the one-time
   bootstrap: run it once in the Supabase SQL editor (or via `psql`) when
   the project is first created. It includes the `team_members` table,
   `team_role` enum, RLS policies, helper functions (`is_team_member`,
   `is_admin`), and all the base tables.

2. **Deltas** — every change after the bootstrap lives in this directory
   as a timestamped migration: `YYYYMMDDHHMMSS_short_description.sql`.
   Apply with:

   ```bash
   supabase db push
   ```

   The CLI tracks which migrations have already run against the linked
   project and only applies new ones.

## Adding a migration

```bash
# Pick a timestamp strictly greater than the latest existing file.
ts=$(date -u +%Y%m%d%H%M%S)
$EDITOR supabase/migrations/${ts}_your_change.sql

# When you're happy, apply it:
supabase db push
```

Make migrations **idempotent** where possible — `create table if not
exists`, `create type if not exists` (via `do` block), `add column if not
exists`. Production already has the tables you're touching; idempotency
means the same file can be re-run in a dev DB without blowing up.

## Adding a new table? Don't forget service_role

The admin client in `lib/supabase/admin.ts` uses the `service_role` key
and bypasses RLS via Postgres grants. New tables need an explicit grant
or you'll get `permission denied for table <name>` from API routes that
use `createAdminClient()`:

```sql
grant all on public.your_new_table to service_role;
```

See `20260422120000_grant_service_role_future_tables.sql` for the event
trigger that tries to do this automatically for future tables, but **add
the explicit grant in your migration anyway** — belt and suspenders.

## Why not one giant schema.sql?

Because we'd have no audit trail of what changed when, and no safe way
to apply incremental changes to prod without risking destructive
re-runs of DDL that's already there. `schema.sql` is a snapshot of the
bootstrap; once applied, all further changes happen as migrations.
