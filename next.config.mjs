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
  // Old staff paths, still in emails and alerts already sent, open the shared Details pages. The query string comes
  // along; the browser keeps the #section.
  async redirects() {
    return [
      { source: "/coordinate/details", destination: "/jobs", permanent: false },
      { source: "/coordinate/details/new", destination: "/jobs/new", permanent: false },
      { source: "/coordinate/details/:id", destination: "/jobs/:id?tab=manage", permanent: false },
    ];
  },
  // On every response: no other site may frame the app (one-click actions would be open to clickjacking), no
  // content sniffing, and only the origin (never the full URL) in the Referer to other sites. Map tile servers require
  // that origin, so the Referer is not dropped altogether. HSTS comes from Caddy's HTTPS site only,
  // since a LAN install serves plain HTTP.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
