/**
 * Vendor review detail page.
 *
 * Jason or Ronny lands here from the "Awaiting review" panel on the
 * dashboard. Shows everything needed to approve a payout-eligible vendor:
 *
 *   - Identity + contact info
 *   - Service category + vendor's own notes
 *   - Tax ID last4 (full remains encrypted on the server)
 *   - ACH bank info (last4 only — never surface full routing/account in UI)
 *   - Secondary payment method if set
 *   - Uploaded documents (W9, etc.) — each with a time-limited signed URL
 *   - Approve / Reject buttons
 *
 * Encrypted fields are NOT decrypted on this page. That's a deliberate
 * choice: the admin never needs to see the full EIN or routing number to
 * decide "is this a real vendor." They only need to see it when they're
 * actually initiating a payment — which runs through a separate "pay now"
 * flow that's gated by step-up auth (to be built).
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  labelFor,
  type ServiceCategoryId,
} from "@/lib/vendors/service-categories";
import { ReviewActions } from "./review-actions";
import { RevealBankingButton } from "./reveal-banking-button";

export const dynamic = "force-dynamic";

const DOCS_BUCKET = "vendor-docs";

type VendorRow = {
  id: string;
  legal_name: string;
  dba: string | null;
  vendor_type: string | null;
  contact_name: string | null;
  contact_email: string;
  contact_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  service_category: string | null;
  service_notes: string | null;
  tax_id_last4: string | null;
  tin_match_status: string | null;
  ach_account_holder_name: string | null;
  ach_bank_name: string | null;
  ach_routing_last4: string | null;
  ach_account_last4: string | null;
  ach_account_type: string | null;
  secondary_payment_method: string | null;
  secondary_payment_handle: string | null;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  notes: string | null;
  portal_token: string | null;
};

type DocumentRow = {
  id: string;
  kind: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  byte_size: number | null;
  uploaded_at: string;
  signed_at: string | null;
};

export default async function VendorReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Authorize — must be a team member. RLS would enforce this on the
  // query too, but checking explicitly lets us show a nice "not on the
  // team" screen instead of an empty page.
  const { data: teamMember } = (await supabase
    .from("team_members")
    .select("id, full_name, role")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; full_name: string; role: string } | null;
  };
  if (!teamMember) redirect("/dashboard");

  const { data: vendor } = (await supabase
    .from("vendors")
    .select(
      "id, legal_name, dba, vendor_type, contact_name, contact_email, contact_phone, address_line1, address_line2, city, state, postal_code, country, service_category, service_notes, tax_id_last4, tin_match_status, ach_account_holder_name, ach_bank_name, ach_routing_last4, ach_account_last4, ach_account_type, secondary_payment_method, secondary_payment_handle, status, submitted_at, reviewed_at, notes, portal_token"
    )
    .eq("id", params.id)
    .maybeSingle()) as { data: VendorRow | null };

  if (!vendor) notFound();

  // Documents — service-role because RLS + signed-URL generation both
  // want admin. Signed URLs are short-lived (5 min) so a screenshot
  // of this page doesn't leak anything long-term.
  const admin = createAdminClient();
  const { data: docs } = (await (admin as any)
    .from("vendor_documents")
    .select(
      "id, kind, storage_path, original_filename, mime_type, byte_size, uploaded_at, signed_at"
    )
    .eq("vendor_id", vendor.id)
    .order("uploaded_at", { ascending: false })) as {
    data: DocumentRow[] | null;
  };

  const docsWithUrls = await Promise.all(
    (docs ?? []).map(async (d) => {
      const { data: signed } = await (admin as any).storage
        .from(DOCS_BUCKET)
        .createSignedUrl(d.storage_path, 300); // 5 min
      return { ...d, signedUrl: signed?.signedUrl ?? null };
    })
  );

  const address = [
    vendor.address_line1,
    vendor.address_line2,
    [vendor.city, vendor.state].filter(Boolean).join(", "),
    vendor.postal_code,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <main className="mx-auto max-w-4xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
        <StatusBadge status={vendor.status} />
      </header>

      <section className="mt-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Vendor review
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          {vendor.legal_name}
        </h1>
        {vendor.dba && (
          <p className="mt-1 text-sm text-neutral-500">
            doing business as{" "}
            <span className="text-neutral-300">{vendor.dba}</span>
          </p>
        )}
        <p className="mt-3 text-sm text-neutral-400">
          {labelFor(vendor.service_category as ServiceCategoryId | null)}
          {vendor.vendor_type && (
            <>
              <span className="mx-2 text-neutral-700">·</span>
              <span className="uppercase tracking-wider text-neutral-500">
                {vendor.vendor_type}
              </span>
            </>
          )}
          {vendor.submitted_at && (
            <>
              <span className="mx-2 text-neutral-700">·</span>
              <span className="text-neutral-500">
                submitted{" "}
                {new Date(vendor.submitted_at).toLocaleDateString()}
              </span>
            </>
          )}
        </p>
      </section>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <Card title="Contact">
          <Dl>
            <Dt>Name</Dt>
            <Dd>{vendor.contact_name || "—"}</Dd>
            <Dt>Email</Dt>
            <Dd>{vendor.contact_email}</Dd>
            <Dt>Phone</Dt>
            <Dd>{vendor.contact_phone || "—"}</Dd>
            <Dt>Address</Dt>
            <Dd>
              {address ? (
                <span className="whitespace-pre-line">{address}</span>
              ) : (
                "—"
              )}
            </Dd>
          </Dl>
        </Card>

        <Card title="Tax (W9)">
          <Dl>
            <Dt>EIN / SSN</Dt>
            <Dd>
              {vendor.tax_id_last4 ? (
                <span className="font-mono">
                  •••&nbsp;••&nbsp;{vendor.tax_id_last4}
                </span>
              ) : (
                <span className="text-neutral-600">not provided</span>
              )}
            </Dd>
            <Dt>TIN match</Dt>
            <Dd>
              <TinBadge status={vendor.tin_match_status} />
            </Dd>
          </Dl>
        </Card>

        <Card title="ACH payout (primary)">
          <Dl>
            <Dt>Account holder</Dt>
            <Dd>{vendor.ach_account_holder_name || "—"}</Dd>
            <Dt>Bank</Dt>
            <Dd>{vendor.ach_bank_name || "—"}</Dd>
            <Dt>Account type</Dt>
            <Dd className="capitalize">{vendor.ach_account_type || "—"}</Dd>
            <Dt>Routing</Dt>
            <Dd>
              {vendor.ach_routing_last4 ? (
                <span className="font-mono">
                  •••••&nbsp;{vendor.ach_routing_last4}
                </span>
              ) : (
                "—"
              )}
            </Dd>
            <Dt>Account</Dt>
            <Dd>
              {vendor.ach_account_last4 ? (
                <span className="font-mono">
                  ••••&nbsp;{vendor.ach_account_last4}
                </span>
              ) : (
                "—"
              )}
            </Dd>
          </Dl>
          {/* Reveal button — decrypts server-side on click, displays
              plaintext for 30s, auto-hides. Every reveal lands in the
              banking_reveals audit table so we always know who looked
              at what and when. */}
          {(vendor.ach_account_last4 || vendor.tax_id_last4) && (
            <RevealBankingButton
              vendorId={vendor.id}
              hasAch={!!vendor.ach_account_last4}
              hasTaxId={!!vendor.tax_id_last4}
            />
          )}
        </Card>

        <Card title="Secondary payment (optional)">
          {vendor.secondary_payment_method ? (
            <Dl>
              <Dt>Method</Dt>
              <Dd className="capitalize">{vendor.secondary_payment_method}</Dd>
              <Dt>Handle</Dt>
              <Dd className="break-all">
                {vendor.secondary_payment_handle || "—"}
              </Dd>
            </Dl>
          ) : (
            <p className="text-sm text-neutral-500">
              Vendor didn&apos;t add a backup method. ACH only.
            </p>
          )}
        </Card>

        <Card title="Service notes" span>
          {vendor.service_notes ? (
            <p className="whitespace-pre-line text-sm text-neutral-300">
              {vendor.service_notes}
            </p>
          ) : (
            <p className="text-sm text-neutral-600">
              Vendor didn&apos;t leave any notes.
            </p>
          )}
        </Card>

        <Card title="Documents" span>
          {docsWithUrls.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No documents uploaded yet.{" "}
              {vendor.portal_token && (
                <>
                  Send the vendor to{" "}
                  <code className="rounded bg-neutral-900 px-1 py-0.5 text-xs">
                    /vendors/portal/{vendor.portal_token.slice(0, 8)}…
                  </code>{" "}
                  to upload a W9.
                </>
              )}
            </p>
          ) : (
            <ul className="space-y-2">
              {docsWithUrls.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between rounded-md border border-neutral-800 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-neutral-100">
                      <span className="mr-2 font-mono text-[10px] uppercase tracking-wider text-brand">
                        {d.kind}
                      </span>
                      {d.original_filename ?? "untitled"}
                    </div>
                    <div className="text-xs text-neutral-600">
                      {d.mime_type ?? "?"}
                      {d.byte_size ? ` · ${prettyBytes(d.byte_size)}` : ""}{" "}
                      · uploaded{" "}
                      {new Date(d.uploaded_at).toLocaleDateString()}
                    </div>
                  </div>
                  {d.signedUrl ? (
                    <a
                      href={d.signedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-3 rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-brand hover:text-brand"
                    >
                      View
                    </a>
                  ) : (
                    <span className="ml-3 text-xs text-red-400">
                      link unavailable
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className="mt-10 rounded-lg border border-neutral-800 bg-neutral-950 p-6">
        <h2 className="font-display text-xl">Decision</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Approving marks this vendor as eligible for payouts. Rejecting
          flags them so Jason/Ronny don&apos;t accidentally pay.
        </p>
        <div className="mt-4">
          <ReviewActions
            vendorId={vendor.id}
            currentStatus={vendor.status}
            initialNotes={vendor.notes ?? ""}
          />
        </div>
        {vendor.reviewed_at && (
          <p className="mt-3 text-xs text-neutral-600">
            Last reviewed{" "}
            {new Date(vendor.reviewed_at).toLocaleString()}
          </p>
        )}
      </section>
    </main>
  );
}

// ---------- small layout primitives ----------

function Card({
  title,
  span,
  children,
}: {
  title: string;
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-neutral-800 bg-neutral-950 p-5 ${
        span ? "md:col-span-2" : ""
      }`}
    >
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

function StatusBadge({ status }: { status: string }) {
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
      className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-wider ${styles}`}
    >
      {status}
    </span>
  );
}

function TinBadge({ status }: { status: string | null }) {
  if (!status || status === "pending")
    return <span className="text-neutral-500">pending</span>;
  if (status === "match")
    return <span className="text-emerald-400">match</span>;
  return <span className="text-red-400">{status}</span>;
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
