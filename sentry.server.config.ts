/**
 * Sentry config for Node.js server runtime (API routes, Server Components,
 * middleware when running on Node). Captures unhandled exceptions in
 * route handlers, Inngest function errors that bubble up, and any
 * `Sentry.captureException()` calls we make explicitly.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.VERCEL_ENV ?? "development",
    // Server-side we want FULL stack traces — no PII filter beyond
    // the shared beforeSend that redacts Authorization headers.
    beforeSend(event) {
      if (event.request?.headers?.authorization) {
        event.request.headers.authorization = "[redacted]";
      }
      return event;
    },
  });
}
