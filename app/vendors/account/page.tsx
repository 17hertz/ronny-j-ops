/**
 * Vendor account home.
 *
 * This is the logged-in vendor's dashboard. Gated by Supabase auth +
 * a match between auth.users.id and vendors.auth_user_id.
 *
 * What it shows:
 *   - Welcome line + the vendor's status
 *   - Their W9 status (uploaded? signed?)
 *   - An "Invoices" section with a "Submit invoice" CTA and a list of
 *     their past invoices with current status
 *   - Account settings link (set/change password, change email)
 *
 * What it does NOT show:
 *   - Internal status beyond 'approved' / 'pending' — no "you're in
 *     review, internal reviewer notes X". Those are for us.
 *   - Other vendors' data (RLS + explicit auth_user_id match gates this)
 *   - Encrypted fields (same rule as the admin detail page — we don't
 *     decrypt tax IDs or full ACH anywhere outside the pay-now flow).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  labelFor,
  type ServiceCategoryId,
} from "@/lib/vendors/service-categories";
import { SignOutButton } from "@/app/dashboard/sign-out-button";

export const dynamic = "force-dynamic";

type VendorRow = {
  id: string;
  legal_name: string;
  dba: string | null;
  contact_email: string;
  contact_phone: string | null;
  service_category: string | null;
  status: string;
  ach_account_last4: string | null;
  ach_bank_name: string | null;
  secondary_payment_method: string | null;
  tin_match_status: string | null;
};

type DocumentRow = {
  id: string;
  kind: string;
  storage_path: string | null;
  invoice_number: string | null;
  invoice_amount_cents: number | null;
  invoice_status: string | null;
  invoice_description: string | null;
  generated_by_system: boolean;
  submitted_at: string | null;
  uploaded_at: string;
  original_filename: string | null;
};

type InvoiceWithUrl = DocumentRow & { signedUrl: string | null };

export default async function VendorAccountPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/vendors/login");

  // RLS policy "vendor self read" on vendors scopes this to their own row.
  // If they somehow don't have a vendor row (e.g. team member accidentally
  // visiting this page), kick them to the admin dashboard.
  const { data: vendor } = (await supabase
    .from("vendors")
    .select(
      "id, legal_name, dba, contact_email, contact_phone, service_category, status, ach_account_last4, ach_bank_name, secondary_payment_method, tin_match_status"
    )
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: VendorRow | null };

  if (!vendor) {
    // Could be a team member who wandered here. Redirect them home.
    redirect("/dashboard");
  }

  // Documents — use admin for signed URLs; RLS would work for reads but
  // createSignedUrl requires service role anyway.
  const admin = createAdminClient();
  const { data: docs } = (await (admin as any)
    .from("vendor_documents")
    .select(
      "id, kind, storage_path, invoice_number, invoice_amount_cents, invoice_status, invoice_description, generated_by_system, submitted_at, uploaded_at, original_filename"
    )
    .eq("vendor_id", vendor.id)
    .order("uploaded_at", { ascending: false })) as {
    data: DocumentRow[] | null;
  };

  const rawInvoices = (docs ?? []).filter((d) => d.kind === "invoice");
  const w9s = (docs ?? []).filter((d) => d.kind === "w9");
  const hasW9 = w9s.length > 0;

  // Generate a short-lived signed URL for each invoice PDF so the vendor can
  // click through and view their own submission. Bucket is private — this is
  // the only way in. 10 minutes is plenty for a click-through.
  const invoices: InvoiceWithUrl[] = await Promise.all(
    rawInvoices.map(async (inv) => {
      if (!inv.storage_path) return { ...inv, signedUrl: null };
      const { data: signed } = await admin.storage
        .from("vendor-docs")
        .createSignedUrl(inv.storage_path, 600);
      return { ...inv, signedUrl: signed?.signedUrl ?? null };
    })
  );

  const statusIsApproved = vendor.status === "approved";
  const statusIsRejected = vendor.status === "rejected";

  return (
    <main className="mx-auto max-w-3xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← 17 Hertz
        </Link>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span>{user.email}</span>
          <SignOutButton redirectTo="/vendors/login" />
        </div>
      </header>

      <section className="mt-10">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Vendor account
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          {vendor.legal_name}
        </h1>
        {vendor.dba && (
          <p className="mt-1 text-sm text-neutral-500">dba {vendor.dba}</p>
        )}
        <p className="mt-3 text-sm text-neutral-400">
          {labelFor(vendor.service_category as ServiceCategoryId | null)}
        </p>
      </section>

      {/* Status banner */}
      <section className="mt-8">
        {statusIsApproved ? (
          <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-400">
              Approved
            </p>
            <p className="mt-1 text-sm text-emerald-100">
              You&apos;re all set to submit invoices. When you do, we&apos;ll
              review them and pay out to ACH ···{vendor.ach_account_last4}.
            </p>
          </div>
        ) : statusIsRejected ? (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-red-400">
              Not approved
            </p>
            <p className="mt-1 text-sm text-red-100">
              Your vendor application wasn&apos;t approved. If you think that
              was a mistake, reply to the most recent email from us.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-400">
              Under review
            </p>
            <p className="mt-1 text-sm text-amber-100">
              We&apos;ve got your info. Someone at 17 Hertz is reviewing your
              application — we&apos;ll email you when a decision is made.
            </p>
          </div>
        )}
      </section>

      {/* Invoices */}
      {statusIsApproved && (
        <section className="mt-10">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-2xl">Invoices</h2>
            <Link
              href="/vendors/invoices/new"
              className="rounded-md border border-brand bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
            >
              Submit invoice
            </Link>
          </div>

          {invoices.length === 0 ? (
            <p className="mt-4 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-6 text-sm text-neutral-500">
              You haven&apos;t submitted any invoices yet. Hit{" "}
              <strong className="text-neutral-300">Submit invoice</strong>{" "}
              when you&apos;re ready — you can upload a PDF or fill out a
              short form and we&apos;ll generate one for you.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {invoices.map((inv) => {
                const body = (
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-neutral-100">
                        {inv.invoice_number
                          ? `Invoice ${inv.invoice_number}`
                          : inv.original_filename ?? "Invoice"}
                        {inv.generated_by_system && (
                          <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-brand">
                            generated
                          </span>
                        )}
                        {inv.signedUrl && (
                          <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-neutral-500">
                            view pdf ↗
                          </span>
                        )}
                      </div>
                      {inv.invoice_description && (
                        <p className="mt-0.5 truncate text-xs text-neutral-500">
                          {inv.invoice_description}
                        </p>
                      )}
                      <p className="mt-1 font-mono text-xs text-neutral-600">
                        {inv.invoice_amount_cents != null
                          ? formatMoney(inv.invoice_amount_cents)
                          : "—"}
                        {" · "}
                        {inv.submitted_at
                          ? new Date(inv.submitted_at).toLocaleDateString()
                          : new Date(inv.uploaded_at).toLocaleDateString()}
                      </p>
                    </div>
                    <InvoiceStatusBadge status={inv.invoice_status} />
                  </div>
                );

                return (
                  <li key={inv.id}>
                    {inv.signedUrl ? (
                      <a
                        href={inv.signedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 transition hover:border-brand hover:bg-neutral-900"
                      >
                        {body}
                      </a>
                    ) : (
                      <div className="block rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3">
                        {body}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Identity / W9 summary */}
      <section className="mt-10">
        <h2 className="font-display text-2xl">Your info</h2>
        <div className="mt-4 grid gap-4 rounded-lg border border-neutral-800 bg-neutral-950 p-5 md:grid-cols-2">
          <Field label="Legal name" value={vendor.legal_name} />
          <Field label="Email" value={vendor.contact_email} />
          <Field label="Phone" value={vendor.contact_phone || "—"} />
          <Field
            label="Bank"
            value={
              vendor.ach_bank_name && vendor.ach_account_last4
                ? `${vendor.ach_bank_name} · ···${vendor.ach_account_last4}`
                : "—"
            }
          />
          <Field
            label="W9 on file"
            value={hasW9 ? "Yes" : "Not yet"}
            valueClass={hasW9 ? "text-emerald-400" : "text-amber-400"}
          />
          <Field
            label="Secondary payment"
            value={
              vendor.secondary_payment_method
                ? `${vendor.secondary_payment_method}`
                : "—"
            }
          />
        </div>
        <p className="mt-3 text-xs text-neutral-600">
          Need to update any of this?{" "}
          <Link
            href="/vendors/account/settings"
            className="underline hover:text-brand"
          >
            Account settings
          </Link>
        </p>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  valueClass = "text-neutral-100",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
        {label}
      </p>
      <p className={`mt-1 text-sm ${valueClass}`}>{value}</p>
    </div>
  );
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
      className={`shrink-0 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-wider ${styles}`}
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
