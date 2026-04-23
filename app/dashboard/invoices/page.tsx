/**
 * Admin invoice list page — every invoice across every status.
 *
 * Entry points:
 *   - The dashboard's "Pending invoices" panel has a "View all" link that
 *     points here. Previously this 404'd (only the [id] detail page existed).
 *   - Direct URL.
 *
 * Authz:
 *   - Must be signed in AND have a team_members row. Non-team members get
 *     bounced to /dashboard, mirroring the [id] page's check.
 *
 * Data:
 *   - `vendor_documents` where kind='invoice' with a vendor join.
 *   - Sorted by submitted_at desc (NULLs last) so the freshest submissions
 *     rise to the top. Uploaded-but-never-submitted rows (draft system
 *     invoices) fall to the bottom.
 *
 * What this is NOT:
 *   - Not paginated yet. When the list outgrows a single screen we'll add
 *     status-tab filters + a cursor — but with one vendor in prod today
 *     that's premature.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ExpenseReportButton } from "./expense-report-button";

export const dynamic = "force-dynamic";

type InvoiceListRow = {
  id: string;
  invoice_number: string | null;
  invoice_amount_cents: number | null;
  invoice_due_at: string | null;
  invoice_status: string | null;
  submitted_at: string | null;
  uploaded_at: string;
  vendor: { legal_name: string } | null;
};

export default async function InvoicesListPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: teamMember } = (await supabase
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };
  if (!teamMember) redirect("/dashboard");

  // Service role so we can read invoices regardless of RLS nuances around
  // "all team members see all invoices" — same pattern the detail page uses.
  const admin = createAdminClient();

  // `submitted_at` can be null for system-generated drafts that no one
  // ever submitted. Sort by coalesce(submitted_at, uploaded_at) desc via
  // an order chain — submitted_at primary, uploaded_at secondary.
  const { data: invoices } = (await (admin as any)
    .from("vendor_documents")
    .select(
      `
      id, invoice_number, invoice_amount_cents, invoice_due_at,
      invoice_status, submitted_at, uploaded_at,
      vendor:vendors ( legal_name )
      `
    )
    .eq("kind", "invoice")
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .order("uploaded_at", { ascending: false })) as {
    data: InvoiceListRow[] | null;
  };

  const rows = invoices ?? [];

  // Group counts by status for the header chips — cheap summary so the
  // page earns its keep at a glance.
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const s = r.invoice_status ?? "submitted";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const totalCents = rows.reduce(
    (s, r) => s + (r.invoice_amount_cents ?? 0),
    0
  );

  return (
    <main className="mx-auto max-w-5xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">
          {rows.length} {rows.length === 1 ? "invoice" : "invoices"}
        </span>
      </header>

      <section className="mt-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Invoices
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          All invoices
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          {rows.length === 0
            ? "No invoices yet."
            : `Total across all statuses: ${formatMoney(totalCents)}.`}
        </p>
      </section>

      {/* Status summary chips — only render statuses that actually appear */}
      {rows.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {["submitted", "under_review", "approved", "paid", "rejected", "void"]
            .filter((s) => counts[s])
            .map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-950 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400"
              >
                {s.replace("_", " ")}
                <span className="text-neutral-200">{counts[s]}</span>
              </span>
            ))}
        </div>
      )}

      {/* Expense report generator — dropdown + date picker + download.
          Lives above the list so it's the first thing you see when you
          come here specifically to export. */}
      <ExpenseReportButton />

      <section className="mt-10 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-neutral-500">
              When vendors submit invoices, they'll appear here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {rows.map((inv) => (
              <li key={inv.id}>
                <Link
                  href={`/dashboard/invoices/${inv.id}`}
                  className="flex items-center gap-4 px-6 py-4 transition hover:bg-neutral-900/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-100">
                      {inv.vendor?.legal_name ?? "Unknown vendor"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                      Invoice {inv.invoice_number ?? "—"}
                      {inv.invoice_due_at && (
                        <>
                          <span className="mx-2 text-neutral-700">·</span>
                          due{" "}
                          {new Date(inv.invoice_due_at).toLocaleDateString()}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium text-neutral-100">
                      {formatMoney(inv.invoice_amount_cents ?? 0)}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-600">
                      {inv.submitted_at
                        ? new Date(inv.submitted_at).toLocaleDateString()
                        : "draft"}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <InvoiceStatusBadge status={inv.invoice_status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * Mirrors the badge in app/dashboard/invoices/[id]/page.tsx so a status
 * looks identical here and on the detail page. Not extracted into a shared
 * module yet because it's only two callers; will refactor when it's three.
 */
function InvoiceStatusBadge({ status }: { status: string | null }) {
  const s = status ?? "submitted";
  const styles =
    s === "paid"
      ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
      : s === "approved"
        ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
        : s === "rejected" || s === "void"
          ? "border-red-900/60 bg-red-950/40 text-red-300"
          : s === "under_review"
            ? "border-amber-900/60 bg-amber-950/40 text-amber-200"
            : "border-neutral-700 bg-neutral-900 text-neutral-300";
  return (
    <span
      className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-wider ${styles}`}
    >
      {s.replace("_", " ")}
    </span>
  );
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}
