/**
 * Security Test: Authorization checks (role-based access control)
 *
 * Destructive operations (DELETE, POST for mutations) must verify
 * the user's role (owner/admin) in addition to authentication.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROUTES_DIR = join(__dirname, '../../src/routes')

describe('Role-based authorization', () => {
  it('git-http must verify company membership', () => {
    const content = readFileSync(join(ROUTES_DIR, 'git-http.ts'), 'utf-8')

    // Must have authorizeForCompany function
    expect(content).toMatch(/authorizeForCompany/)
    // Must check the membership (the access policy reads the memberships table)
    expect(content).toMatch(/access\.memberOf\(companyId, userId\)/)
    // Must return 403 for non-members
    expect(content).toMatch(/Forbidden.*403|403.*Forbidden/)
  })
})
