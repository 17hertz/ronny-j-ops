/**
 * Vendor account settings.
 *
 * Two things a vendor might want to change on their own:
 *   1. Their password (if they want password-based sign-in instead of
 *      magic-link / Google)
 *   2. Their sign-in email (rare, but inevitable — someone's personal
 *      Gmail changes, business email changes domain, etc.)
 *
 * What's intentionally NOT here:
 *   - Legal name, tax ID, ACH. Those are high-trust edits that need to go
 *     through the 17 Hertz team — we don't want a vendor silently changing
 *     the payment destination on a $50k invoice. If they ask for a bank
 *     update, we handle it over email.
 *
 * Password/email changes both go through Supabase Auth on the client side.
 * This page is a Server Component shell around a client form.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function VendorAccountSettingsPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/vendors/login");

  // Make sure this is actually a vendor (not a team member who wandered here).
  const { data: vendor } = (await supabase
    .from("vendors")
    .select("id, legal_name")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string; legal_name: string } | null };

  if (!vendor) {
    redirect("/dashboard");
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
          Settings
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight">
          Account settings
        </h1>
        <p className="mt-3 text-sm text-neutral-400">
          Change your password or sign-in email. Need to update your legal
          name, tax ID, or bank info?{" "}
          <a
            href="mailto:team@17hertz.io"
            className="underline hover:text-brand"
          >
            Email us
          </a>{" "}
          so we can verify the change.
        </p>
      </section>

      <section className="mt-10">
        <SettingsForm currentEmail={user.email ?? ""} />
      </section>
    </main>
  );
}
