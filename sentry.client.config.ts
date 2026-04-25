/**
 * Sentry config for the browser bundle.
 *
 * Loaded when the Next.js client-side JS boots. Captures unhandled
 * exceptions from React components, fetch errors, unhandled promise
 * rejections, and console.error output.
 *
 * No-op when SENTRY_DSN isn't set — keeps local dev quiet and makes
 * preview deploys not pollute the prod project's error feed.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Capture 10% of transactions in prod for performance monitoring.
    // Raise later if we want deeper perf insight; lower if we hit the
    // free-tier event cap.
    tracesSampleRate: 0.1,
    // Session replay on errors only (free tier handles the lightweight
    // volume). Disable if we don't want the extra payload.
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    // Redact URLs + headers that shouldn't leak into error reports.
    // This is a sensible default; expand as we notice secrets leaking
    // into captured payloads.
    beforeSend(event) {
      // Strip any Authorization header accidentally included.
      if (event.request?.headers?.authorization) {
        event.request.headers.authorization = "[redacted]";
      }
      return event;
    },
  });
}
