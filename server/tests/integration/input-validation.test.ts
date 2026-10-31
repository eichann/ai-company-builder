/**
 * Integration Test: Input validation (400).
 *
 * Endpoints must reject malformed or dangerous inputs
 * before processing them.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'

const TEST_USER = {
  id: 'user-owner-input',
  email: 'owner@example.com',
  name: 'Owner User',
  image: null,
  emailVerified: true,
}

const TEST_COMPANY_ID = 'company-input-test'

// Mock auth — authenticated as owner
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue({
    id: 'user-owner-input',
    email: 'owner@example.com',
    name: 'Owner User',
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
import { invitationsRoute } from '../../src/routes/invitations'
import { localRepoStore } from '../../src/adapters/git-repo-store'
import { companyRepoPath } from '../../src/lib/config'

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api', invitationsRoute)

function jsonReq(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return app.request(path, init)
}

/** The shared branch's commit and root entries: "unchanged" means this is equal. */
const mainState = () => {
  const repo = companyRepoPath(TEST_COMPANY_ID)
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'main']).toString().trim()
  const root = execFileSync('git', ['-C', repo, 'ls-tree', '--name-only', 'main']).toString()
  return `${commit}\n${root}`
}

beforeAll(async () => {
  initDatabase()

  const timestamp = new Date().toISOString()

  // Create test company with owner membership
  db.prepare(`
    INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(TEST_COMPANY_ID, 'Input Test Co', 'input-test-co', TEST_USER.id, timestamp, timestamp)

  db.prepare(`
    INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at)
    VALUES (?, ?, ?, 'owner', ?, ?)
  `).run('m-owner', TEST_USER.id, TEST_COMPANY_ID, timestamp, timestamp)

  // A real company repository with one department folder, so a request that
  // got past the name check would reach git (and answer something else than 400).
  const store = localRepoStore()
  await store.seedCompanyRepo(TEST_COMPANY_ID, await store.createCompanyRepo(TEST_COMPANY_ID), ['rename-test'])
  db.prepare(`
    INSERT INTO departments (id, company_id, name, folder, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?)
  `).run('dept-rename-test', TEST_COMPANY_ID, 'Rename Test', 'rename-test', timestamp, timestamp)
}, 120_000)

describe('Input validation (400) — malformed inputs', () => {
  // --- Company creation ---
  describe('POST /api/companies', () => {
    // Creating a company is for server operators; the body is checked after that.
    beforeAll(() => { process.env.OPERATOR_USER_IDS = 'user-owner-input' })
    afterAll(() => { delete process.env.OPERATOR_USER_IDS })

    it('empty name → 400', async () => {
      const res = await jsonReq('POST', '/api/companies', { name: '' })
      expect(res.status).toBe(400)
    })

    it('missing name → 400', async () => {
      const res = await jsonReq('POST', '/api/companies', {})
      expect(res.status).toBe(400)
    })

    it('name is number → 400', async () => {
      const res = await jsonReq('POST', '/api/companies', { name: 12345 })
      expect(res.status).toBe(400)
    })

    it('whitespace-only name → 400', async () => {
      const res = await jsonReq('POST', '/api/companies', { name: '   ' })
      expect(res.status).toBe(400)
    })
  })

  // --- Department creation ---
  describe('POST /api/companies/:id/departments', () => {
    const base = `/api/companies/${TEST_COMPANY_ID}/departments`

    it('missing name → 400', async () => {
      const res = await jsonReq('POST', base, { folder: 'test' })
      expect(res.status).toBe(400)
    })

    it('missing folder → 400', async () => {
      const res = await jsonReq('POST', base, { name: 'Test' })
      expect(res.status).toBe(400)
    })

    it('folder with path traversal "../" → 400, the shared branch unchanged', async () => {
      const before = mainState()
      const res = await jsonReq('POST', base, { name: 'Evil', folder: '../etc' })
      expect(res.status).toBe(400)
      expect(mainState()).toBe(before)
    })
  })

  // --- Department update (folder rename) ---
  describe('PUT /api/companies/:id/departments/:id', () => {
    const base = `/api/companies/${TEST_COMPANY_ID}/departments`

    // The rename's own name check (services/departments.ts update): the
    // characters themselves are covered by the name rule's tests; this pins
    // that the endpoint refuses before touching the repository.
    it('renaming to an invalid folder name → exactly 400, the shared branch and the department unchanged', async () => {
      const before = mainState()
      for (const folder of ['../etc', 'a/b', '.hidden', '-rf', 'x;rm -rf ~']) {
        const res = await jsonReq('PUT', `${base}/dept-rename-test`, { folder })
        expect(res.status, folder).toBe(400)
      }
      expect(mainState()).toBe(before)
      expect((db.prepare('SELECT folder FROM departments WHERE id = ?').get('dept-rename-test') as { folder: string }).folder).toBe('rename-test')
    })
  })

  // --- Invitation creation ---
  describe('POST /api/companies/:id/invitations', () => {
    it('invalid role → 400', async () => {
      const res = await jsonReq('POST', `/api/companies/${TEST_COMPANY_ID}/invitations`, {
        role: 'superadmin',
      })
      expect(res.status).toBe(400)
    })
  })

  // --- Company member addition ---
  describe('POST /api/companies/:id/members', () => {
    it('missing userId → 400', async () => {
      const res = await jsonReq('POST', `/api/companies/${TEST_COMPANY_ID}/members`, {
        role: 'member',
      })
      expect(res.status).toBe(400)
    })

    it('invalid role → 400', async () => {
      const res = await jsonReq('POST', `/api/companies/${TEST_COMPANY_ID}/members`, {
        userId: 'u1', role: 'superadmin',
      })
      expect(res.status).toBe(400)
    })
  })
})
