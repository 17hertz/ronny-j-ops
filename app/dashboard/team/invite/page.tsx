/**
 * Admin page: invite a new teammate (another admin).
 *
 * Option A — "all-or-nothing" access. Whoever you invite here gets the same
 * view of the dashboard you see. No per-table permissions; if you want
 * granular access later, that becomes Option B (team_member_permissions
 * table + per-panel checks).
 *
 * Two sections:
 *   - Form: email → POST /api/admin/team/invite
 *   - List of current teammates (with a "pending" flag for users who were
 *     invited but haven't signed in yet, so you can see who still needs to
 *     click their magic link).
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { InviteTeammateForm } from "./invite-form";

export const dynamic = "force-dynamic";

type TeamMemberRow = {
  id: string;
  auth_user_id: string | null;
  full_name: string | null;
  role: string | null;
  created_at: string | null;
};

export default async function InviteTeammatePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = (await supabase
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };
  if (!me) redirect("/dashboard");

  // List all team members so the admin can see who's on the team and
  // who's still pending acceptance. Loose cast pending real supabase types.
  const { data: teamMembers } = (await supabase
    .from("team_members")
    .select("id, auth_user_id, full_name, role, created_at")
    .order("created_at", { ascending: false })
    .limit(50)) as { data: TeamMemberRow[] | null };

  // Cross-reference with auth.users to figure out who's actually signed in
  // at least once (pending vs active). Only admin client can read auth.users.
  const admin = createAdminClient();
  let lastSignInByUserId = new Map<string, string | null>();
  let emailByUserId = new Map<string, string | null>();
  try {
    const { data: authList } = await admin.auth.admin.listUsers({
      perPage: 200,
    });
    if (authList?.users) {
      for (const u of authList.users) {
        lastSignInByUserId.set(u.id, u.last_sign_in_at ?? null);
        emailByUserId.set(u.id, u.email ?? null);
      }
    }
  } catch (err) {
    // Non-fatal — list still renders, we just don't know pending/active.
    console.error("[dashboard/team/invite] listUsers failed", err);
  }

  return (
    <main className="mx-auto max-w-3xl px-8 py-12">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
      </header>

      <section className="mt-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Team
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          Add a teammate
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          We&apos;ll email them a sign-in link. Once they click it, they can
          see everything you see on this dashboard — calendar, vendors,
          reminders, invoices, chat. All-or-nothing access for now; granular
          per-table permissions will come later.
        </p>
      </section>

      <section className="mt-8">
        <InviteTeammateForm />
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl">
          On the team ({teamMembers?.length ?? 0})
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Most recent first. &ldquo;Pending&rdquo; means they were invited but
          haven&apos;t clicked their magic link yet.
        </p>
        {teamMembers && teamMembers.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {teamMembers.map((m) => {
              const pending = m.auth_user_id
                ? !lastSignInByUserId.get(m.auth_user_id)
                : true;
              const email = m.auth_user_id
                ? emailByUserId.get(m.auth_user_id) ?? null
                : null;
              return (
                <li
                  key={m.id}
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-100">
                        {m.full_name || email || "Unnamed teammate"}
                      </div>
                      {email && m.full_name && (
                        <p className="mt-0.5 truncate text-xs text-neutral-500">
                          {email}
                        </p>
                      )}
                      <p className="mt-1 font-mono text-[11px] text-neutral-600">
                        {m.role || "member"}
                        {m.created_at && (
                          <>
                            {" · "}
                            joined {formatRelative(m.created_at)}
                          </>
                        )}
                      </p>
                    </div>
                    <span
                      className={
                        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider " +
                        (pending
                          ? "border-amber-500/40 text-amber-400"
                          : "border-emerald-500/40 text-emerald-400")
                      }
                    >
                      {pending ? "Pending" : "Active"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 rounded-md border border-neutral-800 bg-neutral-950 px-4 py-6 text-center text-sm text-neutral-500">
            No teammates yet.
          </p>
        )}
      </section>
    </main>
  );
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
