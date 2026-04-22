/**
 * getCurrentVendor — shared helper for the logged-in vendor experience.
 *
 * Why this exists:
 *   Both the vendor account pages and the vendor API routes need the same
 *   question answered: "for the current auth user, what vendor row do they
 *   own?" Duplicating the query + maybe-null handling bred subtle bugs
 *   (some call sites forgot that team members signed into the vendor area
 *   have no vendor row — they'd crash on `.status`).
 *
 * Returns:
 *   - vendor=null, userEmail=null           → not signed in
 *   - vendor=null, userEmail=<email>        → signed in but not a vendor
 *                                             (e.g. a team member visiting)
 *   - vendor=<row>, userEmail=<email>       → normal vendor session
 *
 * What it does NOT do:
 *   - Does NOT redirect. Callers decide what to do based on the shape.
 *   - Does NOT enforce status === "approved". Pages that need that gate
 *     on it explicitly.
 *
 * Edge cases:
 *   - RLS "vendor self read" scopes the vendors query to the auth user's
 *     own row, so we don't bother filtering defensively beyond
 *     `auth_user_id = user.id`.
 */
import { createClient } from "@/lib/supabase/server";

type VendorRow = {
  id: string;
  legal_name: string;
  status: string;
  ach_account_last4: string | null;
};

export async function getCurrentVendor(): Promise<{
  vendor: VendorRow | null;
  userEmail: string | null;
}> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { vendor: null, userEmail: null };
  }

  const { data: vendor } = (await supabase
    .from("vendors")
    .select("id, legal_name, status, ach_account_last4")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: VendorRow | null };

  return {
    vendor: vendor ?? null,
    userEmail: user.email ?? null,
  };
}
