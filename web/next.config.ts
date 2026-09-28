import type {NextConfig} from "next";

/** Stockline web app (docs/prd/06). Security headers on every page; no third-party scripts. */
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
        headers: [
          {key: "X-Content-Type-Options", value: "nosniff"},
          {key: "Referrer-Policy", value: "strict-origin-when-cross-origin"},
          {key: "X-Frame-Options", value: "DENY"},
          {key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()"},
        ],
      },
    ];
  },
};

export default config;
