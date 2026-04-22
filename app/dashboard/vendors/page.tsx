/**
 * Vendors index page.
 *
 * The dashboard panel only shows `submitted` + `in_review` (the review
 * queue). This page shows EVERY vendor so you can find an approval you
 * made by mistake, see who you've paid before, or audit rejections.
 *
 * URL: /dashboard/vendors?status=pending
 *   status=pending  → submitted + in_review (default)
 *   status=approved → approved
 *   status=rejected → rejected
 *   status=all      → everything, including invited/draft
 *
 * Rows click through to the detail page where Jason/Ronny can flip the
 * decision — ReviewActions already handles re-approving a rejected
 * vendor or re-rejecting an approved one.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  labelFor,
  type ServiceCategoryId,
} from "@/lib/vendors/service-categories";

export const dynamic = "force-dynamic";

type StatusFilter = "pending" | "approved" | "rejected" | "all";

type VendorRow = {
  id: string;
  legal_name: string;
  dba: string | null;
  contact_email: string;
  service_category: string | null;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  ach_account_last4: string | null;
  secondary_payment_method: string | null;
  tin_match_status: string | null;
};

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "pending", label: "Awaiting review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export default async function VendorsIndexPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
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

  const filter: StatusFilter =
    searchParams.status === "approved" ||
    searchParams.status === "rejected" ||
    searchParams.status === "all"
      ? (searchParams.status as StatusFilter)
      : "pending";

  // Build the query based on the filter. We always order by the most
  // recently meaningful timestamp for that bucket: pending vendors order
  // by submitted_at (oldest first — "who's been waiting longest"),
  // reviewed ones by reviewed_at (newest first — "what did I just do").
  let query = supabase
    .from("vendors")
    .select(
      "id, legal_name, dba, contact_email, service_category, status, submitted_at, reviewed_at, ach_account_last4, secondary_payment_method, tin_match_status"
    );

  if (filter === "pending") {
    query = query
      .in("status", ["submitted", "in_review"])
      .order("submitted_at", { ascending: true });
  } else if (filter === "approved") {
    query = query
      .eq("status", "approved")
      .order("reviewed_at", { ascending: false });
  } else if (filter === "rejected") {
    query = query
      .eq("status", "rejected")
      .order("reviewed_at", { ascending: false });
  } else {
    query = query.order("submitted_at", {
      ascending: false,
      nullsFirst: false,
    });
  }

  const { data: vendors } = (await query) as { data: VendorRow[] | null };

  // Counts for the filter chips — one round-trip per bucket so the
  // numbers are always current. Cheap because vendors is tiny.
  const [pendingCount, approvedCount, rejectedCount, allCount] =
    await Promise.all([
      supabase
        .from("vendors")
        .select("id", { count: "exact", head: true })
        .in("status", ["submitted", "in_review"]),
      supabase
        .from("vendors")
        .select("id", { count: "exact", head: true })
        .eq("status", "approved"),
      supabase
        .from("vendors")
        .select("id", { count: "exact", head: true })
        .eq("status", "rejected"),
      supabase.from("vendors").select("id", { count: "exact", head: true }),
    ]);

  const counts: Record<StatusFilter, number> = {
    pending: pendingCount.count ?? 0,
    approved: approvedCount.count ?? 0,
    rejected: rejectedCount.count ?? 0,
    all: allCount.count ?? 0,
  };

  return (
    <main className="mx-auto max-w-5xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
        <Link
          href="/vendors/new"
          className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-brand hover:text-brand"
        >
          Intake form
        </Link>
      </header>

      <section className="mt-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Vendors
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          Every vendor, every status
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          Made a mistake on a decision? Open the vendor and flip it — the
          status will update wherever it&apos;s shown.
        </p>
      </section>

      {/* Filter chips */}
      <nav className="mt-8 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          return (
            <Link
              key={f.key}
              href={`/dashboard/vendors?status=${f.key}`}
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs transition ${
                active
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              }`}
            >
              <span className="font-mono uppercase tracking-wider">
                {f.label}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                  active
                    ? "bg-brand/20 text-brand"
                    : "bg-neutral-900 text-neutral-500"
                }`}
              >
                {counts[f.key]}
              </span>
            </Link>
          );
        })}
      </nav>

      <section className="mt-6">
        {vendors && vendors.length > 0 ? (
          <ul className="space-y-2">
            {vendors.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/dashboard/vendors/${v.id}`}
                  className="block rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 transition hover:border-brand"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-neutral-100">
                        {v.legal_name}
                        {v.dba && (
                          <span className="ml-2 text-sm text-neutral-500">
                            · dba {v.dba}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-neutral-500">
                        {labelFor(
                          v.service_category as ServiceCategoryId | null
                        )}
                        <span className="mx-2 text-neutral-700">·</span>
                        <span className="text-neutral-600">
                          {v.contact_email}
                        </span>
                      </div>
                    </div>
                    <StatusBadge status={v.status} />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-600">
                    {v.ach_account_last4 && (
                      <span>ACH ···{v.ach_account_last4}</span>
                    )}
                    {v.secondary_payment_method && (
                      <span>+{v.secondary_payment_method}</span>
                    )}
                    {v.tin_match_status &&
                      v.tin_match_status !== "pending" && (
                        <span
                          className={
                            v.tin_match_status === "match"
                              ? "text-emerald-500"
                              : "text-red-400"
                          }
                        >
                          TIN: {v.tin_match_status}
                        </span>
                      )}
                    {v.submitted_at && (
                      <span>
                        submitted {formatShort(v.submitted_at)}
                      </span>
                    )}
                    {v.reviewed_at && (
                      <span>
                        reviewed {formatShort(v.reviewed_at)}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-neutral-800 bg-neutral-950 px-4 py-8 text-center text-sm text-neutral-500">
            {emptyMessage(filter)}
          </p>
        )}
      </section>
    </main>
  );
}

function emptyMessage(filter: StatusFilter): string {
  switch (filter) {
    case "pending":
      return "Nobody is waiting for review. Nice.";
    case "approved":
      return "No vendors have been approved yet.";
    case "rejected":
      return "No vendors have been rejected yet.";
    default:
      return "No vendors have submitted an intake form yet.";
  }
}

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === "approved"
      ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
      : status === "rejected"
      ? "border-red-900/60 bg-red-950/40 text-red-300"
      : status === "in_review"
      ? "border-amber-900/60 bg-amber-950/40 text-amber-200"
      : status === "submitted"
      ? "border-neutral-700 bg-neutral-900 text-neutral-200"
      : "border-neutral-800 bg-neutral-900 text-neutral-400";
  return (
    <span
      className={`shrink-0 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-wider ${styles}`}
    >
      {status}
    </span>
  );
}

function formatShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = Math.floor((now.getTime() - d.getTime()) / msPerDay);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
