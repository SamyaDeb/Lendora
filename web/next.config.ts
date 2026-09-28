import type {NextConfig} from "next";
import {securityHeaders} from "./lib/csp";

/** Stockline web app (docs/prd/06). Security headers (lib/csp.ts) on every page; no third-party scripts. */
const config: NextConfig = {
  reactStrictMode: true,
  // scripts/liveStack.ts builds into its own directory so it never collides with e2e or `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  transpilePackages: ["@stockline/sdk"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env), // OFF-12: CSP + HSTS, plus the original four
      },
    ];
  },
};

export default config;
