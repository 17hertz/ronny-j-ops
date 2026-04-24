import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";
import { SyncNowButton } from "./sync-now-button";
import { TestSmsButton } from "./test-sms-button";
import {
  UpNextRangePicker,
  type UpNextRange,
} from "./up-next-range-picker";
import { UpNextPager } from "./up-next-pager";
import { NewTaskForm } from "./new-task-form";
import { NewEventForm } from "./new-event-form";
import { ReconnectBanner } from "./reconnect-banner";
import { CompletedTodaySection } from "./completed-today-section";
import { listCompletedTodayForMember } from "@/lib/tasks/service";
import { SyncErrorsPanel } from "./sync-errors-panel";
import { EventShareToggle } from "./event-share-toggle";
import { TaskCheckbox } from "./task-checkbox";
import {
  labelFor,
  type ServiceCategoryId,
} from "@/lib/vendors/service-categories";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: { range?: string; google?: string; page?: string };
}) {
  // "Up next" range — URL-driven so the state survives refresh and is
  // bookmarkable. Default is 7d (matches historical behavior).
  const rangeParam = searchParams?.range;
  const upNextRange: UpNextRange =
    rangeParam === "today" ||
    rangeParam === "30d" ||
    rangeParam === "year"
      ? rangeParam
      : "7d";

  // Pagination page index (0-indexed). Guarded to stay non-negative — a
  // negative or non-numeric value falls back to page 0.
  const upNextPage = Math.max(0, parseInt(searchParams?.page ?? "0", 10) || 0);
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
    .select("id, full_name, role, timezone")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: {
      id: string;
      full_name: string;
      role: string;
      timezone: string;
    } | null;
  };

  // Viewer's timezone — drives day grouping + time rendering everywhere
  // on this dashboard so Jason (PT) and Ronny (ET) each see their own
  // local wall-clock view of the same underlying event data.
  const viewerTz = teamMember?.timezone ?? "America/New_York";

  if (!teamMember) {
    // Before showing "not on the team", check if this auth user is actually a
    // VENDOR who ended up here by accident — e.g. they used the generic
    // /login magic link (which hardcodes ?next=/dashboard) rather than the
    // vendor-specific entry at /vendors/login. Happens often enough that we
    // just auto-route them instead of making them re-authenticate. The
    // "vendor self read" RLS policy scopes this to their own row.
    const { data: vendorSelf } = (await supabase
      .from("vendors")
      .select("id")
      .eq("auth_user_id", user.id)
      .maybeSingle()) as { data: { id: string } | null };

    if (vendorSelf) {
      redirect("/vendors/account");
    }

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

  // Google accounts this member has connected (if any). `needs_reconnect`
  // drives the yellow banner at the top of the dashboard when a refresh
  // token has died; `last_auth_error_at` is shown in the banner tooltip
  // for debugging.
  const { data: googleAccounts } = (await supabase
    .from("google_calendar_accounts")
    .select(
      "id, google_email, scope, token_expires_at, updated_at, needs_reconnect, last_auth_error_at"
    )
    .eq("team_member_id", teamMember.id)
    .order("updated_at", { ascending: false })) as {
    data:
      | Array<{
          id: string;
          google_email: string;
          scope: string;
          token_expires_at: string;
          updated_at: string;
          needs_reconnect: boolean;
          last_auth_error_at: string | null;
        }>
      | null;
  };

  const accountsNeedingReconnect = (googleAccounts ?? []).filter(
    (a) => a.needs_reconnect
  );

  // Up-next events across every connected calendar. Lower bound is "now"
  // (we don't clutter the view with events that already ended); upper
  // bound depends on the selected range. Ordering is chronological so the
  // render step can group by day in-order.
  const now = new Date();
  const rangeEnd = new Date(now);
  switch (upNextRange) {
    case "today":
      // End of today (local-ish) — we don't know the user's zone here, so
      // we approximate with end-of-UTC-day. Fine for the dashboard view;
      // the digest cron is the tz-aware path.
      rangeEnd.setHours(23, 59, 59, 999);
      break;
    case "30d":
      rangeEnd.setDate(rangeEnd.getDate() + 30);
      rangeEnd.setHours(23, 59, 59, 999);
      break;
    case "year":
      rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);
      break;
    case "7d":
    default:
      rangeEnd.setDate(rangeEnd.getDate() + 7);
      rangeEnd.setHours(23, 59, 59, 999);
      break;
  }

  // Privacy filter: show only events the viewer created OR events
  // explicitly shared with the team. `.or()` in Supabase-js composes as
  // an OR-group. `shared` boolean + `created_by` column were added in
  // migration 20260423170000_events_sharing.sql.
  const { data: upcomingEvents } = (await supabase
    .from("events")
    .select("id, title, location, starts_at, ends_at, timezone, created_by, shared")
    .gte("ends_at", now.toISOString())
    .lte("starts_at", rangeEnd.toISOString())
    .or(`created_by.eq.${teamMember.id},shared.eq.true`)
    .order("starts_at", { ascending: true })) as {
    data:
      | Array<{
          id: string;
          title: string;
          location: string | null;
          starts_at: string;
          ends_at: string;
          timezone: string;
          created_by: string | null;
          shared: boolean;
        }>
      | null;
  };

  // Pagination: slice the chronological list into pages of 12. Pagination
  // only renders when there's more than one page — for most weeks with
  // <12 events the pager stays hidden. Slicing by raw event count (vs by
  // calendar day) means a day's events can span two pages in extreme
  // cases, but keeps the visible list stable at 12 items per render.
  const UP_NEXT_PAGE_SIZE = 12;
  const allUpcoming = upcomingEvents ?? [];
  const totalUpNextPages = Math.max(
    1,
    Math.ceil(allUpcoming.length / UP_NEXT_PAGE_SIZE)
  );
  // Clamp page index if someone hand-edits the URL past the end.
  const currentUpNextPage = Math.min(upNextPage, totalUpNextPages - 1);
  const pagedUpcomingEvents = allUpcoming.slice(
    currentUpNextPage * UP_NEXT_PAGE_SIZE,
    (currentUpNextPage + 1) * UP_NEXT_PAGE_SIZE
  );

  // Group by local calendar date so each day becomes its own sub-list.
  // We key on ISO YYYY-MM-DD in the event's own timezone when available,
  // otherwise America/New_York — this avoids events shifting across the
  // midnight boundary because the server rendered them in UTC.
  const eventsByDay = new Map<
    string,
    NonNullable<typeof upcomingEvents>[number][]
  >();
  // Group only the paged slice — each page's by-day view is independent.
  // Using viewerTz (not the event's own stored timezone) so the dashboard
  // buckets events into the viewer's calendar days — matches Google
  // Calendar's UX where "tomorrow at noon PT" shows on PT-tomorrow
  // regardless of the event's intrinsic zone.
  for (const ev of pagedUpcomingEvents) {
    const key = localDateKey(ev.starts_at, viewerTz);
    const list = eventsByDay.get(key) ?? [];
    list.push(ev);
    eventsByDay.set(key, list);
  }
  const eventDayKeys = Array.from(eventsByDay.keys());

  // Completed-today recap — powers the collapsible section inside the
  // Tasks panel. Uses the service's zone-aware "today" window so a late-
  // night completion stays in today's recap until the real 00:00 ET.
  const completedToday = await listCompletedTodayForMember({
    teamMemberId: teamMember.id,
  });

  // Errored push rows — tasks + events that failed to sync to Google
  // and are sitting at push_status='error'. Shown in the SyncErrorsPanel
  // at the top of the dashboard so infrastructure hiccups are visible
  // BEFORE Ronny notices. 'skip' rows (scope/permission issues) are NOT
  // included — those need a Google reconnect via the banner above.
  const { data: erroredTasks } = (await supabase
    .from("tasks")
    .select("id, title, push_error, last_push_attempt_at")
    .eq("team_member_id", teamMember.id)
    .eq("push_status", "error")
    .order("last_push_attempt_at", { ascending: false })
    .limit(20)) as {
    data: Array<{
      id: string;
      title: string;
      push_error: string | null;
      last_push_attempt_at: string | null;
    }> | null;
  };

  const { data: erroredEvents } = (await supabase
    .from("events")
    .select("id, title, push_error, last_push_attempt_at, starts_at")
    .eq("created_by", teamMember.id)
    .eq("push_status", "error")
    .order("last_push_attempt_at", { ascending: false })
    .limit(20)) as {
    data: Array<{
      id: string;
      title: string;
      push_error: string | null;
      last_push_attempt_at: string | null;
      starts_at: string;
    }> | null;
  };

  // Open tasks for this user — needsAction, due soon or overdue. Reads
  // from the unified public.tasks SoT (Google-synced + locally-created
  // both show up here). Cancelled rows are excluded. Capped at 10 so
  // the panel doesn't blow up on heavy backlogs.
  const { data: openTasks } = (await supabase
    .from("tasks")
    .select("id, title, due_at, status, source")
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
          source: string;
        }>
      | null;
  };

  // Reminders queue — scheduled sends in the next 7 days. Shows what the
  // engine will fire and when, so Jason can sanity-check scheduling.
  // Fixed 7d window regardless of the "Up next" range picker — the
  // reminder engine's own horizon is tighter than a 30d / year view
  // would imply.
  const reminderWindowEnd = new Date(now);
  reminderWindowEnd.setDate(reminderWindowEnd.getDate() + 7);
  reminderWindowEnd.setHours(23, 59, 59, 999);

  const { data: queuedReminders } = (await supabase
    .from("reminders")
    .select(
      "id, send_at, offset_minutes, status, event:events(title), contact:contacts(full_name)"
    )
    .eq("status", "scheduled")
    .gte("send_at", now.toISOString())
    .lte("send_at", reminderWindowEnd.toISOString())
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

  // Pending invoices — approved vendors have submitted invoices that need
  // Jason/Ronny's eyes. Mirrors the vendor-review panel's pattern. Capped
  // at 20 so the panel stays readable even during a busy week.
  const { data: pendingInvoices } = (await supabase
    .from("vendor_documents")
    .select(
      `
      id,
      invoice_number,
      invoice_amount_cents,
      invoice_status,
      submitted_at,
      vendor:vendors ( id, legal_name )
      `
    )
    .eq("kind", "invoice")
    .in("invoice_status", ["submitted", "under_review"])
    .order("submitted_at", { ascending: false })
    .limit(20)) as {
    data:
      | Array<{
          id: string;
          invoice_number: string | null;
          invoice_amount_cents: number | null;
          invoice_status: string | null;
          submitted_at: string | null;
          vendor: { id: string; legal_name: string } | null;
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

      {/* Auth-health banner — surfaces only when a connected Google
          account's refresh token has died. Non-disruptive yellow, not
          red, because this is a remedyable state. */}
      {accountsNeedingReconnect.length > 0 && (
        <div className="mt-6">
          <ReconnectBanner accounts={accountsNeedingReconnect} />
        </div>
      )}

      {/* Sync-errors panel — tasks + events that failed to push to
          Google. Hidden entirely when empty so normal operation shows
          a clean dashboard. */}
      <div className="mt-6">
        <SyncErrorsPanel
          erroredTasks={erroredTasks ?? []}
          erroredEvents={erroredEvents ?? []}
        />
      </div>

      <section className="mt-12 flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
            Dashboard
          </p>
          <h1 className="mt-4 font-display text-5xl leading-tight">
            Today&apos;s{" "}
            <span className="italic text-brand">schedule</span>
          </h1>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Link
            href="/dashboard/team/invite"
            className="rounded-md border border-neutral-800 px-4 py-2 text-sm text-neutral-300 transition hover:border-brand hover:text-brand"
          >
            + Add teammate
          </Link>
          <Link
            href="/dashboard/chat"
            className="rounded-md border border-brand bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            Ask the ops agent →
          </Link>
        </div>
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
              <div className="mt-4 space-y-3">
                <SyncNowButton />
                {/* Sends today's events + tasks to your team_members.phone.
                    Preview-only when SMS_ENABLED=false. */}
                <TestSmsButton />
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

        <Panel
          eyebrow="Up next"
          title={
            upNextRange === "today"
              ? "Today"
              : upNextRange === "30d"
                ? "Next 30 days"
                : upNextRange === "year"
                  ? "Next 12 months"
                  : "Next 7 days"
          }
          cta={<UpNextRangePicker current={upNextRange} />}
        >
          {/* Inline add-event form. Collapsed by default; click "Add
              event" to reveal. Uses the viewer's timezone so wall-clock
              inputs land correctly regardless of server zone. */}
          <NewEventForm viewerTz={viewerTz} />

          {eventDayKeys.length > 0 ? (
            <div className="space-y-4">
              {eventDayKeys.map((dayKey) => (
                <div key={dayKey}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-600">
                    {/* Label computed in the VIEWER's tz so Jason (PT)
                        sees "Today" based on his local midnight, while
                        Ronny (ET) sees his. Matches the grouping above. */}
                    {formatDayHeader(dayKey, viewerTz)}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {eventsByDay.get(dayKey)!.map((ev) => (
                      <li
                        key={ev.id}
                        className="rounded-md border border-neutral-800 px-3 py-2 text-sm transition hover:border-neutral-700"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          {/* Title + time as the tappable link target —
                              opens the event detail page. Share toggle
                              sits as a sibling so its click isn't
                              intercepted by the link. */}
                          <Link
                            href={`/dashboard/events/${ev.id}`}
                            className="group min-w-0 flex-1"
                            aria-label={`Open ${ev.title} detail`}
                          >
                            <span className="font-medium text-neutral-100 group-hover:text-brand">
                              {ev.title}
                            </span>
                          </Link>
                          <div className="flex shrink-0 items-center gap-3">
                            {ev.created_by === teamMember.id && (
                              <EventShareToggle
                                eventId={ev.id}
                                initialShared={ev.shared}
                              />
                            )}
                            <span className="font-mono text-xs text-neutral-500">
                              {formatEventWindow(
                                ev.starts_at,
                                ev.ends_at,
                                viewerTz
                              )}
                            </span>
                          </div>
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
                ? upNextRange === "today"
                  ? "Nothing on the calendar today."
                  : upNextRange === "30d"
                    ? "Nothing on the calendar for the next 30 days."
                    : upNextRange === "year"
                      ? "Nothing on the calendar for the next year."
                      : "Nothing on the calendar for the next 7 days."
                : "Connect a Google Calendar and upcoming events will appear here."}
            </p>
          )}
          {/* Pager: only render when there's more than one page. Keeps
              the panel uncluttered for the common case of <12 events. */}
          {totalUpNextPages > 1 && (
            <UpNextPager
              currentPage={currentUpNextPage}
              totalPages={totalUpNextPages}
            />
          )}
        </Panel>

        <Panel eyebrow="Tasks" title="Open items">
          {/* Inline create form — source='dashboard'. Anything added here
              queues a push to Google Tasks via Inngest so it lands on
              Ronny's phone too. */}
          <div className="mb-4 rounded-md border border-neutral-800 bg-neutral-950/50 p-3">
            <NewTaskForm />
          </div>

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
                  <div className="flex shrink-0 items-center gap-2">
                    {/* Small source badge — helps Jason eyeball where a
                        task came from during the early days. Hidden for
                        'dashboard' source since that's the default. */}
                    {t.source && t.source !== "dashboard" && (
                      <span className="rounded-full border border-neutral-800 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                        {t.source}
                      </span>
                    )}
                    <span className="font-mono text-xs text-neutral-500">
                      {formatTaskDue(t.due_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">
              No open tasks. Add one above, or sync to pull from Google.
            </p>
          )}
          {/* Collapsible recap of what's been checked off today.
              Hidden entirely when there's nothing to show — no
              "you haven't done anything" energy. */}
          <CompletedTodaySection
            tasks={completedToday.map((t) => ({
              id: t.id,
              title: t.title,
              completed_at: t.completed_at,
              source: t.source,
            }))}
          />
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

        <Panel
          eyebrow="Invoices"
          title="Pending invoices"
          cta={
            (pendingInvoices?.length ?? 0) > 0 ? (
              <Link
                href="/dashboard/invoices"
                className="text-xs font-medium text-neutral-400 transition hover:text-brand"
              >
                View all
              </Link>
            ) : null
          }
        >
          {!pendingInvoices || pendingInvoices.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No invoices awaiting review.
            </p>
          ) : (
            <ul className="space-y-2">
              {pendingInvoices.map((inv) => (
                <li key={inv.id}>
                  <Link
                    href={`/dashboard/invoices/${inv.id}`}
                    className="block rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 transition hover:border-neutral-700"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-neutral-100">
                          {inv.vendor?.legal_name ?? "Unknown vendor"}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-neutral-500">
                          Invoice {inv.invoice_number ?? "—"} ·{" "}
                          {formatMoney(inv.invoice_amount_cents ?? 0)}
                        </p>
                        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-neutral-600">
                          {inv.submitted_at
                            ? new Date(inv.submitted_at).toLocaleDateString()
                            : "—"}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full border border-amber-900/60 bg-amber-950/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-amber-200">
                        {(inv.invoice_status ?? "submitted").replace("_", " ")}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
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
 * "Thu, Apr 24" style. Input is the YYYY-MM-DD key from localDateKey.
 *
 * Critical: this runs in a Server Component, so `new Date()` is the
 * server's clock (Vercel = UTC). We MUST compare in the same timezone
 * that `localDateKey` used to produce the key (America/New_York by
 * default), otherwise late-night events get mislabeled. Example: at
 * 11pm ET on Apr 23 (= 3am UTC Apr 24), a Apr 24 2pm ET event would
 * have dayKey='2026-04-24'. If we compute "today" as the server's
 * local-UTC date, today === 2026-04-24 → label becomes "Today" even
 * though in ET it's actually tomorrow.
 *
 * Fix: compute today/tomorrow as YYYY-MM-DD STRINGS in the same tz
 * and compare them directly — no Date arithmetic, no tz boundary bugs.
 *
 * `tz` defaults to America/New_York (our operational zone). When we
 * later add per-member timezones, thread the viewer's zone through
 * here instead.
 */
function formatDayHeader(dayKey: string, tz = "America/New_York"): string {
  const now = new Date();
  const todayKey = now.toLocaleDateString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // +24h anchored on "now" works across normal days; the ±1-hour
  // wobble around DST changes only matters if you're rendering at
  // 1am on the DST-shift morning — tolerable for this UI.
  const tomorrowKey = new Date(
    now.getTime() + 24 * 60 * 60 * 1000
  ).toLocaleDateString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  if (dayKey === todayKey) return "Today";
  if (dayKey === tomorrowKey) return "Tomorrow";

  // Anchor the display Date at noon UTC so the day never wobbles across
  // midnight when re-formatted in `tz`.
  const [y, m, d] = dayKey.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return day.toLocaleDateString("en-US", {
    timeZone: tz,
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
/**
 * Render an event's time range in the VIEWER's timezone — not the
 * event's stored timezone. Matches Google Calendar's UX: when you
 * open an event created in another zone, you see it translated to
 * your local wall clock, not the organizer's.
 */
function formatEventWindow(
  startsAt: string,
  endsAt: string,
  viewerTz: string
): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const durationMs = end.getTime() - start.getTime();
  if (durationMs >= 23 * 60 * 60 * 1000) return "all day";

  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: viewerTz || "America/New_York",
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

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}
