import path from "path";
import type { NextConfig } from "next";

// /api/* is forwarded to the API server by src/proxy.ts (read at runtime),
// not by `rewrites()` here, which `next build` would freeze into the image.

const nextConfig: NextConfig = {
  // Self-contained server (.next/standalone) for the production image.
  output: "standalone",
  // Monorepo: trace dependencies from the workspace root so the standalone
  // output includes packages pnpm links from the root node_modules.
  outputFileTracingRoot: path.join(__dirname, ".."),
  poweredByHeader: false,
};

export default nextConfig;
