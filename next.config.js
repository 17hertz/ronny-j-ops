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

module.exports = nextConfig;
