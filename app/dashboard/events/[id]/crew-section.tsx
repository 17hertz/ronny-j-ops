"use client";

/**
 * Crew management for an event: list current assignments with remove
 * buttons, and an inline form to add a new one.
 *
 * Optimistic remove (immediately hides the row, rolls back on error).
 * Add submits to POST /api/events/[id]/crew then router.refresh so the
 * server component re-queries and the new row renders via SSR (same
 * pattern as the new-task-form).
 *
 * Role/vendor combo: the role dropdown is the source of truth for what
 * the vendor is DOING on this event; the vendor's own `service_category`
 * is informational. A single vendor ("Crescent Security") can appear
 * across different events in different roles, though in practice they
 * stay in their category.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type Role =
  | "security" | "photography" | "videography" | "catering" | "lighting"
  | "sound" | "driver" | "transportation" | "promoter" | "venue"
  | "artist" | "opener" | "hair_makeup" | "stylist" | "stage" | "runner"
  | "hospitality" | "streamer" | "performer" | "model" | "other";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "artist", label: "Artist" },
  { value: "performer", label: "Performer" },
  { value: "streamer", label: "Streamer" },
  { value: "model", label: "Model" },
  { value: "opener", label: "Opener" },
  { value: "security", label: "Security" },
  { value: "photography", label: "Photography" },
  { value: "videography", label: "Videography" },
  { value: "sound", label: "Sound" },
  { value: "lighting", label: "Lighting" },
  { value: "stage", label: "Stage" },
  { value: "driver", label: "Driver" },
  { value: "transportation", label: "Transportation" },
  { value: "catering", label: "Catering" },
  { value: "hospitality", label: "Hospitality" },
  { value: "hair_makeup", label: "Hair / makeup" },
  { value: "stylist", label: "Stylist" },
  { value: "promoter", label: "Promoter" },
  { value: "venue", label: "Venue" },
  { value: "runner", label: "Runner" },
  { value: "other", label: "Other" },
];

export type CrewRow = {
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

export type VendorOption = {
  id: string;
  legal_name: string;
  dba: string | null;
  service_category: string | null;
};

export function CrewSection({
  eventId,
  initialCrew,
  vendors,
  eventTz,
}: {
  eventId: string;
  initialCrew: CrewRow[];
  vendors: VendorOption[];
  eventTz: string;
}) {
  const router = useRouter();
  const [optimisticHidden, setOptimisticHidden] = useState<Set<string>>(
    new Set()
  );
  const visibleCrew = useMemo(
    () => initialCrew.filter((c) => !optimisticHidden.has(c.id)),
    [initialCrew, optimisticHidden]
  );

  async function onRemove(assignmentId: string) {
    if (!confirm("Remove this crew assignment?")) return;
    setOptimisticHidden((s) => new Set(s).add(assignmentId));
    try {
      const res = await fetch(
        `/api/events/${eventId}/crew/${assignmentId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        // Roll back on failure.
        setOptimisticHidden((s) => {
          const next = new Set(s);
          next.delete(assignmentId);
          return next;
        });
        const json = await res.json().catch(() => ({} as any));
        alert(`Couldn't remove: ${json.error ?? res.status}`);
        return;
      }
      router.refresh();
    } catch (e: any) {
      setOptimisticHidden((s) => {
        const next = new Set(s);
        next.delete(assignmentId);
        return next;
      });
      alert(`Network error: ${e?.message ?? "unknown"}`);
    }
  }

  return (
    <section className="mt-10">
      <header className="flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
            Crew
          </p>
          <h2 className="mt-1 font-display text-2xl">Vendors on this event</h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">
          {visibleCrew.length} assignment{visibleCrew.length === 1 ? "" : "s"}
        </span>
      </header>

      {visibleCrew.length === 0 ? (
        <p className="mt-4 rounded-md border border-neutral-800 bg-neutral-950/50 px-4 py-6 text-center text-sm text-neutral-500">
          No vendors attached yet. Add one below, or assign from SMS —
          &ldquo;claude put Crescent Security on tonight&rsquo;s show, call time 8pm&rdquo;.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {visibleCrew.map((c) => (
            <li
              key={c.id}
              className="flex items-start justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                  <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-300">
                    {c.role.replace(/_/g, " ")}
                  </span>
                  {c.service_window_start && (
                    <span className="text-neutral-500">
                      {formatWindow(
                        c.service_window_start,
                        c.service_window_end,
                        eventTz
                      )}
                    </span>
                  )}
                </p>
                <p className="mt-1 truncate font-medium text-neutral-100">
                  {c.vendor?.legal_name ?? "(unknown vendor)"}
                  {c.vendor?.dba && (
                    <span className="ml-1 text-neutral-500">
                      dba {c.vendor.dba}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {c.contact_on_site && (
                    <>
                      <span>On-site: {c.contact_on_site}</span>
                    </>
                  )}
                  {c.vendor?.contact_phone && !c.contact_on_site && (
                    <>
                      <span>Vendor phone: {c.vendor.contact_phone}</span>
                    </>
                  )}
                </p>
                {c.notes && (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-400">
                    {c.notes}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(c.id)}
                className="shrink-0 rounded-md border border-neutral-800 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400 transition hover:border-red-900/60 hover:text-red-300"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddCrewForm
        eventId={eventId}
        vendors={vendors}
        eventTz={eventTz}
        onAdded={() => router.refresh()}
      />
    </section>
  );
}

function AddCrewForm({
  eventId,
  vendors,
  eventTz,
  onAdded,
}: {
  eventId: string;
  vendors: VendorOption[];
  eventTz: string;
  onAdded: () => void;
}) {
  const [role, setRole] = useState<Role>("security");
  const [vendorId, setVendorId] = useState<string>(vendors[0]?.id ?? "");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [contactOnSite, setContactOnSite] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!vendorId) {
      setError("Pick a vendor");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Datetime-local inputs give bare strings like "2026-04-25T20:00".
      // Combined with eventTz we convert to a proper UTC ISO.
      const toIso = (local: string) =>
        local ? localToUtcIso(local, eventTz) : null;

      const res = await fetch(`/api/events/${eventId}/crew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor_id: vendorId,
          role,
          service_window_start: toIso(windowStart),
          service_window_end: toIso(windowEnd),
          contact_on_site: contactOnSite.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      // Clear form and trigger refresh.
      setWindowStart("");
      setWindowEnd("");
      setContactOnSite("");
      setNotes("");
      startTransition(() => onAdded());
    } catch (err: any) {
      setError(err?.message ?? "network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-6 rounded-lg border border-neutral-800 bg-neutral-950/50 p-5"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
        Add vendor
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={saving}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Vendor
          </label>
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            disabled={saving || vendors.length === 0}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          >
            {vendors.length === 0 ? (
              <option value="">(no vendors yet)</option>
            ) : (
              vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.legal_name}
                  {v.service_category ? ` — ${v.service_category}` : ""}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Service start
            <span className="ml-1 normal-case text-neutral-600">
              (call time / set start / pickup)
            </span>
          </label>
          <input
            type="datetime-local"
            value={windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
            disabled={saving}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Service end
            <span className="ml-1 normal-case text-neutral-600">
              (optional — defaults to +1h)
            </span>
          </label>
          <input
            type="datetime-local"
            value={windowEnd}
            onChange={(e) => setWindowEnd(e.target.value)}
            disabled={saving}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Contact on-site
          </label>
          <input
            type="text"
            value={contactOnSite}
            onChange={(e) => setContactOnSite(e.target.value)}
            disabled={saving}
            placeholder="Mike (555-1234)"
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Notes
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={saving}
            placeholder="load-in east side, parking in lot B"
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={saving || !vendorId}
          className="rounded-md border border-brand px-4 py-1.5 text-xs uppercase tracking-wider text-brand transition hover:bg-brand/10 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add to event"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </form>
  );
}

/** Format a service window in the event's own tz for display. */
function formatWindow(
  start: string | null,
  end: string | null,
  tz: string
): string {
  if (!start) return "";
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      timeZone: tz || "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  if (!end) return `from ${fmt(start)}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * datetime-local gives "2026-04-25T20:00" with no tz. Combined with the
 * event's tz we produce a proper UTC ISO string. Naive but correct: we
 * ask the browser to format the local string as if it were in the
 * event's tz, then compute the UTC offset at that moment and subtract.
 */
function localToUtcIso(local: string, tz: string): string {
  // Parse the local string into a Date as if it were UTC.
  const asUtc = new Date(`${local}:00Z`);
  // Figure out how that instant WOULD appear in the target tz, derive
  // the tz's offset, and subtract. Not handling DST boundaries perfectly
  // but close enough for UI use — the server-side parser re-normalizes.
  const tzHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(asUtc)
  );
  const utcHour = asUtc.getUTCHours();
  let offsetHours = utcHour - tzHour;
  if (offsetHours < -12) offsetHours += 24;
  if (offsetHours > 12) offsetHours -= 24;
  const adjusted = new Date(asUtc.getTime() + offsetHours * 60 * 60 * 1000);
  return adjusted.toISOString();
}
