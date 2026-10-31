/**
 * End-to-end: typed operations against the fake HubSpot (milestone 3 P6,
 * `.claude/rules/plugins.md` "Typed operations"), the way staging runs it —
 * the server's own routes and services, the fake HubSpot listening on
 * 127.0.0.1 behind the practice redirect, a session for people and a record
 * token for their AI.
 *
 * Guards (each mutation-checked):
 * - the AI writes only what its owner may, gives a reason for a decision, and
 *   cannot undo; Codex's read token cannot write;
 * - a request with a prior / off field (stage included) writes nothing at all;
 * - a change already made in HubSpot is brought in and the request refused;
 * - 「変更前の値を書き戻す」 writes the stored raw value (not re-read through a
 *   changed mapping), and only while HubSpot still holds what ACB wrote;
 * - a lost answer is never re-sent; seeing the intended value makes it
 *   `observed`, never undoable; reading back works while the plugin is off;
 * - every stop acts on the next call; someone who cannot read the record
 *   gets the same 404 as for a missing one; notices carry no content.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeHubSpot, type FakeHubSpot } from '../fakes/hubspot/fake-hubspot'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const KEY = 'pat-fake-NOT-REAL-operations-0123456789'
const CO = 'op-co'
const ts = () => new Date().toISOString()
const MAPPING = `
deal:
  visible_to_folder: 営業部
  import:
    pipelines: [default]
  fields:
    title:      { from: dealname, write: false }
    stage:      { from: dealstage, write: false, values: { appointmentscheduled: first_meeting, qualifiedtobuy: proposal, presentationscheduled: quote, decisionmakerboughtin: final } }
    confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, low: c } }
    next_step:  { from: hs_next_step, write: true }
    amount:     { from: amount, write: true }
    assignee:   { from: hubspot_owner_id, write: false, people: owners }
people:
  owners:
    "75123001": op-member
    "75123002": op-other
`
const ACK = ['confidence', 'next_step']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let fake: FakeHubSpot
let server: ServerType
let kekDir: string, shelfDir: string
const owner = { companyId: CO, userId: 'op-owner', role: 'owner' }

async function call(opts: { user?: string; token?: string; method: string; path: string; body?: unknown }) {
  currentUser.id = opts.user ?? null
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res: Response = await app.request(opts.path, { method: opts.method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) as Json }
}
const P = `/api/companies/${CO}/plugins/sample-hub`
const person = (user: string, method: string, path: string, body?: unknown) => call({ user, method, path: `${P}${path}`, body })
const ai = (token: string, method: string, path: string, body?: unknown) => call({ token, method, path: `/api/records-ai/plugins/sample-hub${path}`, body })

async function tokenFor(user: string, agent = 'claude-code'): Promise<string> {
  const r = await call({ user, method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: 'conv-op', agent, scope: 'act' } })
  if (r.status !== 201) throw new Error(JSON.stringify(r.body))
  return r.body.data.token
}
const recordOf = (externalId: string) => (db.prepare("SELECT record_id FROM plugin_external_links WHERE company_id = ? AND external_id = ? AND object = 'deal'").get(CO, externalId) as Json).record_id as string
const versionOf = (recordId: string) => (db.prepare('SELECT version FROM record_state WHERE company_id = ? AND record_id = ?').get(CO, recordId) as Json).version as number
const patches = () => fake.requests.filter(r => r.method === 'PATCH').length
const update = (recordId: string, fields: Record<string, unknown>, note = '商談で前向きな反応があったため（相談の 3 通目）') =>
  ({ expectedVersion: versionOf(recordId), fields, note })

beforeAll(async () => {
  fake = createFakeHubSpot()
  fake.addKey(KEY)
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = mkdtempSync(join(tmpdir(), 'acb-op-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = mkdtempSync(join(tmpdir(), 'acb-op-shelf-'))
  cpSync(join(__dirname, '../fixtures/plugins/sample-hub'), join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })
  // Staging's way: HubSpot's connections go to the fake on this machine (lib/config.ts).
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_HUBSPOT_URL: `http://127.0.0.1:${port}`,
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  app = new Hono()
  app.route('/api/companies/:companyId', (await import('../../src/routes/plugins')).pluginsRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/records')).recordsRoute)
  app.route('/api/records-ai', (await import('../../src/routes/records-ai')).recordsAiRoute)
  await services.pluginShelf.load()

  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'op-owner', ts(), ts())
  for (const [u, r] of [['op-owner', 'owner'], ['op-member', 'member'], ['op-other', 'member'], ['op-reader', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('op-s-sales', ?, '営業部', 'folder', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, 'op-r1', 'op-s-sales', 'everyone', NULL, 0, 0, ?)`).run(CO, ts())
  for (const [id, u] of [['op-r2', 'op-member'], ['op-r3', 'op-other']]) {
    db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'op-s-sales', 'user', ?, 1, 1, ?)`).run(CO, id, u, ts())
  }
  db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(CO, ts(), 'op-owner')
  const audience = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }
  const key = (await services.keyBroker.create(owner, { service: 'hubspot', displayName: 'HubSpot', secret: KEY, audience })).value.keys[0].id
  expect((await services.plugins.install(owner, 'sample-hub', { version: '0.1.0', keyId: key })).ok).toBe(true)
  expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING, acknowledgeAuto: ACK })).ok).toBe(true)
  expect((await services.plugins.setReadScope(owner, 'sample-hub', { userIds: ['op-member'] })).ok).toBe(true)
  expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  expect((await person('op-owner', 'POST', '/import')).status).toBe(200)
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(() => r(null)))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_HUBSPOT_URL']) delete process.env[k]
})

describe('the AI updates a deal, a person writes the previous value back', () => {
  it('the AI\'s tools come from the running plugin: Claude gets the update with its writable fields, Codex reads only (P7)', async () => {
    const claude = await call({ token: await tokenFor('op-member'), method: 'GET', path: '/api/records-ai/plugins' })
    expect(claude.status).toBe(200)
    const [hub] = claude.body.data.plugins
    expect(hub).toMatchObject({ id: 'sample-hub', label: expect.any(String) })
    const update = hub.operations.find((o: Json) => o.name === 'update_deal')
    expect(update).toMatchObject({ kind: 'update', recordType: 'deal', decision: true })
    // Written fields with their policy; stage (never written) and fields the mapping does not write are not offered.
    expect(update.fields.map((f: Json) => [f.name, f.policy]).sort()).toEqual([['amount', 'prior'], ['confidence', 'auto'], ['next_step', 'auto']])
    expect(update.fields.find((f: Json) => f.name === 'confidence').options).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    // How the options are shown (the type's option_labels), so the AI says 「A（高）」 rather than `a`.
    expect(update.fields.find((f: Json) => f.name === 'confidence').optionLabels).toEqual({ a: 'A（高）', b: 'B（中）', c: 'C（低）' })
    // No create (notes are not in milestone 3).
    expect(hub.operations.map((o: Json) => o.name).sort()).toEqual(['refresh_deal', 'update_deal'])

    const codex = await call({ user: 'op-member', method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: 'c', agent: 'codex', scope: 'act' } })
    const read = await call({ token: codex.body.data.token, method: 'GET', path: '/api/records-ai/plugins' })
    expect(read.body.data.plugins[0].operations.map((o: Json) => o.name)).toEqual(['refresh_deal'])

    // Turned off: no tools from the next turn.
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: false })).ok).toBe(true)
    expect((await call({ token: await tokenFor('op-member'), method: 'GET', path: '/api/records-ai/plugins' })).body.data.plugins).toEqual([])
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  })

  it('the AI (its owner is the assignee) updates two auto fields; HubSpot, the record and the ledger follow', async () => {
    const notify = vi.spyOn(services.push, 'notify')
    const token = await tokenFor('op-member')
    const id = recordOf('1000000001')
    const r = await ai(token, 'POST', `/records/${id}/operations/update_deal`, update(id, { confidence: 'a', next_step: '11/7 デモ' }))
    expect(r.status).toBe(200)
    expect(r.body.data.operation).toMatchObject({ state: 'applied', undoable: true, undoLabel: '変更前の値を書き戻す' })
    expect(r.body.data.operation.undoNotice).toContain('元に戻りません')
    // What the chat's card shows (P7): each field before → after from the ledger, made by the AI.
    expect(r.body.data.operation).toMatchObject({
      actorKind: 'ai', recordTitle: expect.any(String),
      changes: [{ field: 'confidence', before: 'b', after: 'a' }, { field: 'next_step', before: '資料送付', after: '11/7 デモ' }],
      // The card shows the values by their labels.
      valueLabels: { confidence: { a: 'A（高）', b: 'B（中）', c: 'C（低）' } },
    })
    expect(fake.deal('1000000001')!.properties).toMatchObject({ juchu_kakudo: 'high', hs_next_step: '11/7 デモ' })
    const entry = services.recordEngine.history({ companyId: CO, userId: 'op-member', role: 'member' }, id).value.entries.at(-1)
    expect(entry).toMatchObject({
      action: 'sample-hub.update_deal', actorId: 'op-member', actorKind: 'ai', actorSource: 'claude-code', conversationId: 'conv-op',
      isDecision: true, note: '商談で前向きな反応があったため（相談の 3 通目）', decision: { reason: '商談で前向きな反応があったため（相談の 3 通目）' },
      changes: [{ field: 'confidence', before: 'b', after: 'a' }, { field: 'next_step', before: '資料送付', after: '11/7 デモ' }],
      receipt: { kind: 'written', operationId: r.body.data.operation.id, accountId: '90000001' },
    })
    // The notice names the assignee, and says only that something changed.
    expect(notify).toHaveBeenCalled()
    for (const [, users, signal] of notify.mock.calls) {
      expect(users).toEqual(['op-member'])
      expect(Object.keys(signal as object).sort()).toEqual(['kind', 'version'])
    }
    notify.mockRestore()

    // The AI cannot write the previous value back (people do); its owner can.
    expect((await ai(token, 'POST', `/operations/${r.body.data.operation.id}/undo`)).status).toBe(404)
    const before = patches()
    // The card's button: the person's session, with the consultation as informational provenance.
    const back = await person('op-member', 'POST', `/operations/${r.body.data.operation.id}/undo`, { conversationId: 'conv-card' })
    expect(back.status).toBe(200)
    expect(back.body.data.operation).toMatchObject({ actorKind: 'human', changes: [{ field: 'confidence', before: 'a', after: 'b' }, { field: 'next_step', before: '11/7 デモ', after: '資料送付' }] })
    expect(services.recordEngine.history({ companyId: CO, userId: 'op-member', role: 'member' }, id).value.entries.at(-1))
      .toMatchObject({ action: 'sample-hub.undo', actorKind: 'human', conversationId: 'conv-card' })
    expect(back.body.data.operation).toMatchObject({ operation: 'undo', state: 'applied', undoOf: r.body.data.operation.id, undoable: false })
    expect(patches()).toBe(before + 1)
    expect(fake.deal('1000000001')!.properties).toMatchObject({ juchu_kakudo: 'medium', hs_next_step: '資料送付' })
    const again = await person('op-member', 'POST', `/operations/${r.body.data.operation.id}/undo`)
    expect(again).toMatchObject({ status: 409, body: { code: 'NOT_UNDOABLE' } })
  })

  it('the AI must give its reason for a decision; nothing is sent without it', async () => {
    const token = await tokenFor('op-member')
    const id = recordOf('1000000001')
    const n = patches()
    const r = await ai(token, 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: 'x' }, '  '))
    expect(r).toMatchObject({ status: 400, body: { code: 'REASON_REQUIRED' } })
    // A person may leave it out.
    const p = await person('op-member', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '電話する' }, ''))
    expect(p.body.data.operation.state).toBe('applied')
    expect(patches()).toBe(n + 1)
  })

  it('a prior field, stage, or a mix with them writes nothing at all', async () => {
    const id = recordOf('1000000003')
    const n = patches()
    const mixed = await person('op-other', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '見積の再提出', amount: 2600000 }))
    expect(mixed).toMatchObject({ status: 409, body: { code: 'APPROVAL_REQUIRED', fields: ['amount'] } })
    const stage = await person('op-other', 'POST', `/records/${id}/operations/update_deal`, update(id, { stage: 'final' }))
    expect(stage).toMatchObject({ status: 400, body: { code: 'FIELD_NOT_WRITABLE', fields: ['stage'] } })
    expect(patches()).toBe(n)
    expect(fake.deal('1000000003')!.properties.hs_next_step).toBe('見積の最終確認')
  })

  it('only what its owner may do: not the assignee → refused; cannot read the record → the same 404 as a missing one', async () => {
    const id = recordOf('1000000003') // assignee: op-other
    const n = patches()
    const notMine = await ai(await tokenFor('op-member'), 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: 'x' }))
    expect(notMine).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } })
    const cannotRead = await ai(await tokenFor('op-reader'), 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: 'x' }))
    const missing = await ai(await tokenFor('op-reader'), 'POST', '/records/deal-0000000000000000/operations/update_deal', { expectedVersion: 1, fields: { next_step: 'x' }, note: 'x' })
    expect(cannotRead).toEqual(missing)
    expect(cannotRead.status).toBe(404)
    // Codex reads only.
    const codex = await call({ user: 'op-other', method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: 'c', agent: 'codex', scope: 'act' } })
    const codexToken = codex.body.data.token
    expect(await ai(codexToken, 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: 'x' }))).toMatchObject({ status: 403, body: { code: 'READ_ONLY_TOKEN' } })
    expect((await ai(codexToken, 'POST', `/records/${id}/operations/refresh_deal`, {})).status).toBe(200)
    expect(patches()).toBe(n)
  })
})

describe('HubSpot changed meanwhile', () => {
  it('changed before the write: brought in, the request refused, nothing sent', async () => {
    const id = recordOf('1000000005') // assignee 75123003: none; the owner (admin) may
    fake.changeDealOutside('1000000005', { juchu_kakudo: 'high' })
    const n = patches()
    const r = await person('op-owner', 'POST', `/records/${id}/operations/update_deal`, update(id, { confidence: 'c' }))
    expect(r).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT', current: { confidence: 'a' } } })
    expect(patches()).toBe(n)
    const last = services.recordEngine.history(owner, id).value.entries.at(-1)
    expect(last).toMatchObject({ actorKind: 'external', changes: [{ field: 'confidence', before: 'b', after: 'a' }] })
  })

  it('changed after the write: not written back', async () => {
    const id = recordOf('1000000005')
    const w = await person('op-owner', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: 'デモ日程の確定' }))
    expect(w.body.data.operation.state).toBe('applied')
    fake.changeDealOutside('1000000005', { hs_next_step: '上司が書き換えた' })
    const n = patches()
    const back = await person('op-owner', 'POST', `/operations/${w.body.data.operation.id}/undo`)
    expect(back).toMatchObject({ status: 409, body: { code: 'CHANGED_OUTSIDE', current: { next_step: '上司が書き換えた' } } })
    expect(patches()).toBe(n)
  })

  it('the previous value written back is the raw one stored with the operation, not the current mapping\'s reading', async () => {
    const id = recordOf('1000000010') // juchu_kakudo medium, assignee op-member
    const w = await person('op-member', 'POST', `/records/${id}/operations/update_deal`, update(id, { confidence: 'a' }))
    expect(fake.deal('1000000010')!.properties.juchu_kakudo).toBe('high')
    // The company now reads 確度 from another HubSpot property.
    const remapped = MAPPING.replace('confidence: { from: juchu_kakudo, write: true, values: { high: a, medium: b, low: c } }',
      'confidence: { from: hs_forecast_probability, write: true, values: { "0.8": a, "0.5": b, "0.2": c } }')
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: remapped, acknowledgeAuto: ['confidence'] })).ok).toBe(true)
    const forecastBefore = fake.deal('1000000010')!.properties.hs_forecast_probability ?? null
    const back = await person('op-member', 'POST', `/operations/${w.body.data.operation.id}/undo`)
    expect(back.status).toBe(200)
    expect(fake.deal('1000000010')!.properties.juchu_kakudo).toBe('medium')
    expect(fake.deal('1000000010')!.properties.hs_forecast_probability ?? null).toBe(forecastBefore)
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING, acknowledgeAuto: ['confidence'] })).ok).toBe(true)
  })

  it('a policy changed while the request waits stops it before the send', async () => {
    const id = recordOf('1000000006') // assignee 75123003: none; the owner may
    const n = patches()
    fake.faults.delayMs = 60
    const pending = person('op-owner', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '待っている間に止まる' }))
    await new Promise(r => setTimeout(r, 30))
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING.replace('hs_next_step, write: true', 'hs_next_step, write: false') })).ok).toBe(true)
    const r = await pending
    fake.faults.delayMs = 0
    expect(r.status).not.toBe(200)
    expect(patches()).toBe(n)
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING, acknowledgeAuto: ['next_step'] })).ok).toBe(true)
  })
})

describe('one write per outside object at a time', () => {
  it('two requests made on the same version: one is written, the other refused — HubSpot gets one PATCH', async () => {
    const id = recordOf('1000000007') // assignee op-member
    const n = patches()
    fake.faults.delayMs = 30
    const body = update(id, { next_step: '一つ目' })
    const [a, b] = await Promise.all([
      person('op-member', 'POST', `/records/${id}/operations/update_deal`, body),
      person('op-member', 'POST', `/records/${id}/operations/update_deal`, { ...body, fields: { next_step: '二つ目' } }),
    ])
    fake.faults.delayMs = 0
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(patches()).toBe(n + 1)
  })
})

describe('a lost answer', () => {
  it('is never re-sent; seeing the intended value makes it observed — not ACB\'s confirmed success, not undoable', async () => {
    const id = recordOf('1000000002') // assignee op-member
    fake.faults.dropAnswerAfterWrite(1)
    const n = patches()
    const r = await person('op-member', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '提案書を送る' }))
    expect(r.status).toBe(200)
    expect(r.body.data.operation).toMatchObject({ state: 'observed', reason: 'observed-actor-unknown', undoable: false })
    expect(fake.requests.filter(q => q.method === 'PATCH').length - n).toBeLessThanOrEqual(1)
    expect(fake.deal('1000000002')!.properties.hs_next_step).toBe('提案書を送る')
    // The record follows as an observed change (the outside system), not as the member's write.
    const last = services.recordEngine.history(owner, id).value.entries.at(-1)
    expect(last).toMatchObject({ actorKind: 'external', changes: [{ field: 'next_step', after: '提案書を送る' }] })
    expect(await person('op-member', 'POST', `/operations/${r.body.data.operation.id}/undo`)).toMatchObject({ status: 409, body: { code: 'NOT_UNDOABLE' } })
  })

  it('a 5xx stays unknown until read back; reading back works while the plugin is off, writing does not', async () => {
    const id = recordOf('1000000002')
    fake.faults.failNextWrite(1, 503)
    const r = await person('op-member', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '電話' }))
    expect(r.body.data.operation).toMatchObject({ state: 'sent-unknown', reason: 'not-observed' })
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: false })).ok).toBe(true)
    const again = await person('op-member', 'POST', `/operations/${r.body.data.operation.id}/reconcile`)
    expect(again).toMatchObject({ status: 200, body: { data: { operation: { state: 'sent-unknown' } } } })
    expect(await person('op-member', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '電話' })))
      .toMatchObject({ status: 409, body: { code: 'PLUGIN_NOT_ACTIVE', problem: 'off' } })
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
  })
})

describe('every stop acts on the next call', () => {
  const attempt = async () => {
    const id = recordOf('1000000002')
    return person('op-member', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: `試し ${Math.random()}` }))
  }

  it('the operator, the company, the key, the AI, the field, the records switch', async () => {
    const n = patches()
    writeFileSync(join(shelfDir, 'stopped'), 'sample-hub\n')
    expect(await attempt()).toMatchObject({ status: 409, body: { problem: 'stopped' } })
    rmSync(join(shelfDir, 'stopped'))

    const keyId = db.prepare('SELECT key_id FROM plugin_installs WHERE company_id = ?').get(CO).key_id
    await services.keyBroker.update(owner, keyId, { status: 'disabled' })
    expect(await attempt()).toMatchObject({ status: 409, body: { problem: 'key-stopped' } })
    await services.keyBroker.update(owner, keyId, { status: 'active' })

    const token = await tokenFor('op-member')
    services.agentStops.stop(owner, {})
    const id = recordOf('1000000002')
    expect((await ai(token, 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: 'x' }))).status).toBe(403)
    // The service itself refuses the AI too (not only the token's door), and still lets people work.
    const asAi = await services.pluginOperations.run({ companyId: CO, userId: 'op-member', role: 'member' }, { kind: 'ai', source: 'claude-code' }, 'sample-hub', id, 'update_deal', update(id, { next_step: 'x' }))
    expect(asAi).toMatchObject({ ok: false, body: { code: 'ACB_STOPPED' } })
    const stop = services.agentStops.get(owner).value.active[0].id
    services.agentStops.release(owner, stop)

    const off = MAPPING.replace('hs_next_step, write: true', 'hs_next_step, write: false')
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: off })).ok).toBe(true)
    expect(await attempt()).toMatchObject({ status: 400, body: { code: 'FIELD_NOT_WRITABLE' } })
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING })).ok).toBe(true)

    db.prepare('UPDATE record_settings SET enabled = 0 WHERE company_id = ?').run(CO)
    expect(await attempt()).toMatchObject({ status: 404, body: { code: 'RECORDS_DISABLED' } })
    db.prepare('UPDATE record_settings SET enabled = 1 WHERE company_id = ?').run(CO)

    expect(patches()).toBe(n)
    expect((await attempt()).body.data.operation.state).toBe('applied')
  })
})

describe('a new connection', () => {
  it('a change made on the old connection is never written back through the new one', async () => {
    const id = recordOf('1000000002')
    const w = await person('op-member', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '古い接続で書いた' }))
    expect(w.body.data.operation.state).toBe('applied')
    expect(services.pluginImport.renewConnection(owner, 'sample-hub').ok).toBe(true)
    const n = patches()
    expect(await person('op-member', 'POST', `/operations/${w.body.data.operation.id}/undo`)).toMatchObject({ status: 409, body: { code: 'ACCOUNT_CHANGED' } })
    expect(patches()).toBe(n)
  })
})
