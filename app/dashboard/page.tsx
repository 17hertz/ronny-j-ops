import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";
import { SyncNowButton } from "./sync-now-button";

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
  //
  // The `as` cast is pending real supabase types — see note in
  // app/api/google/callback/route.ts.
  const { data: teamMember } = (await supabase
    .from("team_members")
    .select("id, full_name, role")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; full_name: string; role: string } | null;
  };

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
  const { data: googleAccounts } = (await supabase
    .from("google_calendar_accounts")
    .select("id, google_email, scope, token_expires_at, updated_at")
    .eq("team_member_id", teamMember.id)
    .order("updated_at", { ascending: false })) as {
    data:
      | Array<{
          id: string;
          google_email: string;
          scope: string;
          token_expires_at: string;
          updated_at: string;
        }>
      | null;
  };

  // Today's events across every connected calendar. We bound both edges:
  //   - starts_at < end-of-local-day  (event hasn't begun after today)
  //   - ends_at   > start-of-local-day (event hasn't already finished)
  // This correctly surfaces multi-hour / multi-day events that span today.
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const { data: todayEvents } = (await supabase
    .from("events")
    .select("id, title, location, starts_at, ends_at, timezone")
    .lte("starts_at", endOfDay.toISOString())
    .gte("ends_at", startOfDay.toISOString())
    .order("starts_at", { ascending: true })) as {
    data:
      | Array<{
          id: string;
          title: string;
          location: string | null;
          starts_at: string;
          ends_at: string;
          timezone: string;
        }>
      | null;
  };

  // Open Google Tasks for this user — due soon or overdue, status=needsAction.
  // Capped at 10 so the panel doesn't blow up on heavy backlogs.
  const { data: openTasks } = (await supabase
    .from("google_tasks")
    .select("id, title, due_at, status")
    .eq("team_member_id", teamMember.id)
    .eq("status", "needsAction")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(10)) as {
    data:
      | Array<{
          id: string;
          title: string;
          due_at: string | null;
          status: string;
        }>
      | null;
  };

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
            <>
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
              <div className="mt-4">
                <SyncNowButton />
              </div>
            </>
          ) : (
            <p className="text-sm text-neutral-500">
              No calendars connected yet. Click <strong>Connect Google
              Calendar</strong> and grant access to the calendar you want
              synced into the ops view.
            </p>
          )}
        </Panel>

        <Panel eyebrow="Up next" title="Today">
          {todayEvents && todayEvents.length > 0 ? (
            <ul className="space-y-2">
              {todayEvents.map((ev) => (
                <li
                  key={ev.id}
                  className="rounded-md border border-neutral-800 px-3 py-2 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-neutral-100">
                      {ev.title}
                    </span>
                    <span className="font-mono text-xs text-neutral-500">
                      {formatEventWindow(ev.starts_at, ev.ends_at, ev.timezone)}
                    </span>
                  </div>
                  {ev.location && (
                    <p className="mt-1 text-xs text-neutral-500">
                      {ev.location}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              {googleAccounts && googleAccounts.length > 0
                ? "Nothing on the calendar for today. Click Sync now in the Calendar panel to pull in the latest."
                : "Connect a Google Calendar and today's events will appear here."}
            </p>
          )}
        </Panel>

        <Panel eyebrow="Google Tasks" title="Open items">
          {openTasks && openTasks.length > 0 ? (
            <ul className="space-y-2">
              {openTasks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-baseline justify-between gap-3 rounded-md border border-neutral-800 px-3 py-2 text-sm"
                >
                  <span className="text-neutral-100">{t.title}</span>
                  <span className="font-mono text-xs text-neutral-500">
                    {formatTaskDue(t.due_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              {googleAccounts && googleAccounts.length > 0
                ? "No open Google Tasks. Click Sync now to pull the latest — if you connected before Tasks support shipped, you'll need to reconnect Google to grant the extra scope."
                : "Connect a Google account and your Google Tasks will mirror here (read-only)."}
            </p>
          )}
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

/**
 * Render a task's due date. Tasks without due dates are rendered as "—".
 * Overdue tasks get a compact "past due" label rather than a calendar date
 * so the panel communicates urgency at a glance.
 */
function formatTaskDue(dueAt: string | null): string {
  if (!dueAt) return "—";
  const due = new Date(dueAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysOut = Math.round((due.getTime() - today.getTime()) / msPerDay);
  if (daysOut < 0) return "past due";
  if (daysOut === 0) return "today";
  if (daysOut === 1) return "tomorrow";
  if (daysOut < 7) return `in ${daysOut}d`;
  return due.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Render "9:00–10:30 AM" style windows. Falls back to "all day" if the
 * event spans a full calendar day (Google all-day events come in as 00:00
 * to 00:00 the next day).
 */
function formatEventWindow(
  startsAt: string,
  endsAt: string,
  timezone: string
): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const durationMs = end.getTime() - start.getTime();
  if (durationMs >= 23 * 60 * 60 * 1000) return "all day";

  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "America/New_York",
    });
  return `${fmt(start)} – ${fmt(end)}`;
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
