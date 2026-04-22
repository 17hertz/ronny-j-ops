# Manual setup — Ronny J Ops

This is everything you still need to do by hand. You've already signed up for **Supabase, Inngest, Twilio, and Resend** — good. The steps below finish the config so the code can actually send messages, sync calendars, and collect vendor documents.

Owning entity for every account below: **Ronny J Listen UP LLC**.

---

## 1. Local dev prerequisites

Install once on your machine:

- Node.js 20 LTS (`nvm install 20 && nvm use 20`)
- pnpm or npm (the repo uses `npm` by default)
- Git
- The Supabase CLI: `npm install -g supabase`
- The Inngest CLI (only needed for local dev): `npx inngest-cli@latest dev` runs on demand

Then, in the repo:

```bash
cd ronny-j-ops
cp .env.example .env.local
npm install
```

Leave `.env.local` open — you'll fill it in as you go.

---

## 2. Supabase

You said you've made the project already. Finish these pieces:

1. **Get your keys.** Project Settings → API.
   - `NEXT_PUBLIC_SUPABASE_URL` = the Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the `anon public` key
   - `SUPABASE_SERVICE_ROLE_KEY` = the `service_role` key (server-only, treat like a password)
2. **Run the schema.** Open the Supabase SQL editor, paste the contents of [`db/schema.sql`](db/schema.sql), and run it. You should see ~13 tables created plus RLS policies.
3. **Create the vendor-docs storage bucket.** Storage → Create bucket → `vendor-docs` → keep it **private** (not public). The SQL file includes the policy you need; run it if you want team-authenticated reads.
4. **Enable email auth for the team.** Authentication → Providers → Email. Turn off public sign-ups (Authentication → Settings → "Allow new users to sign up" = off). You'll invite team members from the dashboard instead.
5. **Invite yourself.** Authentication → Users → Invite user → enter your email. Once you accept, run this SQL to promote yourself to owner:
   ```sql
   insert into public.team_members (auth_user_id, full_name, email, role)
   select id, 'Jason', email, 'owner' from auth.users where email = 'jason@17hertz.io';
   ```
6. **Database URL for migrations.** Project Settings → Database → Connection string → URI. That's `SUPABASE_DB_URL`.

---

## 3. Twilio — this is the long pole

**A2P 10DLC registration takes 1–3 weeks.** Start it today.

