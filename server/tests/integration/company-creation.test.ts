/**
 * Integration Test: who may create a company (2026-10-31).
 *
 * Creating a company is for the server's operators (OPERATOR_USER_IDS,
 * lib/config.ts). The one exception is a fresh server: its first account
 * (sign-up needs an invitation after it, and an invitation needs a company)
 * creates the first company, as the self-hosting guide says. Before this any
 * signed-in account could create any number of companies.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'cc-first' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

vi.setConfig({ testTimeout: 60_000 })

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'

const app = new Hono()
app.route('/api/companies', companiesRoute)

async function create(user: string, name: string) {
  currentUser.id = user
  const res = await app.request('/api/companies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const companyCount = () => (db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n

beforeAll(() => {
  initDatabase()
})

afterEach(() => {
  delete process.env.OPERATOR_USER_IDS
})

describe('POST /api/companies', () => {
  it('on a fresh server the first account creates the first company; after that only operators create companies', async () => {
    expect(companyCount()).toBe(0)
    expect((await create('cc-first', 'First Co')).status).toBe(201)

    // The owner of a company is not thereby allowed to create more of them,
    // and neither is anyone else signed in.
    for (const user of ['cc-first', 'cc-someone']) {
      const refused = await create(user, 'Another Co')
      expect(refused.status, user).toBe(403)
      expect(refused.body.code).toBe('COMPANY_CREATION_RESTRICTED')
    }
    expect(companyCount()).toBe(1)

    process.env.OPERATOR_USER_IDS = ' cc-other-op , cc-operator '
    const made = await create('cc-operator', 'Operated Co')
    expect(made.status).toBe(201)
    expect((made.body.data as { role: string }).role).toBe('owner')
    expect((await create('cc-someone', 'Still No')).status).toBe(403)
    expect(companyCount()).toBe(2)
  })
})
