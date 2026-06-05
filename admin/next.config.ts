import type { NextConfig } from "next";

// Proxy /api/* to the API server. In production a reverse proxy (Caddy)
// intercepts /api/* before it reaches the admin, but for local/dev (no
// reverse proxy) Next.js must proxy it itself. A rewrite is a transparent
// HTTP proxy, so auth Set-Cookie headers pass through intact — unlike a
// fetch-based route handler, which drops them.
// API_PROXY_URL must be reachable from the Next.js server process
// (e.g. http://api:3001 inside Docker, http://localhost:3001 for `pnpm dev`).
const apiProxyTarget = process.env.API_PROXY_URL || "http://localhost:3001";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` },
    ];
  },
};

export default nextConfig;
