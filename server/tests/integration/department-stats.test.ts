/**
 * Integration Test: a department folder git cannot count is an error, never
 * "empty" (code review 2026-11).
 *
 * GET /:id/stats answered "0 files, no folder" when git failed — the counts the
 * admin console shows right before deleting a department, so a full folder
 * looked empty. (The list's own failure: departments-list.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue({
    id: 'rf-owner', email: 'owner@example.com', name: 'Owner', image: null, emailVerified: true,
  }),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { departmentsRoute } from '../../src/routes/departments'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const REPOS_DIR = process.env.REPOS_DIR as string
const app = new Hono()
app.route('/api/companies/:companyId/departments', departmentsRoute)

const ts = () => new Date().toISOString()
const git = (args: string[], cwd?: string) => execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()

let scratch: string

function addCompany(id: string) {
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, id, id, 'rf-owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`m-${id}`, 'rf-owner', id, 'owner', ts(), ts())
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?)`).run(`d-${id}`, id, 'Sales', 'sales', ts(), ts())
}

beforeAll(() => {
  initDatabase()
  scratch = mkdtempSync(join(tmpdir(), 'acb-dept-fail-'))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('GET /departments/:id/stats', () => {
  it('does not report a folder git cannot read as empty before a deletion', async () => {
    addCompany('rf-broken')
    // The shared branch has sales/sub/a.txt; then sales/sub's tree object goes
    // missing, so counting the folder fails while the folder itself resolves.
    const bare = join(REPOS_DIR, 'rf-broken.git')
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    const work = join(scratch, 'work')
    git(['init', '-q', '--initial-branch=main', work])
    mkdirSync(join(work, 'sales', 'sub'), { recursive: true })
    writeFileSync(join(work, 'sales', 'sub', 'a.txt'), 'a')
    writeFileSync(join(work, 'sales', 'b.txt'), 'b')
    git(['add', '-A'], work)
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed'], work)
    git(['push', '-q', bare, 'HEAD:main'], work)
    const sub = git(['-C', bare, 'rev-parse', 'main:sales/sub']).trim()
    unlinkSync(join(bare, 'objects', sub.slice(0, 2), sub.slice(2)))

    const ok = await app.request('/api/companies/rf-broken/departments')
    expect(ok.status).toBe(200) // the root tree is intact: the list itself works

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.request('/api/companies/rf-broken/departments/d-rf-broken/stats')
      expect(res.status).toBe(500)
      const body = await res.json() as { data?: unknown; error?: string }
      expect(body.data).toBeUndefined()
      expect(body.error).toBe('Failed to read the department folder')
    } finally {
      errors.mockRestore()
    }
  })
})
