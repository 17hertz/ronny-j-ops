/**
 * Daily-digest SMS renderer.
 *
 * Takes today's events + today's tasks and produces a concise SMS body
 * that fits comfortably in one segment (≤160 chars preferred; we tolerate
 * up to ~320 for the richer version). The goal is the text Ronny could
 * read at a glance over coffee: what's on today + what still needs doing.
 *
 * Intentionally dumb — no DB access, no side effects. Call sites fetch
 * the data; this just formats. That keeps it trivially unit-testable.
 *
 * Timezone note:
 *   Times are rendered in `tz` (default America/New_York). We don't change
 *   the underlying data — just the display. An event stored as UTC will be
 *   shown as 9a even if the server is on PT.
 */

export type DigestEvent = {
  title: string;
  /** ISO timestamp (UTC or tz-aware). */
  starts_at: string;
  /** Optional — where it's happening. Trimmed/truncated when rendering. */
  location?: string | null;
};

export type DigestTask = {
  title: string;
  /** ISO timestamp or date. Optional — overdue items often have one. */
  due_at?: string | null;
  /** True if due_at is earlier than today (still needsAction). */
  overdue?: boolean;
};

export type CompletedTaskSummary = {
  title: string;
};

export type DigestInput = {
  /** Day label for the header, e.g. "Tue Apr 22". */
  dayLabel?: string;
  events: DigestEvent[];
  tasks: DigestTask[];
  /**
   * Tasks completed today. Rendered as an optional "Done:" line at the
   * bottom of the digest. When empty, the line is omitted — no "nothing
   * done today" energy. Used by the end-of-day recap SMS.
   */
  completed?: CompletedTaskSummary[];
  /** IANA zone. Defaults to America/New_York. */
  tz?: string;
};

export function renderDigest(input: DigestInput): string {
  const tz = input.tz ?? "America/New_York";
  const header = input.dayLabel ?? todayLabel(tz);

  // Events line — "9a Vendor call · 2p Site walk". Sort by start time
  // defensively in case the caller didn't.
  const evs = [...input.events].sort(
    (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
  );
  const eventsLine =
    evs.length === 0
      ? "No events."
      : evs.map((e) => `${formatTime(e.starts_at, tz)} ${trim(e.title, 30)}`).join(" · ");

  // Tasks line — up to 5. If more, elide with "(+N more)".
  const MAX_TASKS = 5;
  const tasksShown = input.tasks.slice(0, MAX_TASKS);
  const remaining = input.tasks.length - tasksShown.length;
  const tasksLine =
    input.tasks.length === 0
      ? "No tasks."
      : tasksShown
          .map((t) => `${t.overdue ? "⚠ " : ""}${trim(t.title, 40)}`)
          .join("; ") + (remaining > 0 ? ` (+${remaining} more)` : "");

  const lines = [
    `Ronny J · ${header}`,
    `Today: ${eventsLine}`,
    `To do: ${tasksLine}`,
  ];

  // "Done:" section — only shown when there's something to celebrate.
  // Capped at 5 with a "+N more" overflow, same treatment as tasks.
  if (input.completed && input.completed.length > 0) {
    const MAX_DONE = 5;
    const shown = input.completed.slice(0, MAX_DONE);
    const rest = input.completed.length - shown.length;
    const doneLine =
      shown.map((d) => trim(d.title, 40)).join("; ") +
      (rest > 0 ? ` (+${rest} more)` : "");
    lines.push(`Done: ${doneLine}`);
  }

  return lines.join("\n");
}

/**
 * "Tue Apr 22" in the given timezone. Used as the header line.
 */
function todayLabel(tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date());
}

/**
 * "9a" / "2:30p" — compact time format for the digest line.
 * We drop ":00" when it's on the hour to save characters.
 */
function formatTime(iso: string, tz: string): string {
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
    (parts.find((p) => p.type === "dayPeriod")?.value ?? "AM").toLowerCase().charAt(0);
  return minute === "00" ? `${hour}${dayPeriod}` : `${hour}:${minute}${dayPeriod}`;
}

/** Truncate with an ellipsis. Leaves short strings alone. */
function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * UTC [start, end) bounds for "today" in the given IANA zone.
 * Used by the route handler to scope DB queries to today.
 *
 * How it works: format "now" in the target zone to get YYYY-MM-DD, then
 * reverse-engineer the zone's offset at that date by comparing UTC noon
 * against the zone's local-noon rendering. Avoids a 3rd-party TZ lib.
 */
export function todayBoundsUtc(tz = "America/New_York"): {
  startUtc: Date;
  endUtc: Date;
} {
  const now = new Date();
  // YYYY-MM-DD in the target zone. en-CA gives ISO-ordered date.
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);

  // Figure out the zone's UTC offset *on this date* by anchoring on UTC noon.
  const anchorUtc = new Date(`${ymd}T12:00:00Z`);
  const hourInZone = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(anchorUtc)
  );
  // If UTC is 12 and the zone shows e.g. 8, offset is UTC-4 (EDT).
  const offsetHours = 12 - hourInZone;

  const startUtc = new Date(`${ymd}T00:00:00Z`);
  startUtc.setUTCHours(startUtc.getUTCHours() + offsetHours);
  const endUtc = new Date(startUtc);
  endUtc.setUTCDate(endUtc.getUTCDate() + 1);
  return { startUtc, endUtc };
}
