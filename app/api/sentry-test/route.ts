/**
 * GET /api/sentry-test
 *
 * Intentionally throws so we can verify Sentry is capturing server-side
 * errors end-to-end. Hit this once after wiring up SENTRY_DSN, confirm
 * the issue appears in sentry.io → Issues, then either leave this route
 * around for future smoke-tests or delete it.
 *
 * Auth: open. The thrown error doesn't reveal anything sensitive (it's
 * a deliberately silly message), and the audit it produces in Sentry is
 * the whole point. If you'd rather lock it down, add a `?secret=…`
 * gate using CRON_SECRET.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  // The throw fires inside a Next.js route handler, which is wrapped by
  // Sentry's auto-instrumentation (configured via instrumentation.ts).
  // The error gets captured + reported with full request context before
  // the framework converts it to a 500 response.
  throw new Error(
    "Sentry test error from /api/sentry-test — if you see this in Sentry, wiring is correct."
  );
}
