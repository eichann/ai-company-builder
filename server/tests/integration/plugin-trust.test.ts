/**
 * Integration Test: handing each company its signed plugin trust documents (`.claude/rules/
 * plugin-trust.md` "P2") on the real services: `GET /api/companies/:companyId/plugin-trust`'s
 * service (`pluginTrust.documentsFor`, given the member the route's guard found) and the agent
 * policy's `pluginTrust` marker. Who reaches the route (members only; another company's member
 * 404): the permission matrix row.
 *
 * - A member of c1 gets c1's list and freshness, never c2's, and c2's member never c1's — also
 *   when c2 has no list (then nothing, not a neighbour's).
 * - The files are read again on every call (the operator's install swaps them): a new freshness
 *   document changes the marker, so it reaches the apps at their next policy refresh.
 * - No `trust/` = no marker (an app then changes nothing) and an empty answer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SignedEnvelope } from '../../../shared/core/plugin-trust-documents'
import { makeTempDir } from '../../shared/testing/temp-dirs'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const DOCS = JSON.parse(readFileSync(join(__dirname, '../../../client/tests/fixtures/plugin-trust/documents.json'), 'utf8')) as Record<string, SignedEnvelope>
const text = (name: string) => JSON.stringify(DOCS[name])
const NOW = Date.parse('2026-11-21T12:00:00Z')
const ts = () => new Date().toISOString()
const c1Member = { companyId: 'c1', userId: 'pt-c1-member', role: 'member' }
const c2Member = { companyId: 'c2', userId: 'pt-c2-member', role: 'member' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let services: any, servicesWithout: any
let shelf: string
const previousUrl = process.env.PUBLIC_URL

beforeAll(async () => {
  process.env.PUBLIC_URL = 'https://acb.example/'
  shelf = makeTempDir('acb-pt-shelf-')
  const trust = join(shelf, 'trust')
  for (const sub of ['root', 'targets', 'freshness']) mkdirSync(join(trust, sub), { recursive: true })
  writeFileSync(join(trust, 'root', '1.json'), text('root-v1'))
  writeFileSync(join(trust, 'targets', 'company-c1.json'), text('t-c1-v5'))
  writeFileSync(join(trust, 'freshness', 'company-c1.json'), text('f-c1-v5'))
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  const db = dbModule.db
  for (const co of ['c1', 'c2']) db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'x', ts(), ts())
  for (const m of [c1Member, c2Member]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${m.userId}`, m.userId, m.companyId, m.role, ts(), ts())
  }
  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { pluginsDir: shelf, pluginTrustNow: () => NOW })
  servicesWithout = createServices(db, undefined, { pluginsDir: null, pluginTrustNow: () => NOW })
})

afterAll(() => {
  rmSync(shelf, { recursive: true, force: true })
  if (previousUrl === undefined) delete process.env.PUBLIC_URL
  else process.env.PUBLIC_URL = previousUrl
})

const documents = async (s: typeof services, m: typeof c1Member) => {
  const r = await s.pluginTrust.documentsFor(m)
  expect(r.ok).toBe(true)
  return r.value
}

describe('each company gets its own signed documents', () => {
  it('a member of c1 gets the chain, c1\'s list and its freshness', async () => {
    expect(await documents(services, c1Member)).toEqual({ roots: [DOCS['root-v1']], targets: DOCS['t-c1-v5'], freshness: DOCS['f-c1-v5'] })
  })

  it('c2 (no list of its own) gets the chain only — never c1\'s; with c2\'s list, only c2\'s', async () => {
    expect(await documents(services, c2Member)).toEqual({ roots: [DOCS['root-v1']], targets: null, freshness: null })
    writeFileSync(join(shelf, 'trust', 'targets', 'company-c2.json'), text('t-c2-v5'))
    expect(await documents(services, c2Member)).toEqual({ roots: [DOCS['root-v1']], targets: DOCS['t-c2-v5'], freshness: null })
    expect((await documents(services, c1Member)).targets).toEqual(DOCS['t-c1-v5'])
    rmSync(join(shelf, 'trust', 'targets', 'company-c2.json'))
  })

  it('the policy carries a marker per company that changes when the files change (read again on every call)', async () => {
    const before = (await services.agentPolicy.policyFor(c1Member)).pluginTrust
    expect(before).toMatch(/^[0-9a-f]{32}$/)
    expect((await services.agentPolicy.policyFor(c2Member)).pluginTrust).not.toBe(before)
    writeFileSync(join(shelf, 'trust', 'freshness', 'company-c1.json'), '{ broken')
    const after = await services.agentPolicy.policyFor(c1Member)
    expect(after.pluginTrust).not.toBe(before)
    expect((await documents(services, c1Member)).freshness).toBeNull()
    writeFileSync(join(shelf, 'trust', 'freshness', 'company-c1.json'), text('f-c1-v5'))
    expect((await services.agentPolicy.policyFor(c1Member)).pluginTrust).toBe(before)
  })

  it('no trust/ folder: no marker in the policy and an empty answer', async () => {
    expect((await servicesWithout.agentPolicy.policyFor(c1Member)).pluginTrust).toBeUndefined()
    expect(await documents(servicesWithout, c1Member)).toEqual({ roots: [], targets: null, freshness: null })
  })
})
