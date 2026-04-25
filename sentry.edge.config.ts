/**
 * Sentry config for Edge runtime (middleware + edge API routes). We
 * don't have many of these today but Sentry's wizard sets up all three
 * runtimes by default and we keep the file for completeness — plus
 * it's where errors in /middleware.ts would surface.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.VERCEL_ENV ?? "development",
  });
}
