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
    stage:      { from: dealstage, write: true, values: { appointmentscheduled: first_meeting, qualifiedtobuy: proposal, presentationscheduled: quote, decisionmakerboughtin: final } }
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
    // Written fields with their policy (stage only with approval); fields the mapping does not write are not offered.
    expect(update.fields.map((f: Json) => [f.name, f.policy]).sort()).toEqual([['amount', 'prior'], ['confidence', 'auto'], ['next_step', 'auto'], ['stage', 'prior']])
    expect(update.fields.find((f: Json) => f.name === 'confidence').options).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    // How the options are shown (the type's option_labels), so the AI says 「A（高）」 rather than `a`.
    expect(update.fields.find((f: Json) => f.name === 'confidence').optionLabels).toEqual({ a: 'A（高）', b: 'B（中）', c: 'C（低）' })
    // Creates (milestone 4) with their policy: a meeting on the deal, a new deal (always approved).
    expect(hub.operations.map((o: Json) => o.name).sort()).toEqual(['add_note', 'create_deal', 'log_meeting', 'refresh_deal', 'update_deal'])
    expect(hub.operations.find((o: Json) => o.name === 'log_meeting')).toMatchObject({ kind: 'create', recordType: 'deal', policy: 'prior', content: ['title', 'body', 'at', 'outcome'] })
    const create = hub.operations.find((o: Json) => o.name === 'create_deal')
    expect(create).toMatchObject({ kind: 'create', recordType: 'deal', policy: 'prior', createsRecord: true })
    expect(create.fields.map((f: Json) => f.name).sort()).toEqual(['amount', 'confidence', 'next_step', 'stage'])

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

  it('a prior field, stage, or a mix with them writes nothing at all (an approval request is made instead; approvals.md)', async () => {
    const id = recordOf('1000000003')
    const n = patches()
    const mixed = await person('op-other', 'POST', `/records/${id}/operations/update_deal`, update(id, { next_step: '見積の再提出', amount: 2600000 }))
    expect(mixed).toMatchObject({ status: 202, body: { data: { outcome: 'approval-requested', approval: { state: 'pending' } } } })
    expect(mixed.body.data.approval.changes.map((c: Json) => c.field)).toEqual(['next_step', 'amount'])
    // Stage: written only after an approval (milestone 4), never directly.
    const stage = await person('op-other', 'POST', `/records/${id}/operations/update_deal`, update(id, { stage: 'final' }))
    expect(stage).toMatchObject({ status: 202, body: { data: { outcome: 'approval-requested', approval: { state: 'pending' } } } })
    const off = await person('op-other', 'POST', `/records/${id}/operations/update_deal`, update(id, { assignee: 'op-member' }))
    expect(off).toMatchObject({ status: 400, body: { code: 'FIELD_NOT_WRITABLE', fields: ['assignee'] } })
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

describe('creates (milestone 4): log_meeting on a deal', () => {
  const meetingPosts = () => fake.requests.filter(r => r.method === 'POST' && /\/meetings$/.test(r.path)).length
  const meetingSearches = () => fake.requests.filter(r => r.method === 'POST' && /\/meetings\/search$/.test(r.path)).length
  const meeting = (title: string) => ({ title, body: '先方は前向き。次回デモ。', at: '2026-11-05T15:00:00+09:00', outcome: 'COMPLETED' })
  const autoMeetings = `${MAPPING}policy:\n  log_meeting: auto\n`
  /** The company chose automatic meetings and confirmed no HubSpot workflow starts on them (each test stands alone). */
  const useAutoMeetings = async () => {
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: autoMeetings, acknowledgeAuto: [...ACK, 'log_meeting'] })).ok).toBe(true)
  }
  /** Pretend the create was sent long enough ago for search to see it (HubSpot's indexing delay). */
  const age = (operationId: string) => db.prepare('UPDATE plugin_operations SET created_at = ? WHERE company_id = ? AND id = ?')
    .run(new Date(Date.now() - 2 * 60_000).toISOString(), CO, operationId)

  it('approval by default: an approval request (202) and nothing sent', async () => {
    const id = recordOf('1000000001')
    const n = meetingPosts()
    const r = await ai(await tokenFor('op-member'), 'POST', `/records/${id}/operations/log_meeting`, meeting('初回商談'))
    expect(r).toMatchObject({ status: 202, body: { data: { outcome: 'approval-requested', approval: { state: 'pending' } } } })
    expect(meetingPosts()).toBe(n)
  })

  it('auto needs the acknowledgement: refused on save, and a mapping that has none stops the plugin', async () => {
    const save = await services.plugins.saveMapping(owner, 'sample-hub', { text: autoMeetings, acknowledgeAuto: ACK })
    expect(save).toMatchObject({ ok: false, body: { code: 'AUTO_NEEDS_ACKNOWLEDGEMENT', fields: ['log_meeting'] } })
    // A mapping version stored without one (e.g. restored by hand): the plugin does not run, nothing is sent.
    const version = (db.prepare('SELECT MAX(version) AS v FROM plugin_mappings WHERE company_id = ?').get(CO) as Json).v + 1
    db.prepare('INSERT INTO plugin_mappings (company_id, plugin_id, version, text, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'sample-hub', version, autoMeetings, ts(), 'op-owner')
    const before = (db.prepare('SELECT mapping_version FROM plugin_installs WHERE company_id = ?').get(CO) as Json).mapping_version
    db.prepare('UPDATE plugin_installs SET mapping_version = ? WHERE company_id = ?').run(version, CO)
    const id = recordOf('1000000001')
    const n = meetingPosts()
    const r = await person('op-member', 'POST', `/records/${id}/operations/log_meeting`, meeting('確かめていない'))
    expect(r).toMatchObject({ status: 409, body: { code: 'PLUGIN_NOT_ACTIVE', problem: 'auto-not-acknowledged' } })
    expect(meetingPosts()).toBe(n)
    db.prepare('UPDATE plugin_installs SET mapping_version = ? WHERE company_id = ?').run(before, CO)
  })

  it('auto (acknowledged): the AI logs a meeting — one object with ACB\'s correlation value, on the deal; a person archives it', async () => {
    await useAutoMeetings()
    const id = recordOf('1000000001')
    const token = await tokenFor('op-member')
    const other = await ai(token, 'POST', `/records/${id}/operations/log_meeting`, meeting('別の記録'))
    const r = await ai(token, 'POST', `/records/${id}/operations/log_meeting`, meeting('初回商談'))
    expect(r.status).toBe(200)
    const op = r.body.data.operation
    expect(op).toMatchObject({ kind: 'create', state: 'applied', undoable: true, undoLabel: '作ったものを取り消す', actorKind: 'ai', recordId: id,
      fields: { title: '初回商談', at: '2026-11-05T06:00:00.000Z', outcome: 'COMPLETED' } })
    const made = fake.withOperationId(op.id)
    expect(made).toEqual([{ type: 'meetings', id: expect.any(String), archived: false }])
    expect(fake.meeting(made[0].id)).toMatchObject({ dealIds: ['1000000001'], properties: { hs_meeting_title: '初回商談', hs_timestamp: String(Date.parse('2026-11-05T15:00:00+09:00')), acb_operation_id: op.id } })
    // The deal's ledger notes it (no field changes), with the receipt naming the meeting.
    const entry = services.recordEngine.history({ companyId: CO, userId: 'op-member', role: 'member' }, id).value.entries.at(-1)
    expect(entry).toMatchObject({ action: 'sample-hub.log_meeting', actorKind: 'ai', changes: [], receipt: { kind: 'written', object: 'meeting', externalId: made[0].id, operationId: op.id } })
    // The AI cannot archive it; its owner can — only that meeting.
    expect((await ai(token, 'POST', `/operations/${op.id}/undo`)).status).toBe(404)
    const back = await person('op-member', 'POST', `/operations/${op.id}/undo`)
    expect(back.body.data.operation).toMatchObject({ kind: 'undo', state: 'applied', undoOf: op.id })
    expect(fake.meeting(made[0].id)!.archived).toBe(true)
    expect(fake.meeting(fake.withOperationId(other.body.data.operation.id)[0].id)!.archived).toBe(false)
    expect(await person('op-member', 'POST', `/operations/${op.id}/undo`)).toMatchObject({ status: 409, body: { code: 'NOT_UNDOABLE' } })
  })

  it('a lost answer is never re-sent: one object, unknown; no search before 60 s; after, found by its correlation value', async () => {
    await useAutoMeetings()
    const id = recordOf('1000000001')
    const posts = meetingPosts()
    const searches = meetingSearches()
    fake.faults.dropAnswerAfterWrite(1)
    const r = await person('op-member', 'POST', `/records/${id}/operations/log_meeting`, meeting('答えが届かない'))
    expect(r.status).toBe(200)
    const op = r.body.data.operation
    expect(op).toMatchObject({ state: 'sent-unknown', reason: 'too-early', undoable: false, recreatable: false })
    expect(meetingPosts()).toBe(posts + 1)
    expect(fake.withOperationId(op.id)).toHaveLength(1)
    // Not yet: no search (HubSpot's search may not see it), still unknown; not undoable.
    expect((await person('op-member', 'POST', `/operations/${op.id}/reconcile`)).body.data.operation).toMatchObject({ state: 'sent-unknown', reason: 'too-early' })
    expect(meetingSearches()).toBe(searches)
    expect(await person('op-member', 'POST', `/operations/${op.id}/undo`)).toMatchObject({ status: 409, body: { code: 'NOT_UNDOABLE' } })
    age(op.id)
    const found = await person('op-member', 'POST', `/operations/${op.id}/reconcile`)
    expect(found.body.data.operation).toMatchObject({ state: 'applied', reason: 'found-by-correlation', undoable: true })
    expect(meetingSearches()).toBe(searches + 1)
    expect(meetingPosts()).toBe(posts + 1)
    expect(fake.withOperationId(op.id)).toHaveLength(1)
  })

  it('not found stays unknown (also while the plugin is off); 「もう一度作る」 only after that, with a warning, as a new operation', async () => {
    await useAutoMeetings()
    const id = recordOf('1000000001')
    fake.faults.failNextWrite(1, 503)
    const r = await person('op-member', 'POST', `/records/${id}/operations/log_meeting`, meeting('作れたか分からない'))
    const op = r.body.data.operation
    expect(op).toMatchObject({ state: 'sent-unknown', recreatable: false })
    expect(await person('op-member', 'POST', `/operations/${op.id}/recreate`, { confirm: true })).toMatchObject({ status: 409, body: { code: 'NOT_RECREATABLE' } })
    age(op.id)
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: false })).ok).toBe(true)
    const looked = await person('op-member', 'POST', `/operations/${op.id}/reconcile`)
    expect(looked).toMatchObject({ status: 200, body: { data: { operation: { state: 'sent-unknown', reason: 'not-found', recreatable: true } } } })
    expect((await services.plugins.setEnabled(owner, 'sample-hub', { enabled: true })).ok).toBe(true)
    const posts = meetingPosts()
    expect(await person('op-member', 'POST', `/operations/${op.id}/recreate`, {})).toMatchObject({ status: 409, body: { code: 'RECREATE_NEEDS_CONFIRMATION', warning: expect.stringContaining('二つになる') } })
    expect(meetingPosts()).toBe(posts)
    // Another member (not its actor, not an admin) may not.
    expect((await person('op-other', 'POST', `/operations/${op.id}/recreate`, { confirm: true })).status).toBe(403)
    const again = await person('op-member', 'POST', `/operations/${op.id}/recreate`, { confirm: true })
    expect(again.body.data.operation).toMatchObject({ kind: 'create', state: 'applied', actorKind: 'human' })
    expect(again.body.data.operation.id).not.toBe(op.id)
    expect(fake.withOperationId(op.id)).toHaveLength(0)
    expect(fake.withOperationId(again.body.data.operation.id)).toHaveLength(1)
    expect((await person('op-member', 'GET', `/operations/${op.id}`)).body.data.operation).toMatchObject({ replacedBy: again.body.data.operation.id, recreatable: false })
    expect(await person('op-member', 'POST', `/operations/${op.id}/recreate`, { confirm: true })).toMatchObject({ status: 409, body: { code: 'NOT_RECREATABLE' } })
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING })).ok).toBe(true)
  })
})

