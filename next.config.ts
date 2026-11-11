import type { NextConfig } from "next";

// Sent with every response. No script-src: Next.js's inline bootstrap scripts would need a per-request nonce,
// which makes every page dynamic; the directives here don't affect scripts and are safe on every page.
const securityHeaders = [
  // Nobody may frame Tally (clickjacking on the sign-in and invoice pages); X-Frame-Options for old browsers.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Invoice URLs carry ids; don't send them to other sites.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Browsers ignore this over plain HTTP (local development) and honour it once served over HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // No "Powered by Next.js" header: it only tells an attacker what to look up.
  poweredByHeader: false,
  // pg and the Prisma driver adapter are Node packages; keep them out of the server bundle.
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
