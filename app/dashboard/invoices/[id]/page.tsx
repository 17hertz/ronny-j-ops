/**
 * Admin invoice review detail page.
 *
 * Jason or Ronny lands here from the "Pending invoices" panel. Shows
 * everything needed to decide whether to approve, reject, or mark an
 * invoice paid:
 *
 *   - Vendor, invoice metadata, amount, description, due date
 *   - Who submitted it and when
 *   - A signed URL (5-minute TTL) to open the invoice PDF in a new tab
 *   - Review action buttons (approve / reject / under review / mark paid)
 *
 * Authz:
 *   - Must be signed in + have a team_members row. Non-team members get
 *     bounced to /dashboard (same pattern as the vendor review page).
 *
 * What this does NOT do:
 *   - Does NOT actually move money. "Mark paid" is a bookkeeping flip
 *     that assumes Jason/Ronny have initiated the transfer outside the
 *     app (ACH batch, Zelle, etc).
 *   - Does NOT email the vendor. That will be a downstream notifier.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InvoiceReviewActions } from "./review-actions";

export const dynamic = "force-dynamic";

const DOCS_BUCKET = "vendor-docs";

type InvoiceRow = {
  id: string;
  kind: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  byte_size: number | null;
  invoice_number: string | null;
  invoice_description: string | null;
  invoice_amount_cents: number | null;
  invoice_due_at: string | null;
  invoice_status: string | null;
  generated_by_system: boolean | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  paid_at: string | null;
  uploaded_at: string;
  vendor_id: string;
  vendor: {
    id: string;
    legal_name: string;
    contact_email: string;
    ach_account_last4: string | null;
  } | null;
};

type ReviewerRow = {
  id: string;
  full_name: string;
};

export default async function InvoiceReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: teamMember } = (await supabase
    .from("team_members")
    .select("id, full_name, role")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; full_name: string; role: string } | null;
  };
  if (!teamMember) redirect("/dashboard");

  const admin = createAdminClient();

  const { data: invoice } = (await (admin as any)
    .from("vendor_documents")
    .select(
      `
      id, kind, storage_path, original_filename, mime_type, byte_size,
      invoice_number, invoice_description, invoice_amount_cents,
      invoice_due_at, invoice_status, generated_by_system, submitted_at,
      reviewed_by, reviewed_at, review_notes, paid_at, uploaded_at,
      vendor_id,
      vendor:vendors ( id, legal_name, contact_email, ach_account_last4 )
      `
    )
    .eq("id", params.id)
    .eq("kind", "invoice")
    .maybeSingle()) as { data: InvoiceRow | null };

  if (!invoice) notFound();

  // Reviewer display name (if reviewed).
  let reviewer: ReviewerRow | null = null;
  if (invoice.reviewed_by) {
    const { data: r } = (await (admin as any)
      .from("team_members")
      .select("id, full_name")
      .eq("id", invoice.reviewed_by)
      .maybeSingle()) as { data: ReviewerRow | null };
    reviewer = r ?? null;
  }

  const { data: signed } = await (admin as any).storage
    .from(DOCS_BUCKET)
    .createSignedUrl(invoice.storage_path, 60 * 5);
  const signedUrl: string | null = signed?.signedUrl ?? null;

  const vendor = invoice.vendor;

  return (
    <main className="mx-auto max-w-4xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
        <InvoiceStatusBadge status={invoice.invoice_status} />
      </header>

      <section className="mt-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Invoice review
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          Invoice {invoice.invoice_number ?? invoice.id.slice(0, 8)}
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          {vendor?.legal_name ?? "(vendor missing)"}
          {invoice.generated_by_system && (
            <>
              <span className="mx-2 text-neutral-700">·</span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-brand">
                system-generated
              </span>
            </>
          )}
          {invoice.submitted_at && (
            <>
              <span className="mx-2 text-neutral-700">·</span>
              <span>
                submitted{" "}
                {new Date(invoice.submitted_at).toLocaleDateString()}
              </span>
            </>
          )}
        </p>
      </section>

      <div className="mt-10 grid gap-6 md:grid-cols-[1fr_240px]">
        <section className="space-y-6">
          <Card title="Vendor">
            <Dl>
              <Dt>Legal name</Dt>
              <Dd>{vendor?.legal_name ?? "—"}</Dd>
              <Dt>Email</Dt>
              <Dd>{vendor?.contact_email ?? "—"}</Dd>
              <Dt>ACH</Dt>
              <Dd>
                {vendor?.ach_account_last4 ? (
                  <span className="font-mono">
                    ···{vendor.ach_account_last4}
                  </span>
                ) : (
                  "—"
                )}
              </Dd>
              {vendor?.id && (
                <>
                  <Dt>Record</Dt>
                  <Dd>
                    <Link
                      href={`/dashboard/vendors/${vendor.id}`}
                      className="underline hover:text-brand"
                    >
                      Open vendor profile
                    </Link>
                  </Dd>
                </>
              )}
            </Dl>
          </Card>

          <Card title="Invoice">
            <Dl>
              <Dt>Number</Dt>
              <Dd className="font-mono">{invoice.invoice_number ?? "—"}</Dd>
              <Dt>Amount</Dt>
              <Dd className="font-mono">
                {invoice.invoice_amount_cents != null
                  ? formatMoney(invoice.invoice_amount_cents)
                  : "—"}
              </Dd>
              <Dt>Due date</Dt>
              <Dd>
                {invoice.invoice_due_at
                  ? new Date(invoice.invoice_due_at).toLocaleDateString()
                  : "—"}
              </Dd>
              <Dt>Description</Dt>
              <Dd>
                {invoice.invoice_description ? (
                  <span className="whitespace-pre-line">
                    {invoice.invoice_description}
                  </span>
                ) : (
                  "—"
                )}
              </Dd>
            </Dl>
          </Card>

          {(invoice.reviewed_at || invoice.review_notes) && (
            <Card title="Review">
              <Dl>
                <Dt>Reviewed by</Dt>
                <Dd>{reviewer?.full_name ?? "—"}</Dd>
                <Dt>Reviewed at</Dt>
                <Dd>
                  {invoice.reviewed_at
                    ? new Date(invoice.reviewed_at).toLocaleString()
                    : "—"}
                </Dd>
                {invoice.review_notes && (
                  <>
                    <Dt>Notes</Dt>
                    <Dd>
                      <span className="whitespace-pre-line">
                        {invoice.review_notes}
                      </span>
                    </Dd>
                  </>
                )}
                {invoice.paid_at && (
                  <>
                    <Dt>Paid at</Dt>
                    <Dd>{new Date(invoice.paid_at).toLocaleString()}</Dd>
                  </>
                )}
              </Dl>
            </Card>
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
              PDF
            </h3>
            {signedUrl ? (
              <a
                href={signedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 block w-full rounded-md border border-brand bg-brand px-4 py-2 text-center text-sm font-medium text-white transition hover:opacity-90"
              >
                Open PDF
              </a>
            ) : (
              <p className="mt-3 text-xs text-red-400">Link unavailable.</p>
            )}
            <p className="mt-2 text-[11px] text-neutral-500">
              {invoice.byte_size
                ? prettyBytes(invoice.byte_size)
                : "—"}
              {" · "}opens in new tab
            </p>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
              Actions
            </h3>
            <div className="mt-4">
              <InvoiceReviewActions
                invoiceId={invoice.id}
                currentStatus={invoice.invoice_status ?? "submitted"}
              />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

// ---------- layout primitives ----------

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Dl({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
      {children}
    </dl>
  );
}
function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-neutral-500">{children}</dt>;
}
function Dd({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <dd className={`text-neutral-100 ${className}`}>{children}</dd>;
}

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

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
