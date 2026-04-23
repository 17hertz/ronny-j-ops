/**
 * Reconnect-needed banner.
 *
 * Rendered at the top of the dashboard when one of the user's Google
 * accounts has `needs_reconnect=true` — i.e. the refresh token is
 * permanently dead and no amount of retrying will help. Non-disruptive
 * yellow banner (not red/error) because this is a remedyable state, not
 * a breakdown.
 *
 * Clicking "Reconnect" goes to /api/google/start, which kicks off the
 * OAuth flow. On successful return, the callback route clears the
 * needs_reconnect flag automatically and the banner disappears on next
 * page load.
 *
 * Server-rendered so the banner shows up on first paint without a
 * client-side flash — part of "invisible infrastructure" UX.
 */
import Link from "next/link";

export function ReconnectBanner({
  accounts,
}: {
  accounts: Array<{
    google_email: string;
    last_auth_error_at: string | null;
  }>;
}) {
  if (accounts.length === 0) return null;

  const plural = accounts.length > 1;
  const emails = accounts.map((a) => a.google_email).join(", ");

  return (
    <div
      role="status"
      className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-amber-900/60 bg-amber-950/30 px-5 py-4"
    >
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-amber-300">
          Action needed
        </p>
        <p className="mt-1 text-sm text-amber-100">
          {plural
            ? "Google needs to be reconnected for these accounts"
            : "Google needs to be reconnected"}
          : <span className="font-medium">{emails}</span>
        </p>
        <p className="mt-1 text-xs text-amber-200/70">
          Your tasks and calendar will queue locally until this is fixed — no
          data will be lost. Common causes: you revoked access, changed your
          Google password, or the refresh token expired from inactivity.
        </p>
      </div>
      <Link
        href="/api/google/start"
        className="shrink-0 self-center rounded-md border border-amber-700 bg-amber-950/60 px-4 py-2 font-mono text-xs uppercase tracking-wider text-amber-200 transition hover:border-amber-500 hover:text-amber-100"
      >
        Reconnect
      </Link>
    </div>
  );
}
