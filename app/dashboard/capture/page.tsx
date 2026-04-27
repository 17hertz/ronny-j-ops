/**
 * Dashboard capture page — drag/drop or paste an image, Claude figures
 * out what it is and routes it to the right place (task, event,
 * expense, or flags it for review).
 *
 * Shell + auth check is server-side; the actual upload + polling UI
 * is the client component below.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CaptureUploader } from "./capture-uploader";

export const dynamic = "force-dynamic";

export default async function CapturePage() {
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const { data: teamMember } = (await sb
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };
  if (!teamMember) redirect("/dashboard");

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
          Capture
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          Drop an image, I&apos;ll figure it out
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          Receipt, flyer, contract, screenshot of an email — Claude
          decides if it&apos;s a task, event, bill, or contact, and files
          it. Bills with sales tax become product expenses. Bills for
          services flag for vendor signup.
        </p>
      </section>

      <CaptureUploader />
    </main>
  );
}
