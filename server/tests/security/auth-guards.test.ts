/**
 * Security Test: Authentication guards on all API endpoints
 *
 * Every API endpoint (except explicitly public ones) must check
 * authentication before performing any action.
 * This test statically analyzes route files to ensure auth checks exist.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { readdirSync } from 'fs'

const ROUTES_DIR = join(__dirname, '../../src/routes')

// Route files that are allowed to have unauthenticated endpoints
const PUBLIC_ENDPOINT_EXCEPTIONS: Record<string, string[]> = {
  // invitations.ts: GET /invitations/:token is public (token validation)
  'invitations.ts': ['invitationsRoute.get(\'/invitations/:token\''],
}

// Route files where ALL endpoints are expected to be unauthenticated (stub/TODO)
const FULLY_PUBLIC_ROUTES = [
  'sync.ts', // TODO: Not yet implemented, all endpoints are stubs
  'permissions.ts', // Dead code: route unmounted from index.ts (C-2 fix), file pending deletion
]

function getRouteFiles(): { name: string; content: string }[] {
  return readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => ({
      name: f,
      content: readFileSync(join(ROUTES_DIR, f), 'utf-8'),
    }))
}

// Extract route handler blocks (e.g., `route.get('/path', async (c) => { ... })`)
interface RouteHandler {
  method: string
  path: string
  lineNumber: number
  hasAuthCheck: boolean
}

function extractRouteHandlers(content: string): RouteHandler[] {
  const handlers: RouteHandler[] = []
  const lines = content.split('\n')

  // Pattern: routeName.get|post|put|patch|delete('path', ...
  // Skip commented-out lines (// or /*)
  const routePattern = /(\w+)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart()
    // Skip commented-out lines
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue
    const match = line.match(routePattern)
    if (match) {
      const method = match[2].toUpperCase()
      const path = match[3]

      // Scan ahead in the handler body for auth check
      // Look for getUserFromRequest, authenticateGitRequest, or authAndAuthorize
      let braceDepth = 0
      let started = false
      let hasAuth = false

      for (let j = i; j < Math.min(i + 40, lines.length); j++) {
        const line = lines[j]

        if (line.includes('{')) {
          braceDepth += (line.match(/{/g) || []).length
          started = true
        }
        if (line.includes('}')) {
          braceDepth -= (line.match(/}/g) || []).length
        }

        if (/getUserFromRequest|authenticateGitRequest|authAndAuthorize/.test(line)) {
          hasAuth = true
          break
        }

        // Stop if we've exited the handler
        if (started && braceDepth <= 0) break
      }

      handlers.push({
        method,
        path,
        lineNumber: i + 1,
        hasAuthCheck: hasAuth,
      })
    }
  }

  return handlers
}

describe('Authentication guards', () => {
  it('all route files with endpoints must import an auth function', () => {
    const violations: string[] = []

    for (const { name, content } of getRouteFiles()) {
      if (FULLY_PUBLIC_ROUTES.includes(name)) continue

      // Check if file defines any route handlers
      const hasHandlers = /\.\s*(get|post|put|patch|delete)\s*\(/.test(content)
      if (!hasHandlers) continue

      const hasAuthImport =
        /getUserFromRequest/.test(content) ||
        /authenticateGitRequest/.test(content)

      if (!hasAuthImport) {
        violations.push(name)
      }
    }

    expect(
      violations,
      `These route files define endpoints but don't import any auth function: ${violations.join(', ')}`
    ).toEqual([])
  })

  it('every endpoint handler must call an auth check (except known public ones)', () => {
    const violations: string[] = []

    for (const { name, content } of getRouteFiles()) {
      if (FULLY_PUBLIC_ROUTES.includes(name)) continue

      const handlers = extractRouteHandlers(content)
      const exceptions = PUBLIC_ENDPOINT_EXCEPTIONS[name] || []

      for (const handler of handlers) {
        if (handler.hasAuthCheck) continue

        // Check if this is an allowed exception
        const isException = exceptions.some(exc => content.includes(exc))
        if (isException && handler.path.includes(':token')) continue

        violations.push(
          `${name}:${handler.lineNumber} — ${handler.method} ${handler.path} has no auth check`
        )
      }
    }

    expect(
      violations,
      `These endpoints are missing authentication checks:\n${violations.join('\n')}`
    ).toEqual([])
  })

  it('sync route must be documented as intentionally unauthenticated', () => {
    // sync.ts is currently a stub with no auth. This test ensures we
    // don't forget to add auth when we implement it.
    const syncContent = readFileSync(join(ROUTES_DIR, 'sync.ts'), 'utf-8')

    const hasAuthImport = /getUserFromRequest/.test(syncContent)
    const isTodo = /TODO/.test(syncContent)

    // Either it has auth, or it's still a TODO stub
    expect(
      hasAuthImport || isTodo,
      'sync.ts has endpoints without auth and no TODO marker — add auth or mark as TODO'
    ).toBe(true)
  })
})
