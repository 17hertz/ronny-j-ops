/**
 * Next.js instrumentation hook — runs once per worker start.
 *
 * We use it to bootstrap Sentry's server / edge SDKs. Next loads the
 * matching config file based on the runtime. See
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Sentry will hook this automatically to capture React Server Component
 * errors. Exported from @sentry/nextjs.
 */
export { captureRequestError as onRequestError } from "@sentry/nextjs";
