import { NextResponse, type NextRequest } from 'next/server'

// Forwards /api/* to the API server. In production Caddy routes /api/* to the
// API before it reaches the admin; without a reverse proxy (local dev, a bare
// `docker compose up`) the admin must forward it itself. An external rewrite
// is a transparent HTTP proxy, so the auth Set-Cookie headers pass through.
//
// This lives here rather than in next.config.ts `rewrites()` on purpose:
// rewrites are evaluated by `next build` and written into the build output,
// so a production image would keep whatever API_PROXY_URL was set (or not) at
// build time. Proxy runs per request, so the variable is read at runtime.
export function proxy(request: NextRequest) {
  const target = process.env.API_PROXY_URL || 'http://localhost:3001'
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, target)
  return NextResponse.rewrite(url)
}

export const config = {
  matcher: '/api/:path*',
}
