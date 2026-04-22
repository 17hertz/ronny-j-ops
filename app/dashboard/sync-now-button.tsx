"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Calls POST /api/google/sync, then refreshes the dashboard so the new
 * events show up. Status is kept local so we can show a quick toast-style
 * message without a full UI library.
 */
export function SyncNowButton() {
  const router = useRouter();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "syncing" }
    | { kind: "ok"; summary: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleClick() {
    setStatus({ kind: "syncing" });
    try {
      const res = await fetch("/api/google/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setStatus({
          kind: "error",
          message: body?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const results = body.results as Array<{
        googleEmail: string;
        upserted: number;
        deleted: number;
      }>;
      const totalUpserted = results.reduce((s, r) => s + r.upserted, 0);
      const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
      setStatus({
        kind: "ok",
        summary: `Synced ${totalUpserted} event${totalUpserted === 1 ? "" : "s"}${
          totalDeleted ? `, removed ${totalDeleted}` : ""
        }.`,
      });
      router.refresh();
    } catch (e: any) {
      setStatus({ kind: "error", message: e?.message ?? "network error" });
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={status.kind === "syncing"}
        className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-brand hover:text-brand disabled:opacity-50"
      >
        {status.kind === "syncing" ? "Syncing..." : "Sync now"}
      </button>
      {status.kind === "ok" && (
        <span className="text-xs text-neutral-500">{status.summary}</span>
      )}
      {status.kind === "error" && (
        <span className="text-xs text-red-400">
          Sync failed: {status.message}
        </span>
      )}
    </div>
  );
}