describe('creates (milestone 4): create_deal only through an approval', () => {
  const dealPosts = () => fake.requests.filter(r => r.method === 'POST' && /\/deals$/.test(r.path)).length
  const NEW_DEAL = { title: 'AI 研修（例示製作所）', fields: { stage: 'proposal', amount: 1200000 } }

  it('never runs without approval: the person\'s route, the AI\'s, a read token, a forged policy', async () => {
    const n = dealPosts()
    expect(await person('op-member', 'POST', '/create/create_deal', NEW_DEAL)).toMatchObject({ status: 202, body: { data: { outcome: 'approval-requested', approval: { state: 'pending' } } } })
    expect(await ai(await tokenFor('op-member'), 'POST', '/create/create_deal', NEW_DEAL)).toMatchObject({ status: 202, body: { data: { outcome: 'approval-requested', approval: { state: 'pending' } } } })
    const codex = await call({ user: 'op-member', method: 'POST', path: `/api/companies/${CO}/me/record-tokens`, body: { conversationId: 'c', agent: 'codex', scope: 'act' } })
    expect(await ai(codex.body.data.token, 'POST', '/create/create_deal', NEW_DEAL)).toMatchObject({ status: 403, body: { code: 'READ_ONLY_TOKEN' } })
    // Someone who cannot read where the deal would go.
    expect((await person('op-reader', 'POST', '/create/create_deal', NEW_DEAL)).status).toBe(403)
    // A declaration and mapping that say auto (forged past the parser) still do not send.
    const real = services.plugins.active.bind(services.plugins)
    const spy = vi.spyOn(services.plugins, 'active').mockImplementation(async (...args: Json[]) => {
      const r = await (real as Json)(...args)
      if (!r.ok) return r
      const operations = { ...r.plugin.manifest.operations, create_deal: { ...r.plugin.manifest.operations.create_deal, policy: 'auto' } }
      return { ok: true, plugin: { ...r.plugin, manifest: { ...r.plugin.manifest, operations }, mapping: { ...r.plugin.mapping, policy: { ...r.plugin.mapping.policy, create_deal: 'auto' } } } }
    })
    try {
      expect(await services.pluginOperations.createRecord({ companyId: CO, userId: 'op-member', role: 'member' }, { kind: 'human' }, 'sample-hub', 'create_deal', NEW_DEAL))
        .toMatchObject({ ok: false, body: { code: 'APPROVAL_REQUIRED' } })
    } finally { spy.mockRestore() }
    expect(dealPosts()).toBe(n)
  })

  it('similar deals: only records already imported that the member may read', async () => {
    const r = await services.pluginOperations.similarDeals({ companyId: CO, userId: 'op-member', role: 'member' }, 'sample-hub', 'リーダー研修（例示製作所）')
    expect(r.ok).toBe(true)
    expect(r.value.similar.map((s: Json) => s.recordId)).toContain(recordOf('1000000009'))
    expect(r.value.similar.every((s: Json) => typeof s.title === 'string')).toBe(true)
    // Cannot read where deals are: nothing is asked outside.
    const asked = fake.requests.length
    expect(await services.pluginOperations.similarDeals({ companyId: CO, userId: 'op-reader', role: 'member' }, 'sample-hub', 'リーダー研修')).toMatchObject({ ok: false, body: { code: 'NOT_ALLOWED' } })
    expect(fake.requests.length).toBe(asked)
  })

  it('prepareApproval builds the payload without sending; executeApproved creates the deal as a record, approved by another person', async () => {
    const member = { companyId: CO, userId: 'op-member', role: 'member' }
    const n = dealPosts()
    const prepared = await services.pluginOperations.prepareApproval(member, { kind: 'ai', source: 'claude-code', conversationId: 'conv-op' }, 'sample-hub', null, 'create_deal', NEW_DEAL)
    expect(prepared.ok).toBe(true)
    expect(prepared.value).toMatchObject({
      approver: 'self', folder: '営業部',
      payload: { v: 1, kind: 'plugin_operation', operation: 'create_deal', record: null, externalId: null, accountId: '90000001',
        create: { title: NEW_DEAL.title, properties: { dealname: NEW_DEAL.title, dealstage: 'qualifiedtobuy', amount: '1200000' } } },
    })
    expect(dealPosts()).toBe(n)
    const done = await services.pluginOperations.executeApproved(owner, { userId: 'op-member', actorKind: 'ai', conversationId: 'conv-op', source: 'claude-code' }, prepared.value.payload, '金額と時期を確認した')
    expect(done.ok).toBe(true)
    expect(done.value).toMatchObject({ kind: 'create', state: 'applied', approvedBy: 'op-owner', actorKind: 'ai', undoable: true })
    expect(dealPosts()).toBe(n + 1)
    const made = fake.withOperationId(done.value.id)
    expect(made).toEqual([{ type: 'deals', id: expect.any(String), archived: false }])
    expect(fake.deal(made[0].id)!.properties).toMatchObject({ dealname: NEW_DEAL.title, dealstage: 'qualifiedtobuy', amount: '1200000' })
    // A record of the company map: server only (no file), linked like an import; its entry is the requester's, a decision with the approver's reason.
    const recordId = done.value.recordId
    expect(recordId).toBe(recordOf(made[0].id))
    expect(db.prepare('SELECT path, folder, title FROM records WHERE company_id = ? AND id = ?').get(CO, recordId)).toEqual({ path: null, folder: '営業部', title: NEW_DEAL.title })
    const entry = services.recordEngine.history(member, recordId).value.entries[0]
    expect(entry).toMatchObject({ actorId: 'op-member', actorKind: 'ai', isDecision: true, decision: { reason: '金額と時期を確認した' }, receipt: { kind: 'written', approvedBy: 'op-owner', operationId: done.value.id } })
    // 「作ったものを取り消す」: archived in HubSpot, only that deal.
    const undo = await person('op-member', 'POST', `/operations/${done.value.id}/undo`)
    expect(undo.body.data.operation).toMatchObject({ kind: 'undo', state: 'applied' })
    expect(fake.deal(made[0].id)!.archived).toBe(true)
    expect(fake.deal('1000000009')!.archived).toBe(false)
  })

  it('executeApproved refuses without a reason, and when the requester is no longer a member', async () => {
    const member = { companyId: CO, userId: 'op-member', role: 'member' }
    const prepared = await services.pluginOperations.prepareApproval(member, { kind: 'human' }, 'sample-hub', null, 'create_deal', NEW_DEAL)
    const n = dealPosts()
    expect(await services.pluginOperations.executeApproved(owner, { userId: 'op-member', actorKind: 'human', conversationId: null }, prepared.value.payload, ' '))
      .toMatchObject({ ok: false, body: { code: 'REASON_REQUIRED' } })
    expect(await services.pluginOperations.executeApproved(owner, { userId: 'op-gone', actorKind: 'human', conversationId: null }, prepared.value.payload, '理由'))
      .toMatchObject({ ok: false, body: { code: 'REQUESTER_NOT_MEMBER' } })
    expect(dealPosts()).toBe(n)
  })
})

