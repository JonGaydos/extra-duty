// Plain JavaScript (not next.config.ts) so the production image needs no TypeScript to start.
/** @type {import("next").NextConfig} */
const nextConfig = {
  // The e2e server builds into its own folder so it never replaces a running preview's build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Loaded from node_modules at runtime instead of being bundled into server chunks.
  serverExternalPackages: ["pg-boss", "nodemailer", "@aws-sdk/client-sesv2"],
  experimental: {
    // forbidden(): System screens and actions answer coordinators with a real 403.
    authInterrupts: true,
  },
  // On every response: no other site may frame the app (one-click actions would be open to clickjacking), no
  // content sniffing, and no full URL in the Referer to other sites. HSTS comes from Caddy's HTTPS site only,
  // since a LAN install serves plain HTTP.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
