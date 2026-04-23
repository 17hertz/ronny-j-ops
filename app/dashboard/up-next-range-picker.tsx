"use client";

/**
 * "Up next" time-range picker.
 *
 * Writes the selected range into the URL as `?range=…` and lets the
 * server component re-render with the new window. URL-driven so the
 * state survives refresh and is linkable/bookmarkable — no client-side
 * fetching gymnastics needed.
 *
 * Why a client component at all: Next's server components can't directly
 * wire <select onChange>, but a 20-line client component that just writes
 * to the URL is the cheapest bridge.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export type UpNextRange = "today" | "7d" | "30d" | "year";

const OPTIONS: { value: UpNextRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "1 month" },
  { value: "year", label: "Whole year" },
];

export function UpNextRangePicker({ current }: { current: UpNextRange }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function onChange(next: UpNextRange) {
    // Copy existing params so we don't blow away anything else (like
    // google=connected toasts or future filters).
    const sp = new URLSearchParams(params.toString());
    if (next === "7d") {
      // "7d" is the default; strip the param so the URL stays clean.
      sp.delete("range");
    } else {
      sp.set("range", next);
    }
    // Changing the range invalidates any current page offset — page 3
    // of "7 days" makes no sense after switching to "Today". Reset.
    sp.delete("page");
    const qs = sp.toString();
    startTransition(() => {
      router.push(qs ? `?${qs}` : "?", { scroll: false });
      router.refresh();
    });
  }

  return (
    <select
      aria-label="Time range"
      value={current}
      disabled={pending}
      onChange={(e) => onChange(e.target.value as UpNextRange)}
      className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-300 transition hover:border-neutral-700 disabled:opacity-50"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
