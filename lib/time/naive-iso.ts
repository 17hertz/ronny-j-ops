/**
 * Convert a "naive" ISO (no Z, no offset) to a proper UTC ISO by
 * interpreting the wall-clock time in the given IANA timezone.
 *
 * If the input already carries a Z or numeric offset, return it as-is
 * — callers are already-UTC aware in those cases.
 *
 * Used by:
 *   - lib/actions/dispatch.ts  (Haiku parser emits naive ISOs;
 *                              dispatcher converts before writing)
 *   - lib/agent/tools.ts       (Sonnet may emit naive ISOs via the
 *                              update_task / update_event tool inputs;
 *                              tool executor converts before writing)
 *
 * DST handled correctly via Intl.DateTimeFormat — we measure the zone's
 * UTC offset at the exact anchor moment rather than hardcoding.
 */
export function naiveLocalToUtcIso(input: string, tz: string): string {
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(input)) return input;

  const m = input.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) {
    // Unexpected format — let Date do its best, usually treats as
    // server-local which on Vercel is UTC. Worst case the caller sees
    // a timezone-wrong event and re-edits.
    return new Date(input).toISOString();
  }
  const [, yy, mm, dd, hh, mi, ss = "0"] = m;
  const y = Number(yy),
    mo = Number(mm) - 1,
    d = Number(dd),
    h = Number(hh),
    min = Number(mi),
    s = Number(ss);

  const asUtc = new Date(Date.UTC(y, mo, d, h, min, s));
  const hourInTz = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(asUtc)
  );
  let offsetHours = h - hourInTz;
  if (offsetHours < -12) offsetHours += 24;
  if (offsetHours > 12) offsetHours -= 24;

  const corrected = new Date(asUtc.getTime() + offsetHours * 60 * 60 * 1000);
  return corrected.toISOString();
}
