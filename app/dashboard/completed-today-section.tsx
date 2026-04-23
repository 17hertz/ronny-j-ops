"use client";

/**
 * Collapsible "Completed today" recap inside the Tasks panel.
 *
 * Default collapsed — motivation without distraction. Chevron toggles
 * open; open state is client-local (not persisted) because the value
 * lives on the page, so reopening it every visit takes one click.
 *
 * The count in the header updates when the user ticks more off during
 * the day (server re-renders on router.refresh from TaskCheckbox), but
 * the open/closed state is preserved through the refresh because this
 * component holds its own state.
 */
import { useState } from "react";

export type CompletedTask = {
  id: string;
  title: string;
  completed_at: string | null;
  source: string;
};

export function CompletedTodaySection({
  tasks,
  tz = "America/New_York",
}: {
  tasks: CompletedTask[];
  tz?: string;
}) {
  // Start collapsed by default. Only auto-open for the motivation beat
  // if the user already has something to celebrate AND the list is short
  // enough that it doesn't crowd the panel.
  const [open, setOpen] = useState(false);

  if (tasks.length === 0) {
    // Don't render anything for empty days — no "you haven't done
    // anything" negativity. The panel is about motivation, not shame.
    return null;
  }

  return (
    <div className="mt-4 border-t border-neutral-800 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left transition hover:bg-neutral-900/50"
      >
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-neutral-500">
          <Chevron open={open} />
          Completed today
          <span className="rounded-full border border-emerald-900/60 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-300">
            {tasks.length}
          </span>
        </span>
      </button>

      {open && (
        <ul className="mt-2 space-y-1.5">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-md border border-neutral-800/60 bg-neutral-950/40 px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate text-neutral-300 line-through decoration-neutral-600">
                {t.title}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                {t.source && t.source !== "dashboard" && (
                  <span className="rounded-full border border-neutral-800 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-neutral-500">
                    {t.source}
                  </span>
                )}
                <span className="font-mono text-[10px] text-neutral-600">
                  {formatCompletedAt(t.completed_at, tz)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Compact SVG chevron — rotates 90° when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path
        d="M4 3l4 3-4 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * "9:42a" / "2:15p" — compact completion time, localized to the tz.
 * Mirrors the digest renderer's format so the dashboard and SMS read
 * consistently.
 */
function formatCompletedAt(iso: string | null, tz: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "?";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayPeriod =
    (parts.find((p) => p.type === "dayPeriod")?.value ?? "AM")
      .toLowerCase()
      .charAt(0);
  return minute === "00" ? `${hour}${dayPeriod}` : `${hour}:${minute}${dayPeriod}`;
}
