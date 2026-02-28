/**
 * Integration Test: All protected endpoints must return 401 for unauthenticated requests.
 *
 * This test verifies that every API endpoint properly rejects requests
 * without valid authentication credentials.
 */
import { describe, it, expect, vi } from 'vitest'

// Mock auth module — all requests will appear unauthenticated
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { meRoute } from '../../src/routes/me'
import { companiesRoute } from '../../src/routes/companies'
import { departmentsRoute } from '../../src/routes/departments'
import { gitRoute } from '../../src/routes/git'
import { sshKeysRoute } from '../../src/routes/ssh-keys'
import { invitationsRoute } from '../../src/routes/invitations'

// Build test app with routes mounted (mirrors real app structure)
const app = new Hono()
app.route('/api/me', meRoute)
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/git', gitRoute)
app.route('/api/users/me/ssh-keys', sshKeysRoute)
app.route('/api', invitationsRoute)

// Helper to make JSON requests
function jsonReq(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return app.request(path, init)
}

describe('Auth rejection (401) — unauthenticated requests', () => {
  // --- /api/me ---
  describe('meRoute', () => {
    it('GET /api/me', async () => {
      const res = await jsonReq('GET', '/api/me')
      expect(res.status).toBe(401)
    })

    it('PATCH /api/me', async () => {
      const res = await jsonReq('PATCH', '/api/me', { name: 'Hacker' })
      expect(res.status).toBe(401)
    })
  })

  // --- /api/companies ---
  describe('companiesRoute', () => {
    it('GET /api/companies', async () => {
      const res = await jsonReq('GET', '/api/companies')
      expect(res.status).toBe(401)
    })

    it('GET /api/companies/:id', async () => {
      const res = await jsonReq('GET', '/api/companies/fake-id')
      expect(res.status).toBe(401)
    })

    it('POST /api/companies', async () => {
      const res = await jsonReq('POST', '/api/companies', { name: 'Evil Corp' })
      expect(res.status).toBe(401)
    })

    it('GET /api/companies/:id/members', async () => {
      const res = await jsonReq('GET', '/api/companies/fake-id/members')
      expect(res.status).toBe(401)
    })

    it('POST /api/companies/:id/members', async () => {
      const res = await jsonReq('POST', '/api/companies/fake-id/members', { userId: 'u1' })
      expect(res.status).toBe(401)
    })

    it('DELETE /api/companies/:id/members/:userId', async () => {
      const res = await jsonReq('DELETE', '/api/companies/fake-id/members/user1')
      expect(res.status).toBe(401)
    })
  })

  // --- /api/companies/:companyId/departments ---
  describe('departmentsRoute', () => {
    const base = '/api/companies/fake-id/departments'

    it('GET list', async () => {
      const res = await jsonReq('GET', base)
      expect(res.status).toBe(401)
    })

    it('GET single', async () => {
      const res = await jsonReq('GET', `${base}/dept-1`)
      expect(res.status).toBe(401)
    })

    it('POST create', async () => {
      const res = await jsonReq('POST', base, { name: 'Test', folder: 'test' })
      expect(res.status).toBe(401)
    })

    it('PUT update', async () => {
      const res = await jsonReq('PUT', `${base}/dept-1`, { name: 'Updated' })
      expect(res.status).toBe(401)
    })

    it('DELETE', async () => {
      const res = await jsonReq('DELETE', `${base}/dept-1`)
      expect(res.status).toBe(401)
    })

    it('GET stats', async () => {
      const res = await jsonReq('GET', `${base}/dept-1/stats`)
      expect(res.status).toBe(401)
    })

    it('POST reorder', async () => {
      const res = await jsonReq('POST', `${base}/reorder`, { items: [] })
      expect(res.status).toBe(401)
    })

    it('POST sync', async () => {
      const res = await jsonReq('POST', `${base}/sync`)
      expect(res.status).toBe(401)
    })
  })

  // --- /api/git ---
  describe('gitRoute', () => {
    it('GET /api/git/repos', async () => {
      const res = await jsonReq('GET', '/api/git/repos')
      expect(res.status).toBe(401)
    })

    it('POST /api/git/repos', async () => {
      const res = await jsonReq('POST', '/api/git/repos', { companyId: 'c1' })
      expect(res.status).toBe(401)
    })

    it('GET /api/git/repos/:companyId', async () => {
      const res = await jsonReq('GET', '/api/git/repos/fake-id')
      expect(res.status).toBe(401)
    })

    it('POST /api/git/hooks/install', async () => {
      const res = await jsonReq('POST', '/api/git/hooks/install')
      expect(res.status).toBe(401)
    })

    it('POST /api/git/repos/migrate-http', async () => {
      const res = await jsonReq('POST', '/api/git/repos/migrate-http')
      expect(res.status).toBe(401)
    })

    it('DELETE /api/git/repos/:companyId', async () => {
      const res = await jsonReq('DELETE', '/api/git/repos/fake-id')
      expect(res.status).toBe(401)
    })
  })

  // --- /api/users/me/ssh-keys ---
  describe('sshKeysRoute', () => {
    it('GET /api/users/me/ssh-keys', async () => {
      const res = await jsonReq('GET', '/api/users/me/ssh-keys')
      expect(res.status).toBe(401)
    })

    it('POST /api/users/me/ssh-keys', async () => {
      const res = await jsonReq('POST', '/api/users/me/ssh-keys', { publicKey: 'ssh-rsa AAAA' })
      expect(res.status).toBe(401)
    })

    it('DELETE /api/users/me/ssh-keys/:id', async () => {
      const res = await jsonReq('DELETE', '/api/users/me/ssh-keys/key-1')
      expect(res.status).toBe(401)
    })
  })

  // --- /api/invitations (protected endpoints) ---
  describe('invitationsRoute — protected', () => {
    it('GET /api/companies/:id/invitations', async () => {
      const res = await jsonReq('GET', '/api/companies/fake-id/invitations')
      expect(res.status).toBe(401)
    })

    it('POST /api/companies/:id/invitations', async () => {
      const res = await jsonReq('POST', '/api/companies/fake-id/invitations', { role: 'member' })
      expect(res.status).toBe(401)
    })

    it('DELETE /api/companies/:id/invitations/:invId', async () => {
      const res = await jsonReq('DELETE', '/api/companies/fake-id/invitations/inv-1')
      expect(res.status).toBe(401)
    })

    it('POST /api/invitations/:token/accept', async () => {
      const res = await jsonReq('POST', '/api/invitations/fake-token/accept')
      expect(res.status).toBe(401)
    })
  })

  // --- Public endpoints (should NOT require auth) ---
  describe('public endpoints — should NOT return 401', () => {
    it('GET /api/invitations/:token (validate invitation)', async () => {
      const res = await jsonReq('GET', '/api/invitations/some-token')
      // Should return 404 (token not found), not 401
      expect(res.status).not.toBe(401)
    })
  })
})
