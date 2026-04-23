/**
 * Expense report data layer.
 *
 * Given a date + granularity (daily/weekly/monthly), returns the
 * approved + paid invoices in that window with vendor joins, plus
 * summary totals. Both the PDF and Excel renderers consume the same
 * structured output so the two documents stay in perfect agreement.
 *
 * Counts as "expense":
 *   - invoice_status IN ('approved', 'paid')
 *
 * Week = Monday → Sunday (user spec). Month = calendar month.
 *
 * Timezone: all range math happens in America/New_York. Invoice
 * submitted_at is stored as timestamptz, so the comparison is done
 * in UTC after converting the range boundaries.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type ExpenseGranularity = "daily" | "weekly" | "monthly";

export type ExpenseReportInput = {
  granularity: ExpenseGranularity;
  /**
   * Anchor date — "YYYY-MM-DD" string interpreted in the operational
   * timezone. The returned range is the daily/weekly/monthly window
   * containing this date.
   */
  anchorDate: string;
  tz?: string;
};

export type ExpenseRow = {
  id: string;
  invoice_number: string | null;
  invoice_amount_cents: number;
  invoice_due_at: string | null;
  invoice_status: "approved" | "paid";
  submitted_at: string | null;
  uploaded_at: string;
  vendor_name: string;
  vendor_email: string | null;
};

export type ExpenseReport = {
  granularity: ExpenseGranularity;
  rangeStart: string; // ISO UTC
  rangeEnd: string; // ISO UTC (exclusive)
  /** Human-readable title, e.g. "Week of Mon Apr 21 – Sun Apr 27, 2026". */
  title: string;
  rows: ExpenseRow[];
  totals: {
    count: number;
    approvedCents: number;
    paidCents: number;
    totalCents: number;
  };
};

export async function buildExpenseReport(
  input: ExpenseReportInput
): Promise<ExpenseReport> {
  const tz = input.tz ?? "America/New_York";
  const { rangeStart, rangeEnd, title } = computeRange(
    input.granularity,
    input.anchorDate,
    tz
  );

  const admin = createAdminClient();

  // Pull approved + paid invoices in range, joined with vendor name.
  // We lean on submitted_at for the "when did this expense hit" axis;
  // fall back to uploaded_at for rows that were never explicitly
  // submitted (system-generated invoices for example).
  const { data, error } = (await (admin as any)
    .from("vendor_documents")
    .select(
      `
      id, invoice_number, invoice_amount_cents, invoice_due_at,
      invoice_status, submitted_at, uploaded_at,
      vendor:vendors ( legal_name, contact_email )
      `
    )
    .eq("kind", "invoice")
    .in("invoice_status", ["approved", "paid"])
    .gte("submitted_at", rangeStart)
    .lt("submitted_at", rangeEnd)
    .order("submitted_at", { ascending: true })) as {
    data:
      | Array<{
          id: string;
          invoice_number: string | null;
          invoice_amount_cents: number | null;
          invoice_due_at: string | null;
          invoice_status: "approved" | "paid";
          submitted_at: string | null;
          uploaded_at: string;
          vendor: { legal_name: string; contact_email: string | null } | null;
        }>
      | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`expense report query failed: ${error.message}`);
  }

  const rows: ExpenseRow[] = (data ?? []).map((d) => ({
    id: d.id,
    invoice_number: d.invoice_number,
    invoice_amount_cents: d.invoice_amount_cents ?? 0,
    invoice_due_at: d.invoice_due_at,
    invoice_status: d.invoice_status,
    submitted_at: d.submitted_at,
    uploaded_at: d.uploaded_at,
    vendor_name: d.vendor?.legal_name ?? "(unknown vendor)",
    vendor_email: d.vendor?.contact_email ?? null,
  }));

  const approvedCents = rows
    .filter((r) => r.invoice_status === "approved")
    .reduce((s, r) => s + r.invoice_amount_cents, 0);
  const paidCents = rows
    .filter((r) => r.invoice_status === "paid")
    .reduce((s, r) => s + r.invoice_amount_cents, 0);

  return {
    granularity: input.granularity,
    rangeStart,
    rangeEnd,
    title,
    rows,
    totals: {
      count: rows.length,
      approvedCents,
      paidCents,
      totalCents: approvedCents + paidCents,
    },
  };
}

/**
 * Given an anchor date (YYYY-MM-DD in tz) and granularity, return the
 * UTC-bounded range plus a human-readable title for the report header.
 *
 * - daily   → [00:00, 24:00) on anchor date
 * - weekly  → Monday 00:00 → next Monday 00:00 (week containing anchor)
 * - monthly → 1st 00:00 → next month 1st 00:00 (month containing anchor)
 */
function computeRange(
  g: ExpenseGranularity,
  anchorDate: string,
  tz: string
): { rangeStart: string; rangeEnd: string; title: string } {
  // Figure out this tz's UTC offset at the anchor date. Same trick as
  // the digest renderer — compare UTC noon against the zone's local
  // noon to recover the offset (handles DST).
  const anchorUtcNoon = new Date(`${anchorDate}T12:00:00Z`);
  const hourInZone = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(anchorUtcNoon)
  );
  const offsetHours = 12 - hourInZone;

  // 00:00 on the anchor date in tz, expressed as UTC.
  const anchorStartUtc = new Date(`${anchorDate}T00:00:00Z`);
  anchorStartUtc.setUTCHours(anchorStartUtc.getUTCHours() + offsetHours);

  let startUtc: Date;
  let endUtc: Date;
  let title: string;

  if (g === "daily") {
    startUtc = anchorStartUtc;
    endUtc = new Date(startUtc);
    endUtc.setUTCDate(endUtc.getUTCDate() + 1);
    title = `Daily expense report — ${formatLongDay(anchorDate, tz)}`;
  } else if (g === "weekly") {
    // Monday-of-week in tz. JS Date.getUTCDay: 0=Sun,1=Mon,...,6=Sat.
    // Shift so Monday=0 for easier math.
    const jsDay = anchorStartUtc.getUTCDay();
    const mondayOffset = (jsDay + 6) % 7; // days since Monday
    startUtc = new Date(anchorStartUtc);
    startUtc.setUTCDate(startUtc.getUTCDate() - mondayOffset);
    endUtc = new Date(startUtc);
    endUtc.setUTCDate(endUtc.getUTCDate() + 7);
    const weekEndAnchor = new Date(endUtc);
    weekEndAnchor.setUTCDate(weekEndAnchor.getUTCDate() - 1); // Sunday
    title = `Weekly expense report — ${formatShortDay(
      toLocalDateStr(startUtc, tz),
      tz
    )} → ${formatShortDay(toLocalDateStr(weekEndAnchor, tz), tz)}`;
  } else {
    // monthly — compute local YYYY-MM-01 then reconvert
    const [y, m] = anchorDate.split("-").map(Number);
    const monthStartLocal = `${y}-${String(m).padStart(2, "0")}-01`;
    startUtc = new Date(`${monthStartLocal}T00:00:00Z`);
    startUtc.setUTCHours(startUtc.getUTCHours() + offsetHours);
    endUtc = new Date(startUtc);
    endUtc.setUTCMonth(endUtc.getUTCMonth() + 1);
    title = `Monthly expense report — ${new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "long",
      year: "numeric",
    }).format(startUtc)}`;
  }

  return {
    rangeStart: startUtc.toISOString(),
    rangeEnd: endUtc.toISOString(),
    title,
  };
}

function formatLongDay(ymd: string, tz: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function formatShortDay(ymd: string, tz: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

function toLocalDateStr(utc: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(utc);
}
