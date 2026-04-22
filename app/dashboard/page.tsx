import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The middleware normally catches this, but belt-and-braces.
  if (!user) redirect("/login");

  // Look up the team_members row so we know who this auth user actually is
  // (and their role). If they signed in but were never invited, show a
  // friendly "you're not on the team yet" screen instead of crashing.
  const { data: teamMember } = await supabase
    .from("team_members")
    .select("id, full_name, role")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!teamMember) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Not on the team
        </p>
        <h1 className="mt-4 font-display text-4xl leading-tight">
          You&apos;re signed in, but not set up yet.
        </h1>
        <p className="mt-4 text-neutral-400">
          Your auth account is active as <strong>{user.email}</strong>, but
          there&apos;s no team member record for you yet. Ping Jason to be
          added.
        </p>
        <div className="mt-8">
          <SignOutButton />
        </div>
      </main>
    );
  }

  // Google accounts this member has connected (if any).
  const { data: googleAccounts } = await supabase
    .from("google_calendar_accounts")
    .select("id, google_email, scope, token_expires_at, updated_at")
    .eq("team_member_id", teamMember.id)
    .order("updated_at", { ascending: false });

  return (
    <main className="mx-auto max-w-5xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Ronny J Ops
        </Link>
        <div className="flex items-center gap-4">
          <span className="text-sm text-neutral-500">
            {teamMember.full_name}{" "}
            <span className="text-neutral-700">·</span>{" "}
            <span className="uppercase tracking-wider text-neutral-600">
              {teamMember.role}
            </span>
          </span>
          <SignOutButton />
        </div>
      </header>

      <section className="mt-12">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Dashboard
        </p>
        <h1 className="mt-4 font-display text-5xl leading-tight">
          Today&apos;s{" "}
          <span className="italic text-brand">schedule</span>
        </h1>
      </section>

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        <Panel
          eyebrow="Calendar"
          title="Google connections"
          cta={
            <Link
              href="/api/google/auth/start"
              className="rounded-md border border-brand bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
            >
              {googleAccounts && googleAccounts.length > 0
                ? "Connect another"
                : "Connect Google Calendar"}
            </Link>
          }
        >
          {googleAccounts && googleAccounts.length > 0 ? (
            <ul className="space-y-2">
              {googleAccounts.map((acct) => (
                <li
                  key={acct.id}
                  className="flex items-center justify-between rounded-md border border-neutral-800 px-3 py-2 text-sm"
                >
                  <span className="text-neutral-200">{acct.google_email}</span>
                  <span className="text-xs text-neutral-600">
                    connected
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              No calendars connected yet. Click <strong>Connect Google
              Calendar</strong> and grant access to the calendar you want
              synced into the ops view.
            </p>
          )}
        </Panel>

        <Panel eyebrow="Up next" title="Today">
          <p className="text-sm text-neutral-500">
            Event sync is not live yet. Once you connect a Google account and
            the sync job runs, today&apos;s schedule will appear here.
          </p>
        </Panel>

        <Panel eyebrow="Tasks" title="Open items">
          <p className="text-sm text-neutral-500">
            The task list view is the next thing on deck after calendar sync
            is working. Nothing to show yet.
          </p>
        </Panel>

        <Panel eyebrow="Reminders" title="Queue">
          <p className="text-sm text-neutral-500">
            The 24h / 1h reminder queue will surface here once the Inngest
            engine is wired up.
          </p>
        </Panel>
      </div>

      <p className="mt-16 text-xs text-neutral-600">
        Built for Ronny J · 2026
      </p>
    </main>
  );
}

function Panel({
  eyebrow,
  title,
  cta,
  children,
}: {
  eyebrow: string;
  title: string;
  cta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
            {eyebrow}
          </p>
          <h2 className="mt-1 font-display text-2xl">{title}</h2>
        </div>
        {cta}
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}
