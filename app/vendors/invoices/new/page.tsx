/**
 * Vendor invoice submission page.
 *
 * Two modes behind a tabbed client component:
 *   1. Upload PDF — vendor already has an invoice they generated elsewhere
 *   2. Generate invoice — we render a PDF from a short form
 *
 * Guardrails enforced here (Server Component):
 *   - Must be signed in as a vendor → else /vendors/login
 *   - Vendor status must be "approved" → else a gentle "not yet" page
 *
 * The actual form + submit logic lives in ./invoice-form.tsx. This page is
 * deliberately thin so that auth + status checks happen server-side before
 * any form UI is even streamed down.
 *
 * What this does NOT do:
 *   - Does NOT list past invoices. That's on /vendors/account.
 *   - Does NOT decrypt or display full ACH. Only last4 for "payment goes
 *     to ···last4" context.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentVendor } from "@/lib/vendors/get-current-vendor";
import { InvoiceForm } from "./invoice-form";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  const { vendor } = await getCurrentVendor();

  if (!vendor) {
    redirect("/vendors/login");
  }

  if (vendor.status !== "approved") {
    return (
      <main className="mx-auto max-w-2xl px-8 py-12">
        <header>
          <Link
            href="/vendors/account"
            className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
          >
            ← Account
          </Link>
        </header>

        <section className="mt-10">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
            Not ready yet
          </p>
          <h1 className="mt-2 font-display text-4xl leading-tight">
            Only approved vendors can submit invoices.
          </h1>
          <p className="mt-4 text-neutral-400">
            Your vendor application is still being reviewed. Once Jason or
            Ronny approves you, this page will let you upload or generate an
            invoice and we&apos;ll route payment to your ACH on file.
          </p>
          <div className="mt-8">
            <Link
              href="/vendors/account"
              className="rounded-md border border-neutral-800 px-4 py-2 text-sm text-neutral-300 transition hover:border-brand hover:text-brand"
            >
              Back to account
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-8 py-12">
      <header>
        <Link
          href="/vendors/account"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Account
        </Link>
      </header>

      <section className="mt-10">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Submit invoice
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          New invoice
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          <span className="text-neutral-200">{vendor.legal_name}</span>
          {vendor.ach_account_last4 && (
            <>
              {" · "}
              Payment will route to ACH ···{vendor.ach_account_last4}
            </>
          )}
        </p>
      </section>

      <section className="mt-10">
        <InvoiceForm
          vendorLegalName={vendor.legal_name}
          achLast4={vendor.ach_account_last4}
        />
      </section>
    </main>
  );
}
