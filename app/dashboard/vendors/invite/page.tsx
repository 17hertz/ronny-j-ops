/**
 * Admin page: invite a new vendor.
 *
 * Two sections:
 *   - A small form: email + optional personal note → POST /api/admin/vendors/invite
 *   - A list of outstanding invites (sent but not claimed yet) with the
 *     ability to resend. Claimed invites drop off this list so it's always
 *     the "I'm still waiting on these" view.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

type InviteRow = {
  id: string;
  email: string;
  personal_note: string | null;
  sent_at: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_vendor_id: string | null;
  invited_by: string | null;
};

export default async function InviteVendorPage() {
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

  // Outstanding (unclaimed) invites, most recent first
  const { data: outstanding } = (await supabase
    .from("vendor_invites")
    .select(
      "id, email, personal_note, sent_at, expires_at, claimed_at, claimed_vendor_id, invited_by"
    )
    .is("claimed_at", null)
    .order("sent_at", { ascending: false })
    .limit(20)) as { data: InviteRow[] | null };

  // Recently claimed — for the "they actually filled it out" confirmation
  const { data: recentlyClaimed } = (await supabase
    .from("vendor_invites")
    .select(
      "id, email, personal_note, sent_at, expires_at, claimed_at, claimed_vendor_id, invited_by"
    )
    .not("claimed_at", "is", null)
    .order("claimed_at", { ascending: false })
    .limit(5)) as { data: InviteRow[] | null };

  return (
    <main className="mx-auto max-w-3xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
        <Link
          href="/dashboard/vendors"
          className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-brand hover:text-brand"
        >
          All vendors
        </Link>
      </header>

      <section className="mt-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Vendors
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          Invite a new vendor
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          Send someone a tokenized link to the intake form. They fill in their
          W9 + bank details, you approve them on the dashboard, and they can
          log in to submit invoices.
        </p>
      </section>

      <section className="mt-8">
        <InviteForm />
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl">
          Outstanding ({outstanding?.length ?? 0})
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Sent but hasn&apos;t submitted the form yet.
        </p>
        {outstanding && outstanding.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {outstanding.map((inv) => (
              <li
                key={inv.id}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-neutral-100">
                      {inv.email}
                    </div>
                    {inv.personal_note && (
                      <p className="mt-0.5 truncate text-xs text-neutral-500">
                        &ldquo;{inv.personal_note}&rdquo;
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[11px] text-neutral-600">
                      sent {formatRelative(inv.sent_at)}
                      {" · "}
                      {isExpired(inv.expires_at)
                        ? "link expired"
                        : `expires ${formatRelative(inv.expires_at)}`}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-6 text-center text-sm text-neutral-500">
            No outstanding invites.
          </p>
        )}
      </section>

      {recentlyClaimed && recentlyClaimed.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-2xl">Recently claimed</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Filled out the intake form. Head to their review page to approve.
          </p>
          <ul className="mt-4 space-y-2">
            {recentlyClaimed.map((inv) => (
              <li
                key={inv.id}
                className="rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-neutral-100">
                      {inv.email}
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-neutral-600">
                      claimed{" "}
                      {inv.claimed_at && formatRelative(inv.claimed_at)}
                    </p>
                  </div>
                  {inv.claimed_vendor_id && (
                    <Link
                      href={`/dashboard/vendors/${inv.claimed_vendor_id}`}
                      className="shrink-0 rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-brand hover:text-brand"
                    >
                      Review →
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = d.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60000);
  const hours = Math.round(abs / (60 * 60000));
  const days = Math.round(abs / (24 * 60 * 60000));
  const future = diffMs > 0;
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;
  return future ? `in ${days}d` : `${days}d ago`;
}
