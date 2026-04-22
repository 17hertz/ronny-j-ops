/**
 * Vendor self-service portal.
 *
 * Reached via the portal_token emailed after intake submit. This is the
 * vendor's only way back in — we explicitly don't want vendors to need
 * an account.
 *
 * Today this page only handles W9 upload. When we add digital signing
 * (DocuSeal — see todolist.txt) the "sign digitally" button lives here
 * next to the upload option.
 *
 * Token is validated server-side: must exist, must not be expired, and
 * the vendor must not already be approved/rejected.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { labelFor } from "@/lib/vendors/service-categories";
import { W9UploadForm } from "./w9-upload-form";
import type { ServiceCategoryId } from "@/lib/vendors/service-categories";

export const dynamic = "force-dynamic";

type VendorRow = {
  id: string;
  legal_name: string;
  contact_email: string;
  service_category: string | null;
  status: string;
  portal_token_expires_at: string | null;
};

type DocumentRow = {
  id: string;
  kind: string;
  original_filename: string | null;
  uploaded_at: string;
};

export default async function VendorPortalPage({
  params,
}: {
  params: { token: string };
}) {
  const admin = createAdminClient();

  const { data: vendor } = (await (admin as any)
    .from("vendors")
    .select(
      "id, legal_name, contact_email, service_category, status, portal_token_expires_at"
    )
    .eq("portal_token", params.token)
    .maybeSingle()) as { data: VendorRow | null };

  if (!vendor) return notFound();

  // Soft-expire rather than hard 404 so a vendor who fat-fingers the URL
  // doesn't see an ambiguous "not found." They can always reach out.
  const expired =
    vendor.portal_token_expires_at &&
    new Date(vendor.portal_token_expires_at).getTime() < Date.now();

  // What they've already uploaded, so we can show it back to them.
  const { data: existingDocs } = (await (admin as any)
    .from("vendor_documents")
    .select("id, kind, original_filename, uploaded_at")
    .eq("vendor_id", vendor.id)
    .order("uploaded_at", { ascending: false })) as {
    data: DocumentRow[] | null;
  };

  const hasW9 = (existingDocs ?? []).some((d) => d.kind === "w9");

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-12 sm:px-8 sm:py-16">
      <Link
        href="/"
        className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
      >
        ← Ronny J Ops
      </Link>

      <p className="mt-10 font-mono text-xs uppercase tracking-[0.3em] text-brand">
        17 Hertz Inc. · vendor portal
      </p>
      <h1 className="mt-4 font-display text-4xl leading-tight">
        Hey {firstWord(vendor.legal_name)}.
      </h1>
      <p className="mt-3 text-neutral-400">
        Status: <StatusPill status={vendor.status} /> · Service:{" "}
        {labelFor(vendor.service_category as ServiceCategoryId | null)}
      </p>

      {expired ? (
        <div className="mt-10 rounded-lg border border-amber-900/50 bg-amber-950/30 p-6">
          <p className="font-display text-xl text-amber-200">
            This link has expired.
          </p>
          <p className="mt-2 text-sm text-amber-200/80">
            Portal links are good for 30 days. Email{" "}
            <a
              href="mailto:info@17hertz.com"
              className="underline"
            >
              info@17hertz.com
            </a>{" "}
            and we&apos;ll send you a fresh one.
          </p>
        </div>
      ) : (
        <>
          {/* --- W9 upload --- */}
          <section className="mt-10 rounded-lg border border-neutral-800 bg-neutral-950 p-6 sm:p-8">
            <h2 className="font-display text-2xl">
              {hasW9 ? "W9 on file" : "Upload your signed W9"}
            </h2>
            {hasW9 ? (
              <div className="mt-4 space-y-2">
                {existingDocs
                  ?.filter((d) => d.kind === "w9")
                  .map((d) => (
                    <p
                      key={d.id}
                      className="text-sm text-neutral-400"
                    >
                      ✓{" "}
                      <span className="text-neutral-200">
                        {d.original_filename ?? "W9.pdf"}
                      </span>{" "}
                      — uploaded{" "}
                      {new Date(d.uploaded_at).toLocaleDateString()}
                    </p>
                  ))}
                <p className="mt-4 text-sm text-neutral-500">
                  Need to replace it? Upload a new one below and we&apos;ll
                  use the most recent.
                </p>
                <W9UploadForm token={params.token} />
              </div>
            ) : (
              <>
                <p className="mt-2 text-sm text-neutral-400">
                  If you don&apos;t have a W9 ready, grab the official form
                  from the IRS, fill it in, sign, and upload the PDF (or a
                  clear scan).
                </p>
                <a
                  href="https://www.irs.gov/pub/irs-pdf/fw9.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-block font-mono text-xs uppercase tracking-[0.2em] text-brand underline"
                >
                  Download IRS Form W-9 →
                </a>
                <div className="mt-6">
                  <W9UploadForm token={params.token} />
                </div>
              </>
            )}
          </section>

          <p className="mt-10 text-xs text-neutral-600">
            Once we have your W9 and verify your info, Jason or Ronny will
            approve your account and you&apos;ll be eligible for payouts.
          </p>
        </>
      )}
    </main>
  );
}

function firstWord(s: string): string {
  const w = s.trim().split(/\s+/)[0] ?? s;
  // Strip trailing punctuation like "Inc." -> "Inc"
  return w.replace(/[.,]+$/, "");
}

function StatusPill({ status }: { status: string }) {
  const styles =
    status === "approved"
      ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
      : status === "rejected"
      ? "border-red-900/60 bg-red-950/40 text-red-300"
      : status === "in_review"
      ? "border-amber-900/60 bg-amber-950/40 text-amber-200"
      : "border-neutral-800 bg-neutral-900 text-neutral-300";
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${styles}`}
    >
      {status}
    </span>
  );
}
