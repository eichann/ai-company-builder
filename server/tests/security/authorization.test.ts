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

/** A 403 in the handler, or a check of services/access.ts that refuses with 403. */
const FORBIDDEN = /403|access\.fullAccessMember\(|requireFullAccess\(|requireOwner\(/

describe('Role-based authorization', () => {
  it('/api/git has no repository administration endpoints; repo info checks membership and returns no path', () => {
    const content = readFileSync(join(ROUTES_DIR, 'git.ts'), 'utf-8')
    const handlers = [...content.matchAll(/gitRoute\.(get|post|put|patch|delete)\('([^']+)'/g)].map(m => `${m[1]} ${m[2]}`)
    expect(handlers).toEqual(['get /repos/:companyId'])
    const body = content.slice(content.indexOf("gitRoute.get('/repos/:companyId'"))
    expect(body).toMatch(/FROM memberships WHERE user_id = \? AND company_id = \?/)
    expect(body).not.toMatch(/\bpath: repoPath\b|sshUrl,/)
  })

  it('department mutations must check owner/admin role', () => {
    const content = readFileSync(join(ROUTES_DIR, 'departments.ts'), 'utf-8')

    // POST (create), PUT (update), DELETE must check role
    const mutationMethods = [
      { method: 'post', pattern: "departmentsRoute.post('/'," },
      { method: 'put', pattern: "departmentsRoute.put('/:id'," },
      { method: 'delete', pattern: "departmentsRoute.delete('/:id'," },
      { method: 'post', pattern: "departmentsRoute.post('/reorder'," },
      { method: 'post', pattern: "departmentsRoute.post('/sync'," },
    ]

    for (const { method, pattern } of mutationMethods) {
      const idx = content.indexOf(pattern)
      expect(idx, `${method.toUpperCase()} handler must exist: ${pattern}`).toBeGreaterThan(-1)

      const handlerBody = content.slice(idx, idx + 1500)
      expect(
        handlerBody,
        `${pattern} must check the owner/admin role`
      ).toMatch(FORBIDDEN)
    }
  })

  it('company member management must check owner/admin role', () => {
    const content = readFileSync(join(ROUTES_DIR, 'companies.ts'), 'utf-8')

    // POST /:id/members (invite) and DELETE /:id/members/:userId (remove) must check role
    const postMembers = content.indexOf("companiesRoute.post('/:id/members'")
    const deleteMembers = content.indexOf("companiesRoute.delete('/:id/members/:userId'")

    expect(postMembers).toBeGreaterThan(-1)
    expect(deleteMembers).toBeGreaterThan(-1)

    const postBody = content.slice(postMembers, postMembers + 1500)
    const deleteBody = content.slice(deleteMembers, deleteMembers + 1500)

    // Both must check for owner/admin
    expect(postBody).toMatch(/owner.*admin|admin.*owner/)
    expect(deleteBody).toMatch(/owner.*admin|admin.*owner/)

    // Both must answer 403: directly, or through the access policy's
    // 403 checks (services/access.ts, covered in tests/unit/access-policy.test.ts)
    expect(postBody).toMatch(FORBIDDEN)
    expect(deleteBody).toMatch(FORBIDDEN)
  })

  it('invitation management must check owner/admin role', () => {
    const content = readFileSync(join(ROUTES_DIR, 'invitations.ts'), 'utf-8')

    // List, create, and delete invitations must check role
    const handlers = [
      "invitationsRoute.get('/companies/:companyId/invitations'",
      "invitationsRoute.post('/companies/:companyId/invitations'",
      "invitationsRoute.delete('/companies/:companyId/invitations/:invitationId'",
    ]

    for (const handler of handlers) {
      const idx = content.indexOf(handler)
      expect(idx, `Handler must exist: ${handler}`).toBeGreaterThan(-1)

      const body = content.slice(idx, idx + 1500)
      expect(body, `${handler} must check owner/admin role`).toMatch(/owner.*admin|admin.*owner/)
      expect(body, `${handler} must return 403 for unauthorized`).toMatch(FORBIDDEN)
    }
  })

  it('git-http must verify company membership', () => {
    const content = readFileSync(join(ROUTES_DIR, 'git-http.ts'), 'utf-8')

    // Must have authorizeForCompany function
    expect(content).toMatch(/authorizeForCompany/)
    // Must check memberships table
    expect(content).toMatch(/memberships/)
    // Must return 403 for non-members
    expect(content).toMatch(/Forbidden.*403|403.*Forbidden/)
  })
})
