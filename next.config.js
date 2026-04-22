/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Needed because the Inngest serve handler bundles these under the hood
    serverComponentsExternalPackages: ["twilio", "googleapis"],
  },
};

module.exports = nextConfig;
