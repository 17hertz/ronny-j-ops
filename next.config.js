const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Packages that should NOT be webpack-bundled for the server. Reasons:
    //   - twilio, googleapis: Inngest serve handler's bundling chokes on them
    //   - pdfkit: ships .afm font files in its data/ folder that it reads
    //     from disk at runtime. Bundling detaches pdfkit's JS from its data/,
    //     so requires ENOENT on Helvetica.afm. Leaving it external lets
    //     pdfkit resolve the path relative to node_modules/pdfkit at runtime.
    serverComponentsExternalPackages: ["twilio", "googleapis", "pdfkit"],
  },
};

/**
 * Sentry wrapper. Only enabled when SENTRY_DSN is set so local dev and
 * preview deploys without the env var behave identically to the
 * un-wrapped config. When enabled, Sentry uploads source maps at build
 * time for nicer stack traces.
 *
 * Set these in Vercel (Production) when you're ready:
 *   SENTRY_DSN                 — from Sentry dashboard, project settings
 *   NEXT_PUBLIC_SENTRY_DSN     — same value; must be NEXT_PUBLIC_ for
 *                                the client bundle to read it
 *   SENTRY_AUTH_TOKEN          — for source-map uploads (optional but
 *                                recommended; create at sentry.io)
 *   SENTRY_ORG / SENTRY_PROJECT — for source-map uploads
 */
const sentryWebpackOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Silences the build-time noise unless there's an actual problem.
  silent: true,
  // Source map upload requires SENTRY_AUTH_TOKEN. Skipped when absent.
  widenClientFileUpload: true,
  // Hide source maps from the public browser bundle so we don't leak
  // original TS/source into the web. Sentry still has them for grouping.
  hideSourceMaps: true,
};

module.exports = process.env.SENTRY_DSN
  ? withSentryConfig(nextConfig, sentryWebpackOptions)
  : nextConfig;
