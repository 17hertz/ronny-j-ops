/**
 * Public vendor intake form.
 *
 * This is the form we send to new vendors (security, photographers,
 * equipment rentals, drivers, etc.) so 17 Hertz Inc. can pay them. Collects:
 *
 *   1. Company / individual info
 *   2. Service category (drives dashboard filters + reminder copy)
 *   3. W9 fields (legal name, address, tax classification, EIN/SSN)
 *   4. ACH bank details — REQUIRED
 *   5. Optional secondary payment rail (Zelle / PayPal / Venmo)
 *   6. W9 PDF upload
 *
 * This route is public (no auth). It only writes to `vendors` via a
 * service-role handler at /api/vendors/submit. Jason / Ronny review and
 * approve inside the dashboard.
 */
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { VendorIntakeForm } from "./vendor-intake-form";

export const metadata = {
  title: "Vendor intake · Ronny J Ops",
  description:
    "Secure intake form for 17 Hertz Inc. vendors — tax info, ACH, and W9 submission.",
};

// This page is rendered per-request because it can be keyed to a one-time
// invite token in the query string.
export const dynamic = "force-dynamic";

type InviteLookup =
  | { kind: "none" }
  | { kind: "valid"; email: string; personalNote: string | null; token: string }
  | { kind: "claimed" }
  | { kind: "expired" }
  | { kind: "unknown" };

async function lookupInvite(token: string | undefined): Promise<InviteLookup> {
  if (!token) return { kind: "none" };
  const admin = createAdminClient();
  const { data } = (await (admin as any)
    .from("vendor_invites")
    .select("email, personal_note, claimed_at, expires_at")
    .eq("token", token)
    .maybeSingle()) as {
    data: {
      email: string;
      personal_note: string | null;
      claimed_at: string | null;
      expires_at: string;
    } | null;
  };
  if (!data) return { kind: "unknown" };
  if (data.claimed_at) return { kind: "claimed" };
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return { kind: "expired" };
  }
  return {
    kind: "valid",
    email: data.email,
    personalNote: data.personal_note,
    token,
  };
}

export default async function VendorIntakePage({
  searchParams,
}: {
  searchParams?: { invite?: string };
}) {
  const invite = await lookupInvite(searchParams?.invite);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12 sm:px-8 sm:py-16">
      <Link
        href="/"
        className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
      >
        ← Ronny J Ops
      </Link>

      <p className="mt-10 font-mono text-xs uppercase tracking-[0.3em] text-brand">
        17 Hertz Inc. · vendor onboarding
      </p>
      <h1 className="mt-4 font-display text-5xl leading-tight">
        Get <span className="italic text-brand">paid.</span>
      </h1>
      <p className="mt-4 max-w-2xl text-neutral-400">
        Fill this out once. We&apos;ll have your W9 on file, your bank
        details encrypted, and your first invoice ready to go. Takes about
        four minutes.
      </p>

      {invite.kind === "valid" && (
        <div className="mt-8 rounded-lg border border-brand/40 bg-brand/5 px-4 py-3 text-sm text-neutral-200">
          <p className="font-medium text-brand">Invite recognized.</p>
          <p className="mt-1 text-neutral-300">
            We&apos;ve pre-filled the email on this form for{" "}
            <span className="text-neutral-100">{invite.email}</span>.
          </p>
        </div>
      )}
      {invite.kind === "claimed" && (
        <div className="mt-8 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-400">
          This invite link was already used. If that wasn&apos;t you, reply
          to the invite email and we&apos;ll sort it out.
        </div>
      )}
      {invite.kind === "expired" && (
        <div className="mt-8 rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
          This invite link has expired. Reply to the original email and
          we&apos;ll send you a fresh one.
        </div>
      )}
      {invite.kind === "unknown" && (
        <div className="mt-8 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-400">
          We didn&apos;t recognize that invite link — you can still fill in
          the form below and we&apos;ll review your submission.
        </div>
      )}

      <div className="mt-10 rounded-lg border border-neutral-800 bg-neutral-950 p-6 sm:p-8">
        <VendorIntakeForm
          prefillEmail={invite.kind === "valid" ? invite.email : undefined}
          inviteToken={invite.kind === "valid" ? invite.token : undefined}
          emailLocked={invite.kind === "valid"}
        />
      </div>

      <p className="mt-10 text-xs text-neutral-600">
        Your tax ID and bank details are encrypted at rest. Only finance
        admins at 17 Hertz Inc. can view approved payment info.
      </p>
    </main>
  );
}
