import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";
import { SyncNowButton } from "./sync-now-button";
import { TaskCheckbox } from "./task-checkbox";
import {
  labelFor,
  type ServiceCategoryId,
} from "@/lib/vendors/service-categories";

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

  // Next 7 days of events across every connected calendar. Lower bound is
  // "now" so we don't clutter the view with events that already ended; upper
  // bound is end-of-day-7-days-out. Ordering is chronological so the render
  // step can group by day in-order.
  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  weekEnd.setHours(23, 59, 59, 999);

  const { data: upcomingEvents } = (await supabase
    .from("events")
    .select("id, title, location, starts_at, ends_at, timezone")
    .gte("ends_at", now.toISOString())
    .lte("starts_at", weekEnd.toISOString())
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

  // Group by local calendar date so each day becomes its own sub-list.
  // We key on ISO YYYY-MM-DD in the event's own timezone when available,
  // otherwise America/New_York — this avoids events shifting across the
  // midnight boundary because the server rendered them in UTC.
  const eventsByDay = new Map<
    string,
    NonNullable<typeof upcomingEvents>[number][]
  >();
  for (const ev of upcomingEvents ?? []) {
    const key = localDateKey(ev.starts_at, ev.timezone);
    const list = eventsByDay.get(key) ?? [];
    list.push(ev);
    eventsByDay.set(key, list);
  }
  const eventDayKeys = Array.from(eventsByDay.keys());

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
          status: "needsAction" | "completed";
        }>
      | null;
  };

  // Reminders queue — scheduled sends in the next 7 days. Shows what the
  // engine will fire and when, so Jason can sanity-check scheduling.
  // Admin client bypasses RLS for this read — reminders don't have a direct
  // team_member_id column so we can't scope via RLS easily yet.
  const { data: queuedReminders } = (await supabase
    .from("reminders")
    .select(
      "id, send_at, offset_minutes, status, event:events(title), contact:contacts(full_name)"
    )
    .eq("status", "scheduled")
    .gte("send_at", now.toISOString())
    .lte("send_at", weekEnd.toISOString())
    .order("send_at", { ascending: true })
    .limit(10)) as {
    data:
      | Array<{
          id: string;
          send_at: string;
          offset_minutes: number;
          status: string;
          event: { title: string } | null;
          contact: { full_name: string } | null;
        }>
      | null;
  };

  // Recent dispatches — the "sent" log. Useful to see deliverability at a
  // glance (bounces, opt-outs, actual sends).
  const { data: recentDispatches } = (await supabase
    .from("reminder_dispatches")
    .select("id, channel, status, error, sent_at, created_at")
    .order("created_at", { ascending: false })
    .limit(10)) as {
    data:
      | Array<{
          id: string;
          channel: string;
          status: string;
          error: string | null;
          sent_at: string | null;
          created_at: string;
        }>
      | null;
  };

  // Vendors awaiting review — the "approve this payout-eligible vendor"
  // queue Jason/Ronny work. Only pull submitted + in_review so the panel
  // doesn't fill with already-decided rows.
  const { data: pendingVendors } = (await supabase
    .from("vendors")
    .select(
      "id, legal_name, contact_email, service_category, status, submitted_at, ach_account_last4, secondary_payment_method, tin_match_status"
    )
    .in("status", ["submitted", "in_review"])
    .order("submitted_at", { ascending: true })
    .limit(10)) as {
    data:
      | Array<{
          id: string;
          legal_name: string;
          contact_email: string;
          service_category: string | null;
          status: string;
          submitted_at: string | null;
          ach_account_last4: string | null;
          secondary_payment_method: string | null;
          tin_match_status: string | null;
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

        <Panel eyebrow="Up next" title="Next 7 days">
          {eventDayKeys.length > 0 ? (
            <div className="space-y-4">
              {eventDayKeys.map((dayKey) => (
                <div key={dayKey}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-600">
                    {formatDayHeader(dayKey)}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {eventsByDay.get(dayKey)!.map((ev) => (
                      <li
                        key={ev.id}
                        className="rounded-md border border-neutral-800 px-3 py-2 text-sm"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-medium text-neutral-100">
                            {ev.title}
                          </span>
                          <span className="font-mono text-xs text-neutral-500">
                            {formatEventWindow(
                              ev.starts_at,
                              ev.ends_at,
                              ev.timezone
                            )}
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
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-neutral-500">
              {googleAccounts && googleAccounts.length > 0
                ? "Nothing on the calendar for the next 7 days."
                : "Connect a Google Calendar and upcoming events will appear here."}
            </p>
          )}
        </Panel>

        <Panel eyebrow="Google Tasks" title="Open items">
          {openTasks && openTasks.length > 0 ? (
            <ul className="space-y-2">
              {openTasks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 px-3 py-2 text-sm"
                >
                  <TaskCheckbox
                    taskId={t.id}
                    initialStatus={t.status}
                    title={t.title}
                  />
                  <span className="shrink-0 font-mono text-xs text-neutral-500">
                    {formatTaskDue(t.due_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              {googleAccounts && googleAccounts.length > 0
                ? "No open Google Tasks. Click Sync now to pull the latest — if you connected before the write scope was added, reconnect Google so check-offs can flow back to tasks.google.com."
                : "Connect a Google account and your Google Tasks will mirror here."}
            </p>
          )}
        </Panel>

        <Panel eyebrow="Reminders" title="Queue">
          {queuedReminders && queuedReminders.length > 0 ? (
            <ul className="space-y-2">
              {queuedReminders.map((r) => (
                <li
                  key={r.id}
                  className="rounded-md border border-neutral-800 px-3 py-2 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium text-neutral-100">
                      {r.event?.title ?? "(event missing)"}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-neutral-500">
                      {formatSendAt(r.send_at)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    {r.contact?.full_name ?? "(contact missing)"} ·{" "}
                    {r.offset_minutes >= 1440 ? "24h" : "1h"} out
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              No reminders queued for the next 7 days. Reminders are scheduled
              automatically when a contact is attached to a calendar event
              (via the intake portal, coming soon).
            </p>
          )}
        </Panel>

        <Panel eyebrow="Reminders" title="Recent sends">
          {recentDispatches && recentDispatches.length > 0 ? (
            <ul className="space-y-2">
              {recentDispatches.map((d) => (
                <li
                  key={d.id}
                  className="rounded-md border border-neutral-800 px-3 py-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono uppercase tracking-wider text-neutral-400">
                      {d.channel}
                    </span>
                    <span
                      className={`font-mono ${
                        d.status === "sent" || d.status === "delivered"
                          ? "text-emerald-400"
                          : d.status === "failed" || d.status === "bounced"
                            ? "text-red-400"
                            : "text-neutral-500"
                      }`}
                    >
                      {d.status}
                    </span>
                    <span className="text-neutral-600">
                      {formatRelative(d.sent_at ?? d.created_at)}
                    </span>
                  </div>
                  {d.error && (
                    <p className="mt-1 truncate text-red-400">{d.error}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              No reminders have been sent yet. Once attendees are attached to
              sessions, 24h and 1h reminders will show up here.
            </p>
          )}
        </Panel>

        <Panel
          eyebrow="Vendors"
          title="Awaiting review"
          cta={
            <div className="flex items-center gap-2">
              <Link
                href="/dashboard/vendors/invite"
                className="rounded-md border border-brand bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
              >
                Invite vendor
              </Link>
              <Link
                href="/dashboard/vendors"
                className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-brand hover:text-brand"
              >
                View all
              </Link>
            </div>
          }
        >
          {pendingVendors && pendingVendors.length > 0 ? (
            <ul className="space-y-2">
              {pendingVendors.map((v) => (
                <li key={v.id}>
                  <Link
                    href={`/dashboard/vendors/${v.id}`}
                    className="block rounded-md border border-neutral-800 px-3 py-2 text-sm transition hover:border-brand"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-neutral-100">
                          {v.legal_name}
                        </div>
                        <div className="truncate text-xs text-neutral-500">
                          {labelFor(
                            v.service_category as ServiceCategoryId | null
                          )}
                          {v.contact_email && (
                            <>
                              {" · "}
                              <span className="text-neutral-600">
                                {v.contact_email}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <span
                        className={`font-mono text-[10px] uppercase tracking-wider ${
                          v.status === "in_review"
                            ? "text-amber-400"
                            : "text-neutral-500"
                        }`}
                      >
                        {v.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-neutral-600">
                      {v.ach_account_last4 && (
                        <span>ACH ···{v.ach_account_last4}</span>
                      )}
                      {v.secondary_payment_method && (
                        <span>+{v.secondary_payment_method}</span>
                      )}
                      {v.tin_match_status &&
                        v.tin_match_status !== "pending" && (
                          <span
                            className={
                              v.tin_match_status === "match"
                                ? "text-emerald-500"
                                : "text-red-400"
                            }
                          >
                            TIN: {v.tin_match_status}
                          </span>
                        )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              No vendors awaiting review. When someone submits the intake
              form, they&apos;ll land here for Jason or Ronny to approve.
            </p>
          )}
        </Panel>
      </div>

      <p className="mt-16 text-xs text-neutral-600">
        Built for Ronny J · 2026
      </p>
    </main>
  );
}

/**
 * Produce an ISO-ish day key ("YYYY-MM-DD") for grouping events, using the
 * event's own timezone so an 11pm LA event doesn't get bucketed into
 * "tomorrow" relative to the server's UTC clock. Falls back to Eastern
 * (our default ops timezone) when the event has no zone attached.
 */
function localDateKey(isoTimestamp: string, timezone: string | null): string {
  const tz = timezone || "America/New_York";
  // `en-CA` yields YYYY-MM-DD which is conveniently sortable.
  return new Date(isoTimestamp).toLocaleDateString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * Human-readable header for a day group: "Today", "Tomorrow", or
 * "Thu, Apr 24" style. Input is the YYYY-MM-DD key produced above.
 */
function formatDayHeader(dayKey: string): string {
  // Parse the key as a date in the *viewer's* local zone so the "Today" /
  // "Tomorrow" labels match what the user expects to see on their wall clock.
  const [y, m, d] = dayKey.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = Math.round((day.getTime() - today.getTime()) / msPerDay);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return day.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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

/**
 * Compact "in Xh" / "tomorrow 3pm" style for reminder send times.
 */
function formatSendAt(iso: string): string {
  const d = new Date(iso);
  const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
  if (diffMin < 60) return `in ${Math.max(1, diffMin)}m`;
  if (diffMin < 60 * 24) return `in ${Math.round(diffMin / 60)}h`;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * "3m ago" / "2h ago" / date — for the recent-dispatches log.
 */
function formatRelative(iso: string): string {
  const d = new Date(iso);
  const ago = Math.round((Date.now() - d.getTime()) / 60000);
  if (ago < 60) return `${Math.max(1, ago)}m ago`;
  if (ago < 60 * 24) return `${Math.round(ago / 60)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
