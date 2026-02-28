/**
 * Integration Test: Role-based authorization (403).
 *
 * Endpoints with role restrictions must reject users who lack
 * the required role (owner/admin).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

const TEST_USER = {
  id: 'user-member',
  email: 'member@example.com',
  name: 'Member User',
  image: null,
  emailVerified: true,
}

const TEST_COMPANY_ID = 'company-auth-test'

// Mock auth — authenticated as a regular member
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue({
    id: 'user-member',
    email: 'member@example.com',
    name: 'Member User',
    image: null,
    emailVerified: true,
  }),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { departmentsRoute } from '../../src/routes/departments'
import { gitRoute } from '../../src/routes/git'
import { invitationsRoute } from '../../src/routes/invitations'

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/git', gitRoute)
app.route('/api', invitationsRoute)

function jsonReq(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return app.request(path, init)
}

beforeAll(() => {
  initDatabase()

  const timestamp = new Date().toISOString()

  // Create test company
  db.prepare(`
    INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(TEST_COMPANY_ID, 'Test Company', 'test-company', 'user-owner', timestamp, timestamp)

  // Add test user as regular member (NOT owner/admin)
  db.prepare(`
    INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at)
    VALUES (?, ?, ?, 'member', ?, ?)
  `).run('m-1', TEST_USER.id, TEST_COMPANY_ID, timestamp, timestamp)

  // Create a test department for update/delete tests
  db.prepare(`
    INSERT INTO departments (id, company_id, name, folder, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?)
  `).run('dept-1', TEST_COMPANY_ID, 'Sales', 'sales', timestamp, timestamp)

  // Create a test invitation for delete tests
  db.prepare(`
    INSERT INTO invitations (id, company_id, token, role, created_by, expires_at, created_at)
    VALUES (?, ?, ?, 'member', ?, ?, ?)
  `).run('inv-1', TEST_COMPANY_ID, 'test-token-123', 'user-owner', '2099-01-01T00:00:00Z', timestamp)
})

describe('Authorization rejection (403) — member user without owner/admin role', () => {
  // --- Department mutations (owner/admin only) ---
  describe('department mutations', () => {
    const base = `/api/companies/${TEST_COMPANY_ID}/departments`

    it('POST create department → 403', async () => {
      const res = await jsonReq('POST', base, {
        name: 'Unauthorized Dept', folder: 'unauth',
      })
      expect(res.status).toBe(403)
    })

    it('PUT update department → 403', async () => {
      const res = await jsonReq('PUT', `${base}/dept-1`, { name: 'Updated' })
      expect(res.status).toBe(403)
    })

    it('DELETE department → 403', async () => {
      const res = await jsonReq('DELETE', `${base}/dept-1`)
      expect(res.status).toBe(403)
    })

    it('POST reorder departments → 403', async () => {
      const res = await jsonReq('POST', `${base}/reorder`, { items: [] })
      expect(res.status).toBe(403)
    })

    it('POST sync departments → 403', async () => {
      const res = await jsonReq('POST', `${base}/sync`)
      expect(res.status).toBe(403)
    })
  })

  // --- Company member management (owner/admin only) ---
  describe('company member management', () => {
    it('POST invite member → 403', async () => {
      const res = await jsonReq('POST', `/api/companies/${TEST_COMPANY_ID}/members`, {
        userId: 'new-user', role: 'member',
      })
      expect(res.status).toBe(403)
    })

    it('DELETE remove member → 403', async () => {
      const res = await jsonReq('DELETE', `/api/companies/${TEST_COMPANY_ID}/members/other-user`)
      expect(res.status).toBe(403)
    })
  })

  // --- Invitation management (owner/admin only) ---
  describe('invitation management', () => {
    it('GET list invitations → 403', async () => {
      const res = await jsonReq('GET', `/api/companies/${TEST_COMPANY_ID}/invitations`)
      expect(res.status).toBe(403)
    })

    it('POST create invitation → 403', async () => {
      const res = await jsonReq('POST', `/api/companies/${TEST_COMPANY_ID}/invitations`, {
        role: 'member',
      })
      expect(res.status).toBe(403)
    })

    it('DELETE invitation → 403', async () => {
      const res = await jsonReq('DELETE', `/api/companies/${TEST_COMPANY_ID}/invitations/inv-1`)
      expect(res.status).toBe(403)
    })
  })

  // --- Git repo deletion (owner only) ---
  describe('git repo deletion', () => {
    it('DELETE /api/git/repos/:companyId → 403 for member', async () => {
      const res = await jsonReq('DELETE', `/api/git/repos/${TEST_COMPANY_ID}`)
      expect(res.status).toBe(403)
    })
  })

  // --- Read endpoints should SUCCEED for members ---
  describe('read endpoints — should be accessible to members', () => {
    it('GET list departments → 200 (not 403)', async () => {
      const res = await jsonReq('GET', `/api/companies/${TEST_COMPANY_ID}/departments`)
      // May return 200 or 500 (if git working dir doesn't exist), but NOT 403
      expect(res.status).not.toBe(403)
    })

    it('GET single department → 200 (not 403)', async () => {
      const res = await jsonReq('GET', `/api/companies/${TEST_COMPANY_ID}/departments/dept-1`)
      expect(res.status).not.toBe(403)
    })

    it('GET company members → 200 (not 403)', async () => {
      const res = await jsonReq('GET', `/api/companies/${TEST_COMPANY_ID}/members`)
      expect(res.status).not.toBe(403)
    })
  })
})
