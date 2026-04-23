"use client";

/**
 * Expense report generator — dropdown + date picker + download buttons.
 *
 * Lives on /dashboard/invoices. Submits to POST /api/invoices/report
 * with { granularity, anchorDate, format }, receives the binary file,
 * and triggers a browser download.
 *
 * Defaults:
 *   - granularity: "weekly" (most common ask — "this week's expenses")
 *   - anchorDate: today (local)
 *
 * Downloads happen via Blob + createObjectURL so the file name + MIME
 * come from the response headers, not from the browser's URL heuristics.
 */
import { useState } from "react";

type Granularity = "daily" | "weekly" | "monthly";
type Format = "pdf" | "xlsx";

type Status =
  | { kind: "idle" }
  | { kind: "generating"; format: Format }
  | { kind: "error"; message: string };

export function ExpenseReportButton() {
  const [granularity, setGranularity] = useState<Granularity>("weekly");
  const [anchorDate, setAnchorDate] = useState<string>(() => todayIsoDate());
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function generate(format: Format) {
    setStatus({ kind: "generating", format });
    try {
      const res = await fetch("/api/invoices/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granularity, anchorDate, format }),
      });
      if (!res.ok) {
        // JSON error payload — server didn't reach the file path.
        const body = await res.json().catch(() => ({} as any));
        setStatus({
          kind: "error",
          message: body?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const blob = await res.blob();
      triggerDownload(blob, filenameFor(granularity, anchorDate, format));
      setStatus({ kind: "idle" });
    } catch (err: any) {
      setStatus({
        kind: "error",
        message: err?.message ?? "network error",
      });
    }
  }

  const busy = status.kind === "generating";

  return (
    <section className="mt-10 rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <header className="flex items-baseline justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
            Reports
          </p>
          <h2 className="mt-1 font-display text-xl">Expense report</h2>
        </div>
        <p className="text-xs text-neutral-600">
          Approved + paid invoices in range
        </p>
      </header>

      <div className="mt-4 grid gap-3 sm:grid-cols-[160px_200px_1fr]">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Range
          </label>
          <select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as Granularity)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly (Mon – Sun)</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            {granularity === "daily"
              ? "Date"
              : granularity === "weekly"
                ? "Any day in the week"
                : "Any day in the month"}
          </label>
          <input
            type="date"
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => generate("pdf")}
            disabled={busy}
            className="rounded-md border border-brand px-4 py-2 text-xs uppercase tracking-wider text-brand transition hover:bg-brand/10 disabled:opacity-50"
          >
            {busy && status.format === "pdf" ? "Generating…" : "Download PDF"}
          </button>
          <button
            type="button"
            onClick={() => generate("xlsx")}
            disabled={busy}
            className="rounded-md border border-neutral-800 px-4 py-2 text-xs uppercase tracking-wider text-neutral-300 transition hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-50"
          >
            {busy && status.format === "xlsx" ? "Generating…" : "Download Excel"}
          </button>
        </div>
      </div>

      {status.kind === "error" && (
        <p className="mt-3 text-xs text-red-400">{status.message}</p>
      )}
    </section>
  );
}

/** Today as YYYY-MM-DD in the user's local zone — matches the <input type="date"> format. */
function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function filenameFor(g: Granularity, anchor: string, fmt: Format): string {
  return `ronny-j-expenses-${g}-${anchor}.${fmt}`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