describe('stage by approval (milestone 4): the approval seam for updates', () => {
  const member = { companyId: CO, userId: 'op-member', role: 'member' }
  const prepare = async (fields: Record<string, unknown>) => {
    const id = recordOf('1000000010') // assignee op-member
    // Bring in what HubSpot holds now (earlier tests change this deal there).
    await person('op-member', 'POST', `/records/${id}/operations/refresh_deal`, {})
    const r = await services.pluginOperations.prepareApproval(member, { kind: 'human' }, 'sample-hub', id, 'update_deal', { expectedVersion: versionOf(id), fields })
    expect(r.ok).toBe(true)
    return r.value
  }
  const execute = (payload: Json, requester: Json = { userId: 'op-member', actorKind: 'human', conversationId: 'conv-op' }) =>
    services.pluginOperations.executeApproved(owner, requester, payload, '提案の段階に進んだことを確認')

  it('a stage change is APPROVAL_REQUIRED (no longer "not writable"); prepareApproval fixes the raw values before and after', async () => {
    const id = recordOf('1000000010')
    await person('op-member', 'POST', `/records/${id}/operations/refresh_deal`, {})
    const n = patches()
    expect(await services.pluginOperations.run(member, { kind: 'human' }, 'sample-hub', id, 'update_deal', update(id, { stage: 'final' })))
      .toMatchObject({ ok: false, body: { code: 'APPROVAL_REQUIRED', fields: ['stage'] } })
    const prepared = await prepare({ stage: 'final' })
    expect(prepared).toMatchObject({
      approver: 'self',
      payload: { operation: 'update_deal', externalId: '1000000010', changes: [{ field: 'stage', property: 'dealstage', after: 'final', rawBefore: 'presentationscheduled', rawAfter: 'decisionmakerboughtin' }] },
    })
    // Every field auto: no approval needed; an off field: refused.
    expect(await services.pluginOperations.prepareApproval(member, { kind: 'human' }, 'sample-hub', id, 'update_deal', { expectedVersion: versionOf(id), fields: { next_step: 'x' } }))
      .toMatchObject({ ok: false, body: { code: 'APPROVAL_NOT_NEEDED' } })
    expect(patches()).toBe(n)
  })

  it('refuses when HubSpot\'s value changed since rawBefore — nothing sent', async () => {
    const prepared = await prepare({ stage: 'final' })
    fake.changeDealOutside('1000000010', { dealstage: 'qualifiedtobuy' })
    const n = patches()
    expect(await execute(prepared.payload)).toMatchObject({ ok: false, body: { code: 'CHANGED_OUTSIDE', current: { stage: 'qualifiedtobuy' } } })
    expect(patches()).toBe(n)
    fake.changeDealOutside('1000000010', { dealstage: 'presentationscheduled' })
  })

  it('refuses when the mapping version or the connection changed, or the field became off — nothing sent', async () => {
    const n = patches()
    const a = await prepare({ stage: 'final' })
    expect((await services.plugins.saveMapping(owner, 'sample-hub', { text: MAPPING })).ok).toBe(true)
    expect(await execute(a.payload)).toMatchObject({ ok: false, body: { code: 'APPROVAL_STALE' } })
    const b = await prepare({ stage: 'final' })
    expect(await execute({ ...b.payload, connectionId: 'another-connection' })).toMatchObject({ ok: false, body: { code: 'APPROVAL_STALE' } })
    // The field turned off under the same mapping version (only reachable by a forged plugin; the check holds anyway).
    const real = services.plugins.active.bind(services.plugins)
    const spy = vi.spyOn(services.plugins, 'active').mockImplementation(async (...args: Json[]) => {
      const r = await (real as Json)(...args)
      if (!r.ok) return r
      const deal = r.plugin.mapping.objects.deal
      return { ok: true, plugin: { ...r.plugin, mapping: { ...r.plugin.mapping, objects: { ...r.plugin.mapping.objects, deal: { ...deal, fields: { ...deal.fields, stage: { ...deal.fields.stage, write: false } } } } } } }
    })
    try {
      expect(await execute(b.payload)).toMatchObject({ ok: false, body: { code: 'FIELD_NOT_WRITABLE' } })
    } finally { spy.mockRestore() }
    expect(patches()).toBe(n)
  })

  it('sends exactly the payload\'s raw values (never re-translated); the ledger actor is the requester, a decision with the approver\'s reason', async () => {
    const prepared = await prepare({ stage: 'final' })
    // The fixed content says which raw value goes out; a translation of `after` would give decisionmakerboughtin.
    const payload = { ...prepared.payload, changes: [{ ...prepared.payload.changes[0], rawAfter: 'contractsent' }] }
    const n = patches()
    const done = await execute(payload, { userId: 'op-member', actorKind: 'ai', conversationId: 'conv-op', source: 'claude-code' })
    expect(done.ok).toBe(true)
    expect(done.value).toMatchObject({ kind: 'update', state: 'applied', approvedBy: 'op-owner', actorKind: 'ai' })
    expect(patches()).toBe(n + 1)
    expect(fake.deal('1000000010')!.properties.dealstage).toBe('contractsent')
    const entry = services.recordEngine.history(member, recordOf('1000000010')).value.entries.find((e: Json) => e.receipt?.operationId === done.value.id)
    expect(entry).toMatchObject({ actorId: 'op-member', actorKind: 'ai', isDecision: true, decision: { reason: '提案の段階に進んだことを確認' }, receipt: { approvedBy: 'op-owner' } })
    fake.changeDealOutside('1000000010', { dealstage: 'presentationscheduled' })
  })
})

describe('creates and approvals keep keys and other companies out', () => {
  it('no key value in any operation record or ledger entry', () => {
    const rows = JSON.stringify(db.prepare('SELECT * FROM plugin_operations').all()) + JSON.stringify(db.prepare('SELECT * FROM record_ledger').all())
    expect(rows).not.toContain(KEY)
    expect(rows).not.toContain('pat-fake')
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
