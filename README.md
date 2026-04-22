# Ronny J Ops

Team operations system for **Ronny J Listen UP LLC** — task list, Google Calendar sync, multi-channel appointment reminders (SMS / WhatsApp / RCS / email), and a public vendor intake portal with W9 + invoice upload.

## Stack

- **Next.js 14** (App Router) + TypeScript + Tailwind
- **Supabase** — Postgres, auth, storage, RLS
- **Inngest** — durable scheduled jobs (reminders)
- **Twilio** — SMS (A2P 10DLC), WhatsApp, RCS
- **Resend** — transactional email
- **Google Calendar API** — source-of-truth calendar
- **Claude Agent SDK** — the ops agent itself

## Quick start

```bash
cp .env.example .env.local
# fill in keys — see MANUAL_SETUP.md
npm install
npm run dev
```

In a second terminal:

```bash
npm run inngest:dev
```

Open <http://localhost:3000>.

## Project layout

```
app/                 Next.js routes (App Router)
  api/               Route handlers (webhooks, OAuth callbacks)
  dashboard/         Team dashboard (auth-gated)
  vendors/           Public vendor intake portal
components/          Reusable UI
lib/
  supabase/          Browser, server, and admin (service-role) clients
  twilio/            Multi-channel sender (SMS/WhatsApp/RCS)
  resend/            Email templates + sender
  google/            Calendar OAuth + sync
  inngest/           Client singleton + function registry
  agent/             Claude Agent SDK tools
db/
  schema.sql         Postgres schema + RLS policies
inngest/             Inngest function definitions (reminder scheduler etc.)
types/
  supabase.ts        Generated DB types (run `npm run db:types`)
```

## Docs

- [`architecture.md`](../architecture.md) — the full technical plan
- [`MANUAL_SETUP.md`](MANUAL_SETUP.md) — one-time account + DNS setup
