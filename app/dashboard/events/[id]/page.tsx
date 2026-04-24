/**
 * Dashboard event detail — view + manage the crew (vendor assignments)
 * for a single event.
 *
 * Access: any team member can read; enforcement via RLS on events +
 * event_vendors. We also defensively check `teamMember` in-route to
 * match the rest of the dashboard.
 *
 * What's on this page:
 *   - Header: title, time window, location, back link
 *   - Crew list (role / vendor / service window / contact-on-site / notes)
 *     with a "remove" button per row
 *   - "Add crew" form: role dropdown, vendor picker, service window,
 *     contact-on-site, notes
 *
 * What this does NOT do:
 *   - Does not edit the event itself (time / title / location). That
 *     still happens in Google Calendar and syncs in.
 *   - Does not push crew assignments to Google Calendar attendees.
 *     That's a deliberate v1 decision — see todolist.txt for the
 *     "propagate crew to GCal attendees" entry.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CrewSection } from "./crew-section";

export const dynamic = "force-dynamic";

type EventRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  created_by: string | null;
  shared: boolean;
};

type CrewRow = {
  id: string;
  role: string;
  service_window_start: string | null;
  service_window_end: string | null;
  contact_on_site: string | null;
  notes: string | null;
  vendor: {
    id: string;
    legal_name: string;
    dba: string | null;
    contact_phone: string | null;
    service_category: string | null;
  } | null;
};

type VendorOption = {
  id: string;
  legal_name: string;
  dba: string | null;
  service_category: string | null;
};

export default async function EventDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: teamMember } = (await supabase
    .from("team_members")
    .select("id, timezone")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; timezone: string } | null;
  };
  if (!teamMember) redirect("/dashboard");

  const admin = createAdminClient();

  const { data: event } = (await (admin as any)
    .from("events")
    .select(
      "id, title, description, location, starts_at, ends_at, timezone, created_by, shared"
    )
    .eq("id", params.id)
    .maybeSingle()) as { data: EventRow | null };

  if (!event) notFound();

  // Same privacy rule as the dashboard Up Next list: visible only if
  // the viewer created it OR it's shared team-wide.
  if (event.created_by !== teamMember.id && !event.shared) {
    notFound();
  }

  const { data: crew } = (await (admin as any)
    .from("event_vendors")
    .select(
      `
      id, role, service_window_start, service_window_end,
      contact_on_site, notes,
      vendor:vendors ( id, legal_name, dba, contact_phone, service_category )
      `
    )
    .eq("event_id", event.id)
    .order("role", { ascending: true })
    .order("service_window_start", {
      ascending: true,
      nullsFirst: false,
    })) as { data: CrewRow[] | null };

  // Full vendor list for the picker — capped so massive vendor lists
  // don't blow up the page payload. A searchable picker is on the
  // todolist for later iterations.
  const { data: vendors } = (await (admin as any)
    .from("vendors")
    .select("id, legal_name, dba, service_category")
    .order("legal_name", { ascending: true })
    .limit(500)) as { data: VendorOption[] | null };

  const viewerTz = teamMember.timezone || "America/New_York";

  return (
    <main className="mx-auto max-w-4xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">
          {event.shared ? "shared" : "private"}
        </span>
      </header>

      <section className="mt-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Event
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          {event.title}
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          {formatEventWindow(event.starts_at, event.ends_at, viewerTz)}
          {event.location && (
            <>
              <span className="mx-2 text-neutral-700">·</span>
              <span>{event.location}</span>
            </>
          )}
        </p>
        {event.description && (
          <p className="mt-4 whitespace-pre-wrap text-sm text-neutral-400">
            {event.description}
          </p>
        )}
      </section>

      <CrewSection
        eventId={event.id}
        initialCrew={crew ?? []}
        vendors={vendors ?? []}
        eventTz={event.timezone}
      />
    </main>
  );
}

/**
 * Format "Fri Apr 25 · 8:00 PM – 11:00 PM" style in the viewer's tz.
 */
function formatEventWindow(
  startsAt: string,
  endsAt: string,
  tz: string
): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const day = s.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    });
  return `${day} · ${fmtTime(s)} – ${fmtTime(e)}`;
}
