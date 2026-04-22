"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Checkbox for a single Google Task. Flips the task's status optimistically
 * (visual tick appears immediately), then POSTs to the toggle endpoint. If
 * the server rejects — most commonly because the connected Google token
 * doesn't have the full `tasks` scope — we roll back and surface the
 * reason inline.
 *
 * We don't router.refresh() on the happy path so the checkbox doesn't
 * bounce; the next cron tick will reconcile any drift. We DO refresh on
 * error so the panel re-pulls the authoritative state.
 */
export function TaskCheckbox({
  taskId,
  initialStatus,
  title,
}: {
  taskId: string;
  initialStatus: "needsAction" | "completed";
  title: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"needsAction" | "completed">(
    initialStatus
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = status === "completed";

  async function handleChange() {
    if (busy) return;
    setError(null);

    const next = done ? "needsAction" : "completed";
    setStatus(next); // optimistic
    setBusy(true);

    try {
      const res = await fetch(`/api/google/tasks/${taskId}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        // Roll back.
        setStatus(done ? "completed" : "needsAction");
        if (body.scope_missing) {
          setError("Reconnect Google (needs the full Tasks scope)");
        } else {
          setError(body.error ?? `HTTP ${res.status}`);
        }
        return;
      }
      // Mirror whatever Google ended up with — normally matches `next` but
      // trust the server's reported status in case of an edge case.
      setStatus(body.status);
      // Nudge the dashboard so the "open items" count and ordering settle.
      router.refresh();
    } catch (e: any) {
      setStatus(done ? "completed" : "needsAction");
      setError(e?.message ?? "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        onChange={handleChange}
        className="h-4 w-4 shrink-0 rounded border-neutral-700 bg-neutral-950 text-brand focus:ring-brand focus:ring-offset-0"
      />
      <span
        className={`min-w-0 truncate text-neutral-100 ${
          done ? "text-neutral-500 line-through" : ""
        }`}
      >
        {title}
      </span>
      {error && (
        <span className="ml-2 shrink-0 text-xs text-red-400">{error}</span>
      )}
    </label>
  );
}