1. **Get the basic creds.** Twilio Console home → Account SID + Auth Token → into `.env.local`.
2. **Register the brand.** Messaging → Regulatory Compliance → A2P 10DLC → **Register a Brand**.
   - Business type: US LLC
   - Legal Business Name: **Ronny J Listen UP LLC**
   - EIN: (your LLC's EIN)
   - Address, website, contact — all must match what's on the EIN letter and the LLC's Articles of Organization
3. **Register a campaign.** Use case: **Mixed** or **Account Notifications**. Sample messages should include the opt-in language:
   > "Reply STOP to stop, HELP for help. Msg & data rates may apply. Msg frequency varies."
4. **Buy a number and assign it to the campaign.** Phone Numbers → Buy → pick a local US number → assign to the Messaging Service tied to your campaign. Put the number in `TWILIO_SMS_FROM` and the Messaging Service SID in `TWILIO_MESSAGING_SERVICE_SID`.
5. **Wire the status callback.** In your Messaging Service → Integration → set "Status callback URL" to:
   ```
   https://ops.ronnyjlistenup.com/api/webhooks/twilio/status
   ```
   (or your ngrok URL for dev). This lets us mark reminders `delivered` vs `failed`.

**WhatsApp (phase 2, start when SMS is live):** Messaging → Senders → WhatsApp senders → Request access. Requires Meta Business verification (see §6). Until then, the WhatsApp code path stays disabled via env var.

**RCS (phase 2+):** Messaging → RCS → Register an agent. Google has a separate approval flow — don't start this until SMS+WhatsApp are both in production.

---

## 4. Resend

1. **Add a sending domain.** Domains → Add domain → `ronnyjlistenup.com` (or a subdomain like `mail.ronnyjlistenup.com`).
2. **Add the DNS records** Resend gives you to your registrar:
   - One `TXT` record for SPF
   - Three `CNAME` records for DKIM
   - One `TXT` for the custom return-path (DMARC-friendly)
   Wait for all four to go green in the Resend dashboard before sending anything.
3. **API key.** API Keys → Create → scope: "Sending access" → put it in `RESEND_API_KEY`.
4. **From address.** Pick `ops@ronnyjlistenup.com` or similar. Put it in `RESEND_FROM_EMAIL`.

---

## 5. Inngest

You've already got the account. You just need the keys.

1. Dashboard → **Manage → Event Keys** → create one → copy to `INNGEST_EVENT_KEY`.
2. Dashboard → **Manage → Signing Keys** → copy to `INNGEST_SIGNING_KEY`.
3. For local dev, leave these blank and run `npm run inngest:dev` in a second terminal. That starts the Inngest dev server at `http://localhost:8288`, which auto-discovers the functions registered at `/api/inngest` in your Next.js app.
4. When you deploy to Vercel: Inngest → Sync new app → paste your production URL (`https://ops.ronnyjlistenup.com/api/inngest`). Inngest will do a handshake using the signing key.

---

## 6. Google Cloud (Calendar OAuth)

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a new project named **Ronny J Ops**.
2. **Enable APIs.** APIs & Services → Library → enable:
   - Google Calendar API
   - Google People API (used for contact names on events)
3. **OAuth consent screen.**
   - User type: **External**
   - App name: **Ronny J Ops**
   - User support email: yours
   - Developer contact: yours
   - Add scopes: `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/calendar.events`
   - Add test users: every team member who will connect a calendar (until you verify the app, only test users can authorize)
4. **Credentials.** Credentials → Create credentials → OAuth client ID → Web application.
   - Authorized redirect URIs:
     - `http://localhost:3000/api/google/callback`
     - `https://ops.ronnyjlistenup.com/api/google/callback`
   - Client ID → `GOOGLE_CLIENT_ID`
   - Client secret → `GOOGLE_CLIENT_SECRET`

App verification (the blue banner goes away) requires a privacy policy + demo video + security review. That's a week-of-work side quest — skip it until the team is bigger than 4 people (test-users cap).

---

## 7. Meta Business (WhatsApp) — phase 2

Don't start this until SMS is live.

1. business.facebook.com → Create business → **Ronny J Listen UP LLC**
2. Business Verification → upload Articles of Organization + EIN letter + utility bill for the LLC's address. Approval: 1–3 weeks.
3. In Twilio: Messaging → Senders → WhatsApp senders → Start onboarding → link your Meta Business.
4. Submit your first 3 message templates for approval (24h, 1h reminder, appointment confirmation). Template approval: a few hours to a day.

---

## 8. iCloud mirror

Apple won't let server code authenticate to CalDAV cleanly (app-specific passwords leak badly). Use this pattern instead:

1. On the team member's iPhone → Settings → Calendar → Accounts → Add account → Google.
2. Log in with the Google account whose calendar you want mirrored.
3. Flip the Calendars toggle on.

Now iOS pulls Google calendar events into the native iCloud calendar app automatically, bidirectionally. No server code needed.

---

## 9. Domain + DNS

1. Buy `ronnyjlistenup.com` (or the subdomain `ops.ronnyjlistenup.com`).
2. Point it at Vercel (we'll wire Vercel in §10).
3. Add Resend's DNS records (§4).
4. Optional: add a SendGrid/Google-Workspace MX if Ronny wants inbound email, but that's a separate flow.

---

## 10. Vercel (hosting)

1. Push this repo to GitHub (`gh repo create ronnyjlistenup/ronny-j-ops --private --source .`).
2. vercel.com → Add New → Project → import the repo.
3. Framework preset: Next.js (auto-detected).
4. Environment variables: paste every key from `.env.local` into the Production and Preview environments.
5. Add the custom domain `ops.ronnyjlistenup.com` → Vercel gives you a CNAME → add it at your registrar.
6. First deploy. Once it's green, update the redirect URIs in Google Cloud (§6) and the webhook URLs in Twilio (§3) to the production domain.

---

## 11. Final check

Once you've done all of the above:

```bash
npm run typecheck   # no TS errors
npm run dev          # http://localhost:3000 should render the home page
# in a second terminal:
npm run inngest:dev  # dev server at http://localhost:8288
```

If the home page renders and the Inngest dev server says "App connected" at the top, you're ready to start on the reminder engine and calendar sync.

---

## 12. Legal / compliance check — do NOT skip

- **TCPA:** every SMS recipient must have given opt-in. Track the timestamp in `contacts.sms_consent_at`. The vendor intake form will collect this for vendors; Ronny's personal contacts need it added manually until you build an opt-in flow.
- **CAN-SPAM:** every email must have an unsubscribe link and a physical mailing address in the footer. The Resend email templates include this.
- **W9 data:** store only the last 4 of SSN/EIN in plaintext. Encrypt the full number using pgsodium (Supabase → Database → Extensions → enable `pgsodium` → use `vault.encrypted_columns`). Retain W9s for 4 years per IRS rules.
- **Privacy policy:** required for Google OAuth verification and by default for CAN-SPAM. Draft needed before launch.

---

That's the manual list. The rest (the actual reminder engine, calendar sync, vendor portal, agent wiring) is code — which you'll build next.
