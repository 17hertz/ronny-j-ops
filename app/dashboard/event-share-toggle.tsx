"use client";

/**
 * Per-event share toggle shown next to events the viewer created.
 *
 * Optimistic UI — flips the local checked state immediately, POSTs to
 * the API in the background, rolls back on error. Keeps the interaction
 * snappy since the network round-trip is a second or so.
 *
 * Only renders for events the current viewer created. That ownership
 * check happens at the call site (see app/dashboard/page.tsx in the Up
 * Next panel) — this component trusts that it's only mounted when
 * appropriate.
 */
import { useState } from "react";

export function EventShareToggle({
  eventId,
  initialShared,
}: {
  eventId: string;
  initialShared: boolean;
}) {
  const [shared, setShared] = useState(initialShared);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onToggle() {
    const next = !shared;
    setShared(next); // optimistic
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared: next }),
      });
      const json = await res.json();
      if (!json.ok) {
        setShared(!next); // rollback
        setError(json.error ?? `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setShared(!next);
      setError(e?.message ?? "network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <label
      className="flex shrink-0 cursor-pointer items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-500 transition hover:text-neutral-300"
      title={
        shared
          ? "Visible to all team members. Click to make private."
          : "Private to you. Click to share with the team."
      }
    >
      <input
        type="checkbox"
        checked={shared}
        onChange={onToggle}
        disabled={saving}
        className="h-3 w-3 rounded border-neutral-700 bg-neutral-950 text-brand focus:ring-0 focus:ring-offset-0 disabled:opacity-50"
      />
      <span>{shared ? "shared" : "private"}</span>
      {error && (
        <span className="ml-1 text-red-400" title={error}>
          !
        </span>
      )}
    </label>
  );
}
