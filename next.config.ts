import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No "Powered by Next.js" header: it only tells an attacker what to look up.
  poweredByHeader: false,
  // pg and the Prisma driver adapter are Node packages; keep them out of the server bundle.
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
};

export default nextConfig;
