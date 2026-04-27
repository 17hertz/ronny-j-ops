/**
 * Sentry client config (browser bundle).
 *
 * Replaces the older `sentry.client.config.ts` convention. Loaded
 * automatically by Next.js when the client-side bundle boots.
 *
 * No-op when NEXT_PUBLIC_SENTRY_DSN isn't set — local dev stays quiet,
 * preview deploys without the env var don't pollute the prod Sentry
 * project. Replace via env var in Vercel rather than hardcoding here.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    integrations: [Sentry.replayIntegration()],
    // 10% trace sample in prod — bump up if we want deeper perf data
    // and have free-tier headroom. tracesSampleRate=1 (full) is fine
    // for the first few weeks while traffic is low.
    tracesSampleRate: 0.1,
    // Replay on errors only (no full session replays, which use a lot
    // of free-tier quota). Lift if Jason wants visual debugging.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    sendDefaultPii: true,
    beforeSend(event) {
      // Strip Authorization headers if any leak into reports.
      if (event.request?.headers?.authorization) {
        event.request.headers.authorization = "[redacted]";
      }
      return event;
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
