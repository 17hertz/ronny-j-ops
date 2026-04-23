"use client";

/**
 * Retry button for a single errored sync row.
 *
 * POSTs to /api/sync-errors/retry which resets push_status to 'pending'
 * and re-emits the Inngest event for the worker to take another swing.
 * On success, we router.refresh so the errored row drops out of the
 * panel (it's now 'pending', which this panel filters on 'error' only).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function SyncErrorRetryButton({
  kind,
  id,
}: {
  kind: "task" | "event";
  id: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onRetry() {
    setError(null);
    try {
      const res = await fetch("/api/sync-errors/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      // Give the worker a moment to pick up the event before refreshing.
      // Otherwise a fast refresh might still show the row as 'error'
      // (since we just flipped to 'pending' and the panel filters on
      // 'error' — 'pending' rows are invisible, which is actually fine).
      // But we refresh immediately anyway — the row disappears from the
      // panel on first refresh, and if the push fails again, the next
      // one surfaces with the new error.
      startTransition(() => router.refresh());
    } catch (e: any) {
      setError(e?.message ?? "network error");
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={onRetry}
        disabled={pending}
        className="rounded-md border border-neutral-800 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-300 transition hover:border-brand hover:text-brand disabled:opacity-50"
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}
