"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton({
  redirectTo = "/login",
}: {
  /**
   * Where to send the user after signing out. Defaults to the team login
   * page; pass `/vendors/login` when this button is used in the vendor
   * portal so they don't land on the wrong login screen.
   */
  redirectTo?: string;
} = {}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs uppercase tracking-wider text-neutral-400 transition hover:border-brand hover:text-brand disabled:opacity-50"
    >
      {busy ? "Signing out..." : "Sign out"}
    </button>
  );
}
