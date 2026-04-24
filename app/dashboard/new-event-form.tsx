"use client";

/**
 * Dashboard "New event" form.
 *
 * Fields:
 *   - Title (required)
 *   - Start date+time (required, via datetime-local)
 *   - End date+time (optional — server defaults to +1h)
 *   - Location (optional)
 *   - Description (optional)
 *
 * Submits to POST /api/events which uses lib/events/service.createEvent,
 * which inserts a public.events row (source='dashboard') and queues the
 * Inngest push to Google Calendar. Within a few seconds the event shows
 * up on your phone's Google Calendar.
 *
 * Timezone: the form's datetime-local inputs give a naive local string;
 * we convert it to a UTC ISO by combining with the viewer's tz (passed
 * in as a prop). Matches how the crew form handles the same conversion.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function NewEventForm({ viewerTz }: { viewerTz: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "error"; message: string }
    | { kind: "ok" }
  >({ kind: "idle" });
  const [, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !startLocal) return;
    setStatus({ kind: "submitting" });

    try {
      const startsAtIso = localToUtcIso(startLocal, viewerTz);
      const endsAtIso = endLocal ? localToUtcIso(endLocal, viewerTz) : null;

      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          starts_at: startsAtIso,
          ends_at: endsAtIso,
          location: location.trim() || null,
          description: description.trim() || null,
          timezone: viewerTz,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setStatus({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      // Clear + refresh.
      setTitle("");
      setStartLocal("");
      setEndLocal("");
      setLocation("");
      setDescription("");
      setExpanded(false);
      setStatus({ kind: "ok" });
      startTransition(() => router.refresh());
    } catch (err: any) {
      setStatus({
        kind: "error",
        message: err?.message ?? "network error",
      });
    }
  }

  const busy = status.kind === "submitting";

  // Collapsed state: a subtle "+ new event" link that reveals the form
  // on click. Keeps the Up Next panel uncluttered when you're just
  // glancing at the list.
  if (!expanded) {
    return (
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center gap-2 rounded-md border border-dashed border-neutral-800 bg-neutral-950/30 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-neutral-500 transition hover:border-neutral-700 hover:text-neutral-300"
        >
          <span className="text-neutral-600">+</span>
          <span>Add event</span>
        </button>
        {status.kind === "ok" && (
          <p className="mt-1 text-xs text-emerald-400">
            Added — syncing to Google Calendar…
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mb-4 space-y-3 rounded-md border border-neutral-800 bg-neutral-950/50 p-3"
    >
      <div>
        <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Studio session with Mike"
          disabled={busy}
          maxLength={500}
          required
          autoFocus
          className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Start
          </label>
          <input
            type="datetime-local"
            value={startLocal}
            onChange={(e) => setStartLocal(e.target.value)}
            disabled={busy}
            required
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            End
            <span className="ml-1 normal-case text-neutral-600">
              (optional — defaults to +1h)
            </span>
          </label>
          <input
            type="datetime-local"
            value={endLocal}
            onChange={(e) => setEndLocal(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          Location (optional)
        </label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Studio B · 123 Sunset Blvd"
          disabled={busy}
          maxLength={500}
          className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
      </div>

      <div>
        <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          Notes (optional)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Parking instructions, setlist, anything else"
          disabled={busy}
          maxLength={5000}
          rows={2}
          className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !title.trim() || !startLocal}
          className="rounded-md border border-brand px-4 py-1.5 text-xs uppercase tracking-wider text-brand transition hover:bg-brand/10 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create event"}
        </button>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setStatus({ kind: "idle" });
          }}
          disabled={busy}
          className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200 disabled:opacity-50"
        >
          Cancel
        </button>
        {status.kind === "error" && (
          <span className="text-xs text-red-400">{status.message}</span>
        )}
      </div>

      <p className="font-mono text-[10px] text-neutral-600">
        Times interpreted in {viewerTz}. Event syncs to Google Calendar
        automatically.
      </p>
    </form>
  );
}

/**
 * Convert a datetime-local value ("2026-04-25T20:00") to a proper UTC
 * ISO, interpreting the wall-clock time as being in `tz`. Same approach
 * as the crew-section's helper — good enough for UI, server will
 * re-normalize if anything's off.
 */
function localToUtcIso(local: string, tz: string): string {
  const asUtc = new Date(`${local}:00Z`);
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
