/**
 * /dashboard/chat — the admin-only agent chat surface.
 *
 * Server Component shell around a client chat component. Gate:
 *   - must be signed in → else /login
 *   - must be a team_member → else /dashboard (which handles vendor redirect
 *     and the "not on team" page)
 *
 * The chat itself is all client-side state — no persistence yet. Refreshing
 * the tab wipes the conversation. That's a feature for v0.1: short sessions,
 * no long-term memory problems to debug.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatClient } from "./chat-client";

export const dynamic = "force-dynamic";

export default async function AgentChatPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: teamMember } = (await supabase
    .from("team_members")
    .select("id, full_name")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string; full_name: string } | null };

  if (!teamMember) redirect("/dashboard");

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col px-8 py-8">
      <header className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
        >
          ← Dashboard
        </Link>
        <span className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500">
          Ops agent · v0.1
        </span>
      </header>

      <section className="mt-6">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
          Chat
        </p>
        <h1 className="mt-1 font-display text-3xl leading-tight">
          Ask about vendors, invoices, sessions.
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Read-only + drafts only right now. Claude can search, summarize, and
          write proposed emails — but it can&apos;t approve, send, or move
          money. You do that.
        </p>
      </section>

      <ChatClient userName={teamMember.full_name} />
    </main>
  );
}
