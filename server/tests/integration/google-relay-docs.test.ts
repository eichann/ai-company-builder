/**
 * Integration Test: Google Docs through the relay with the member's own permission (U2', owner
 * decision 2026-11-24, `.claude/rules/google-connector.md` "The relay"), end to end: a script's
 * `$ACB_GOOGLE_BASE_URL/docs/v1/documents/…` call → the key broker's relay → the one Google client
 * with the member's own grant → the fake Google's Docs (practice redirect).
 *
 * What it protects (every refusal also checks that nothing reached Google and the Doc is unchanged):
 * - only reading a Doc and a batchUpdate of adding / formatting kinds pass; every kind that removes,
 *   replaces or merges content, an unlisted kind, two kinds in one request, more than 500 requests,
 *   an unknown body field, a new document and any other path are refused;
 * - only the listed query parameters pass (`alt=json` only as that exact value, also for Sheets);
 * - a write goes only into a Doc owned inside the company's Workspace (an outsider's Doc, a Doc in an
 *   unregistered shared drive: refused before the Docs call; reads pass);
 * - ドキュメント is its own switch: off for a company until an owner/admin turns it on, asked only by
 *   name (never in the one consent), the member's 「やめる」; turning スプレッドシート off does not stop
 *   a Doc's owner lookup, and the other way round;
 * - every stop (company-wide, the member's, the AI emergency stop — also while the body arrives) and
 *   the daily cap, counted together with Sheets;
 * - the records name the Doc by id only: never its text, a token or a Google token.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeGoogle, type FakeGoogle } from '../fakes/google/fake-google'
import { GOOGLE_SEED } from '../fakes/google/seed'
import { makeTempDir } from '../../shared/testing/temp-dirs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const EMAILS: Record<string, string> = {
  'd-owner': 'owner@div.example',
  'd-sato': GOOGLE_SEED.member,
  'd-tanaka': GOOGLE_SEED.colleague,
}
const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@x`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.filter(id => EMAILS[id]).map(id => [id, { email: EMAILS[id], name: `Name ${id}` }]))),
  auth: { handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const CO = 'gd-co'
const PUBLIC = 'http://localhost:13003'
const REDIRECT = `${PUBLIC}/api/oauth/google/callback`
const CLIENT_ID = '123456789012-docsrelay.apps.googleusercontent.com'
const SECRET = 'fake-google-secret-NOT-REAL-docsrelay-0123456789'
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents'
const DOC = GOOGLE_SEED.practiceDoc
const OUTSIDE = GOOGLE_SEED.outsideDoc
const SHARED = GOOGLE_SEED.sharedDriveDoc
const READ_ONLY = GOOGLE_SEED.readOnlyDoc
const SHEET = GOOGLE_SEED.practiceSheet
/** Text the relay writes into a Doc: it must never show up in a record, a table or a log line. */
const TEXT = 'DOCS-RELAY-CONTENT-一意の値-3c9e'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, services: any, db: any
let fake: FakeGoogle
let server: ServerType
let kekDir: string, shelfDir: string
const logLines: string[] = []
const answers: string[] = []
const tokens: string[] = []

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  currentUser.id = user
  const res: Response = await app.request(`${PUBLIC}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  answers.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* a page */ }
  return { status: res.status, body: json }
}
const C = `/api/companies/${CO}`

/** A script's call: `$ACB_GOOGLE_BASE_URL/<service>/…` with `Authorization: Bearer $ACB_GOOGLE_API_KEY`. */
async function script(token: string, method: string, path: string, body?: unknown, service = 'docs'): Promise<{ status: number; body: Json }> {
  currentUser.id = null
  const res: Response = await app.request(`${PUBLIC}/api/broker/google/${service}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  answers.push(text)
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* empty */ }
  return { status: res.status, body: json }
}
const batch = (id: string) => `/v1/documents/${id}:batchUpdate`
const insert = (text = TEXT) => ({ insertText: { endOfSegmentLocation: {}, text } })

/** A fresh token (a member may hold 50 live ones; the many refusal cases reuse theirs with `tokenOf`). */
async function tokenFor(user: string): Promise<{ token: string | null; services: string[] }> {
  const r = await call(user, 'POST', `${C}/me/broker-tokens`, { conversationId: `conv-${user}` })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  if (r.body.data.token) tokens.push(r.body.data.token)
  return { token: r.body.data.token, services: r.body.data.services.map((s: Json) => s.service) }
}

/** 「Google で許可」 all the way for these features, signing in at the fake as `email`. */
async function allow(user: string, features: string[], email: string) {
  fake.signIn({ email })
  const r = await call(user, 'POST', `${C}/me/google/connect`, { features })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  const url = new URL(r.body.data.authorizeUrl)
  const res = await fetch(url, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  expect((await call(null, 'GET', `/api/oauth/google/callback${back.search}`)).status).toBe(200)
  return url
}

const kept = new Map<string, string>()
/** One token per member for the refusal cases (they do not change who may do what). */
async function tokenOf(user: string): Promise<{ token: string | null }> {
  if (!kept.has(user)) kept.set(user, (await tokenFor(user)).token!)
  return { token: kept.get(user)! }
}

const sent = () => fake.requests.length
const doc = (id = DOC) => JSON.stringify(fake.relayDocument(id))
/** Docs writes that reached the fake for this Doc. */
const docWrites = (id: string) => fake.requests.filter(r => r.method === 'POST' && r.path.startsWith(`/v1/documents/${id}`)).length

beforeAll(async () => {
  fake = createFakeGoogle()
  fake.addClient({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUris: [REDIRECT] })
  server = serve({ fetch: fake.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise(r => setTimeout(r, 50))
  const port = (server.address() as AddressInfo).port
  kekDir = makeTempDir('acb-gd-kek-')
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  shelfDir = makeTempDir('acb-gd-shelf-')
  Object.assign(process.env, {
    BROKER_KEK_FILE: join(kekDir, 'kek'), PLUGINS_DIR: shelfDir, PUBLIC_URL: PUBLIC,
    ACB_ALLOW_FAKE_UPSTREAMS: '1', ACB_FAKE_GOOGLE_URL: `http://127.0.0.1:${port}`,
  })
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logLines.push(args.map(String).join(' ')) })
  }
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  const { requestLog } = await import('../../src/lib/request-log')
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  app = new Hono()
  app.use('*', requestLog())
  app.route('/api/companies/:companyId', (await import('../../src/routes/google')).googleRoute)
  app.route('/api/companies/:companyId', (await import('../../src/routes/key-broker')).keyBrokerRoute)
  app.route('/api/oauth', (await import('../../src/routes/oauth')).oauthRoute)
  app.route('/api/broker', brokerRelayRoutes(services.brokerRelay))

  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'd-owner', ts(), ts())
  for (const [u, role] of [['d-owner', 'owner'], ['d-sato', 'member'], ['d-tanaka', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, role, ts(), ts())
  }
  expect((await call('d-owner', 'PUT', `${C}/google/client`, { clientId: CLIENT_ID, clientSecret: SECRET, domain: GOOGLE_SEED.internalDomain })).status).toBe(200)
})

afterAll(async () => {
  fake.close()
  await new Promise(r => server.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  for (const k of ['BROKER_KEK_FILE', 'PLUGINS_DIR', 'PUBLIC_URL', 'ACB_ALLOW_FAKE_UPSTREAMS', 'ACB_FAKE_GOOGLE_URL']) delete process.env[k]
})

describe('docs: who turns it on and who allows it', () => {
  it('is off until an owner/admin ticks ドキュメント; it is its own switch beside スプレッドシート', async () => {
    const view = await call('d-owner', 'GET', `${C}/google/relay`)
    expect(view.body.data.services).toEqual([{ service: 'sheets', on: false }, { service: 'docs', on: false }])
    expect((await call('d-sato', 'PUT', `${C}/google/relay`, { services: { docs: true } })).status).toBe(403)
    expect((await call('d-sato', 'POST', `${C}/me/google/connect`, { features: ['documents'] })).body.code).toBe('GOOGLE_FEATURE_COMPANY_OFF')
    const on = await call('d-owner', 'PUT', `${C}/google/relay`, { services: { docs: true } })
    expect(on.body.data.services).toEqual([{ service: 'sheets', on: false }, { service: 'docs', on: true }])
    // The company switch is the Google feature `documents` (history line `features`).
    const history = (db.prepare("SELECT change FROM connector_history WHERE company_id = ? AND action = 'features'").all(CO) as Array<{ change: string }>).map(h => JSON.parse(h.change))
    expect(history).toContainEqual({ feature: 'documents', on: true })
  })

  it('is asked only when the member names it: never in the one consent', async () => {
    const all = await call('d-sato', 'POST', `${C}/me/google/connect`, { all: true })
    expect(new URL(all.body.data.authorizeUrl).searchParams.get('scope')!.split(' ')).not.toContain(DOCS_SCOPE)
    expect((await call('d-sato', 'GET', `${C}/me/google`)).body.data.companyFeatures).not.toContain('documents')
    const url = await allow('d-sato', ['documents'], GOOGLE_SEED.member)
    const scopes = url.searchParams.get('scope')!.split(' ')
    expect(scopes).toContain(DOCS_SCOPE)
    expect(scopes).toContain('https://www.googleapis.com/auth/drive.metadata.readonly')
    const mine = (await call('d-sato', 'GET', `${C}/me/google/relay`)).body.data
    expect(mine.services).toEqual([
      { service: 'sheets', offered: false, allowed: false, turnedOff: false },
      { service: 'docs', offered: true, allowed: true, turnedOff: false },
    ])
    const { services: covered } = await tokenFor('d-sato')
    expect(covered).toContain('google')
  })
})

describe('docs: what the weekly report does passes', () => {
  it('reads the Doc and writes text, a table, styles and bullets (on and off) at the version it read', async () => {
    const { token } = await tokenFor('d-sato')
    const read = await script(token!, 'GET', `/v1/documents/${DOC}?includeTabsContent=false&alt=json`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    const revision = read.body.revisionId
    const w = await script(token!, 'POST', `${batch(DOC)}?alt=json`, {
      requests: [
        insert(),
        { insertTable: { rows: 2, columns: 2, endOfSegmentLocation: {} } },
        { insertTableRow: { tableCellLocation: { tableStartLocation: { index: 5 }, rowIndex: 0, columnIndex: 0 }, insertBelow: true } },
        { updateTextStyle: { range: { startIndex: 1, endIndex: 3 }, textStyle: { bold: true }, fields: 'bold' } },
        { updateParagraphStyle: { range: { startIndex: 1, endIndex: 3 }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } },
        { updateTableColumnProperties: { tableStartLocation: { index: 5 }, columnIndices: [0], tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: 100, unit: 'PT' } }, fields: '*' } },
        { updateTableCellStyle: { tableStartLocation: { index: 5 }, tableCellStyle: { backgroundColor: {} }, fields: 'backgroundColor' } },
        { createParagraphBullets: { range: { startIndex: 1, endIndex: 3 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
        { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 3 } } },
      ],
      writeControl: { requiredRevisionId: revision },
    })
    expect(w.status, JSON.stringify(w.body)).toBe(200)
    const after = fake.relayDocument(DOC)!
    expect(after.text).toContain(TEXT)
    expect(after.applied).toContain('deleteParagraphBullets')
    // A write over a newer version: Google refuses it (the relay passes writeControl as it is).
    const stale = await script(token!, 'POST', batch(DOC), { requests: [insert('stale')], writeControl: { requiredRevisionId: revision } })
    expect(stale.status).toBe(400)
    expect(fake.relayDocument(DOC)!.text).not.toContain('stale')
  })

  it('Google refuses a Doc the member may only read; the answer says Google refused', async () => {
    const { token } = await tokenFor('d-sato')
    expect((await script(token!, 'GET', `/v1/documents/${READ_ONLY}`)).status).toBe(200)
    // A colleague's Doc is inside the company, so the owner check passes and Google decides.
    const w = await script(token!, 'POST', batch(READ_ONLY), { requests: [insert()] })
    expect(w.status).toBe(403)
    expect(w.body.error.message).toContain('Google が断りました')
    expect(fake.relayDocument(READ_ONLY)!.text).not.toContain(TEXT)
  })
})

describe('docs: never a deletion, never an unlisted call — refused before anything leaves ACB', () => {
  const deletionKinds: Array<[string, unknown]> = [
    ['deleteContentRange', { range: { startIndex: 1, endIndex: 5 } }],
    ['deleteTableRow', { tableCellLocation: { tableStartLocation: { index: 5 }, rowIndex: 0 } }],
    ['deleteTableColumn', { tableCellLocation: { tableStartLocation: { index: 5 }, columnIndex: 0 } }],
    ['deleteNamedRange', { name: 'x' }],
    ['deletePositionedObject', { objectId: 'x' }],
    ['deleteHeader', { headerId: 'x' }],
    ['deleteFooter', { footerId: 'x' }],
    ['deleteTab', { tabId: 'x' }],
    ['replaceAllText', { containsText: { text: '週次', matchCase: true }, replaceText: '' }],
    ['replaceImage', { imageObjectId: 'x', uri: 'https://example.com/x.png' }],
    ['replaceNamedRangeContent', { namedRangeName: 'x', text: '' }],
    ['mergeTableCells', { tableRange: { tableCellLocation: { tableStartLocation: { index: 5 } }, rowSpan: 2, columnSpan: 2 } }],
    ['unmergeTableCells', { tableRange: { tableCellLocation: { tableStartLocation: { index: 5 } }, rowSpan: 2, columnSpan: 2 } }],
    ['delete_content_range', { range: { start_index: 1, end_index: 5 } }],
  ]
  for (const [kind, value] of deletionKinds) {
    it(`refuses ${kind} as a deletion, also behind an allowed request`, async () => {
      const { token } = await tokenOf('d-sato')
      const before = sent()
      const was = doc()
      const r = await script(token!, 'POST', batch(DOC), { requests: [insert(), { [kind]: value }] })
      expect(r.status).toBe(403)
      expect(r.body.error.code).toBe('ACB_DELETE_REFUSED')
      expect(sent()).toBe(before)
      expect(doc()).toBe(was)
    })
  }

  const others: Array<[string, string, string, unknown?]> = [
    ['an unlisted kind (insertInlineImage: fetches an outside URL)', 'POST', batch(DOC), { requests: [{ insertInlineImage: { uri: 'https://example.com/x.png', endOfSegmentLocation: {} } }] }],
    ['an unlisted kind (createNamedRange)', 'POST', batch(DOC), { requests: [{ createNamedRange: { name: 'x', range: { startIndex: 1, endIndex: 2 } } }] }],
    ['an unlisted kind (updateDocumentStyle)', 'POST', batch(DOC), { requests: [{ updateDocumentStyle: { documentStyle: {}, fields: '*' } }] }],
    // A link change points the Doc's existing links elsewhere (a replacement, not formatting).
    ['updateTextStyle changing links', 'POST', batch(DOC), { requests: [{ updateTextStyle: { range: { startIndex: 1, endIndex: 9 }, textStyle: { link: { url: 'https://example.com/x' } }, fields: 'link' } }] }],
    ['updateTextStyle with a link among its fields', 'POST', batch(DOC), { requests: [{ updateTextStyle: { range: { startIndex: 1, endIndex: 9 }, textStyle: { bold: true, link: { url: 'https://example.com/x' } }, fields: 'bold, link.url' } }] }],
    ['updateTextStyle with fields *', 'POST', batch(DOC), { requests: [{ updateTextStyle: { range: { startIndex: 1, endIndex: 9 }, textStyle: { link: { url: 'https://example.com/x' } }, fields: '*' } }] }],
    ['updateTextStyle without fields', 'POST', batch(DOC), { requests: [{ updateTextStyle: { range: { startIndex: 1, endIndex: 9 }, textStyle: { bold: true } } }] }],
    ['two kinds in one request', 'POST', batch(DOC), { requests: [{ insertText: { text: 'x', endOfSegmentLocation: {} }, deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }] }],
    ['501 requests', 'POST', batch(DOC), { requests: Array.from({ length: 501 }, () => insert('x')) }],
    ['no requests', 'POST', batch(DOC), { requests: [] }],
    ['an unknown body field', 'POST', batch(DOC), { requests: [insert()], documentId: OUTSIDE }],
    ['a new document', 'POST', '/v1/documents', { title: 'x' }],
    ['a batchUpdate as GET', 'GET', batch(DOC)],
    ['GET as POST', 'POST', `/v1/documents/${DOC}`, { requests: [insert()] }],
    ['another verb', 'POST', `/v1/documents/${DOC}:copy`, {}],
    ['a sub-path', 'GET', `/v1/documents/${DOC}/revisions`],
    ['another API version', 'GET', `/v2/documents/${DOC}`],
    ['another API', 'GET', '/v1/documents/../../drive/v3/files'],
  ]
  for (const [name, method, path, body] of others) {
    it(`refuses ${name}`, async () => {
      const { token } = await tokenOf('d-sato')
      const before = sent()
      const was = doc()
      const r = await script(token!, method, path, body)
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(sent()).toBe(before)
      expect(doc()).toBe(was)
    })
  }

  it('a Docs path spelled with escapes is refused before anything is counted', async () => {
    const { token } = await tokenOf('d-sato')
    const used = (await call('d-sato', 'GET', `${C}/me/google/relay`)).body.data.usedToday
    const before = sent()
    for (const path of [`/v1/documents/${DOC}%3AbatchUpdate`, `/v1/%64ocuments/${DOC}`]) {
      const r = await script(token!, path.endsWith('Update') ? 'POST' : 'GET', path, path.endsWith('Update') ? { requests: [insert()] } : undefined)
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('ACB_BAD_PATH')
    }
    expect(sent()).toBe(before)
    expect((await call('d-sato', 'GET', `${C}/me/google/relay`)).body.data.usedToday).toBe(used)
  })

  it('files a deletion as one, with the Doc named by id', async () => {
    const { token } = await tokenOf('d-sato')
    await script(token!, 'POST', batch(DOC), { requests: [{ replaceAllText: { containsText: { text: '週次' }, replaceText: '' } }] })
    const latest = (await call('d-owner', 'GET', `${C}/google/relay`)).body.data.records[0]
    expect(latest).toMatchObject({ userId: 'd-sato', service: 'docs', operation: 'documents.batchUpdate', documentId: DOC, spreadsheetId: null, result: 'refused', reason: 'deletion' })
  })
})

describe('docs: query parameters', () => {
  const cases: Array<[string, string, string]> = [
    ['access_token (would act as someone else)', 'GET', `/v1/documents/${DOC}?access_token=ya29.fake-someone-else`],
    ['alt=media', 'GET', `/v1/documents/${DOC}?alt=media`],
    ['alt=proto', 'GET', `/v1/documents/${DOC}?alt=proto`],
    ['a second alt beside alt=json', 'GET', `/v1/documents/${DOC}?alt=json&alt=media`],
    ['a reading parameter on a write', 'POST', `${batch(DOC)}?includeTabsContent=true`],
    ['an unknown parameter', 'GET', `/v1/documents/${DOC}?upload_protocol=raw`],
  ]
  for (const [name, method, path] of cases) {
    it(`refuses ${name}`, async () => {
      const { token } = await tokenOf('d-sato')
      const before = sent()
      const r = await script(token!, method, path, method === 'POST' ? { requests: [insert()] } : undefined)
      expect(r.status).toBe(400)
      expect(sent()).toBe(before)
    })
  }

  it('Sheets passes alt=json (Google\'s Python client adds it) and refuses any other alt', async () => {
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { services: { sheets: true } })).status).toBe(200)
    await allow('d-sato', ['sheets'], GOOGLE_SEED.member)
    const { token } = await tokenOf('d-sato')
    const path = `/v4/spreadsheets/${SHEET}/values/${encodeURIComponent('案件!A1')}`
    expect((await script(token!, 'GET', `${path}?alt=json`, undefined, 'sheets')).status).toBe(200)
    const before = sent()
    for (const alt of ['media', 'proto', 'sse', 'JSON']) {
      expect((await script(token!, 'GET', `${path}?alt=${alt}`, undefined, 'sheets')).status).toBe(400)
    }
    expect(sent()).toBe(before)
  })
})

describe('docs: writes only into Docs owned inside the company', () => {
  it('an outsider\'s Doc: reads pass, a write is refused before the Docs call', async () => {
    const { token } = await tokenFor('d-sato')
    expect((await script(token!, 'GET', `/v1/documents/${OUTSIDE}`)).status).toBe(200)
    const before = docWrites(OUTSIDE)
    const was = doc(OUTSIDE)
    const r = await script(token!, 'POST', batch(OUTSIDE), { requests: [insert()] })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('ACB_OUTSIDE_DOCUMENT')
    expect(r.body.error.message).toContain('会社の外の人が持っているドキュメント')
    expect(docWrites(OUTSIDE)).toBe(before)
    expect(doc(OUTSIDE)).toBe(was)
    const latest = (await call('d-owner', 'GET', `${C}/google/relay`)).body.data.records[0]
    expect(latest).toMatchObject({ service: 'docs', documentId: OUTSIDE, result: 'refused', reason: 'outside' })
    // The lookup asked Drive for the owner and the shared drive only.
    const lookups = fake.requests.filter(q => q.path === `/drive/v3/files/${OUTSIDE}`)
    expect(lookups.length).toBeGreaterThan(0)
    for (const q of lookups) expect(new URLSearchParams(q.search).get('fields')).toBe('owners(emailAddress),driveId')
  })

  it('a Doc in a shared drive: refused until an owner/admin registers that drive', async () => {
    const { token } = await tokenFor('d-sato')
    const before = docWrites(SHARED)
    const r = await script(token!, 'POST', batch(SHARED), { requests: [insert()] })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('ACB_OUTSIDE_DOCUMENT')
    expect(r.body.error.message).toContain('共有ドライブ')
    expect(docWrites(SHARED)).toBe(before)
    expect((await call('d-owner', 'POST', `${C}/google/relay/shared-drives`, { drive: 'fake-shared-drive-0001' })).status).toBe(200)
    expect((await script(token!, 'POST', batch(SHARED), { requests: [insert()] })).status).toBe(200)
    expect((await call('d-owner', 'DELETE', `${C}/google/relay/shared-drives/fake-shared-drive-0001`)).status).toBe(200)
    const again = await script(token!, 'POST', batch(SHARED), { requests: [insert()] })
    expect(again.body.error.code).toBe('ACB_OUTSIDE_DOCUMENT')
  })
})

describe('docs: every switch refuses before anything leaves ACB', () => {
  it('a member who allowed only スプレッドシート', async () => {
    await allow('d-tanaka', ['sheets'], GOOGLE_SEED.colleague)
    const { token } = await tokenFor('d-tanaka')
    const before = sent()
    const r = await script(token!, 'GET', `/v1/documents/${READ_ONLY}`)
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('ACB_GOOGLE_NOT_ALLOWED')
    expect(r.body.error.message).toContain('ドキュメントを中継で使う')
    expect(sent()).toBe(before)
  })

  it('the member\'s 「やめる」 of ドキュメント, and on again; スプレッドシート keeps working meanwhile', async () => {
    const { token } = await tokenFor('d-sato')
    expect((await call('d-sato', 'PUT', `${C}/me/google/features`, { feature: 'documents', on: false })).status).toBe(200)
    expect((await call('d-sato', 'GET', `${C}/me/google/relay`)).body.data.services[1]).toMatchObject({ service: 'docs', allowed: false, turnedOff: true })
    const before = sent()
    expect((await script(token!, 'GET', `/v1/documents/${DOC}`)).body.error.code).toBe('ACB_GOOGLE_NOT_ALLOWED')
    expect(sent()).toBe(before)
    // The spreadsheet relay's write (and its owner lookup with the shared Drive permission) still passes.
    const sheetWrite = await script(token!, 'PUT', `/v4/spreadsheets/${SHEET}/values/${encodeURIComponent('案件!G1')}?valueInputOption=RAW`, { values: [['x']] }, 'sheets')
    expect(sheetWrite.status, JSON.stringify(sheetWrite.body)).toBe(200)
    expect((await call('d-sato', 'PUT', `${C}/me/google/features`, { feature: 'documents', on: true })).status).toBe(200)
    expect((await script(token!, 'GET', `/v1/documents/${DOC}`)).status).toBe(200)
  })

  it('スプレッドシート turned off (by the member, then by the company) does not stop a Doc\'s owner lookup or write', async () => {
    const { token } = await tokenFor('d-sato')
    expect((await call('d-sato', 'PUT', `${C}/me/google/features`, { feature: 'sheets', on: false })).status).toBe(200)
    expect((await script(token!, 'POST', batch(DOC), { requests: [insert('after-sheets-off')] })).status).toBe(200)
    expect((await call('d-sato', 'PUT', `${C}/me/google/features`, { feature: 'sheets', on: true })).status).toBe(200)
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { services: { sheets: false } })).status).toBe(200)
    expect((await script(token!, 'POST', batch(DOC), { requests: [insert('after-company-sheets-off')] })).status).toBe(200)
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { services: { sheets: true } })).status).toBe(200)
  })

  it('the company turned ドキュメント off: refused (Sheets still relayed)', async () => {
    const { token } = await tokenFor('d-sato')
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { services: { docs: false } })).status).toBe(200)
    const before = sent()
    const r = await script(token!, 'GET', `/v1/documents/${DOC}`)
    expect(r.body.error.code).toBe('ACB_GOOGLE_OFF')
    expect(sent()).toBe(before)
    expect((await script(token!, 'GET', `/v4/spreadsheets/${SHEET}/values/${encodeURIComponent('案件!A1')}`, undefined, 'sheets')).status).toBe(200)
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { services: { docs: true } })).status).toBe(200)
  })

  it('the company-wide stop, one member\'s stop and the AI emergency stop', async () => {
    const { token } = await tokenFor('d-sato')
    const owner = { companyId: CO, userId: 'd-owner', role: 'owner' }
    const was = doc()
    let before = sent()
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { stopped: true })).status).toBe(200)
    expect((await script(token!, 'POST', batch(DOC), { requests: [insert()] })).body.error.code).toBe('ACB_STOPPED')
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { stopped: false })).status).toBe(200)
    expect((await call('d-owner', 'PUT', `${C}/google/relay/members/d-sato`, { stopped: true })).status).toBe(200)
    expect((await script(token!, 'GET', `/v1/documents/${DOC}`)).body.error.code).toBe('ACB_STOPPED')
    expect((await call('d-owner', 'PUT', `${C}/google/relay/members/d-sato`, { stopped: false })).status).toBe(200)
    const view = services.agentStops.stop(owner, {})
    expect(view.ok).toBe(true)
    expect((await script(token!, 'POST', batch(DOC), { requests: [insert()] })).body.error.code).toBe('ACB_STOPPED')
    for (const s of view.value.active) services.agentStops.release(owner, s.id)
    expect(sent()).toBe(before)
    expect(doc()).toBe(was)
    before = sent()
    expect((await script(token!, 'GET', `/v1/documents/${DOC}`)).status).toBe(200)
    expect(sent()).toBeGreaterThan(before)
  })

  it('the AI emergency stop pressed while the body is still arriving applies to that call', async () => {
    const { token } = await tokenFor('d-sato')
    const owner = { companyId: CO, userId: 'd-owner', role: 'owner' }
    const chunk = new TextEncoder().encode(JSON.stringify({ requests: [insert('late-after-ai-stop')] }))
    let pulled = false
    let stopIds: string[] = []
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulled) { controller.close(); return }
        pulled = true
        const view = services.agentStops.stop(owner, {})
        expect(view.ok).toBe(true)
        stopIds = view.value.active.map((s: Json) => s.id)
        controller.enqueue(chunk)
      },
    })
    const before = docWrites(DOC)
    currentUser.id = null
    try {
      const res = await app.request(`${PUBLIC}/api/broker/google/docs${batch(DOC)}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, duplex: 'half',
      } as RequestInit)
      expect(res.status).toBe(403)
      expect(JSON.parse(await res.text()).error.code).toBe('ACB_STOPPED')
      expect(docWrites(DOC)).toBe(before)
      expect(fake.relayDocument(DOC)!.text).not.toContain('late-after-ai-stop')
    } finally {
      for (const id of stopIds) services.agentStops.release(owner, id)
    }
  })

  it('the daily cap counts Docs and Sheets together', async () => {
    const { token } = await tokenFor('d-sato')
    const used = (await call('d-sato', 'GET', `${C}/me/google/relay`)).body.data.usedToday
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { capPerMemberPerDay: used + 1 })).status).toBe(200)
    expect((await script(token!, 'GET', `/v4/spreadsheets/${SHEET}/values/${encodeURIComponent('案件!A1')}`, undefined, 'sheets')).status).toBe(200)
    const before = sent()
    const over = await script(token!, 'GET', `/v1/documents/${DOC}`)
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('ACB_OVER_CAP')
    expect(sent()).toBe(before)
    expect((await call('d-owner', 'PUT', `${C}/google/relay`, { capPerMemberPerDay: 500 })).status).toBe(200)
  })
})

describe('docs: the Google client sends nothing else with the Docs write permission', () => {
  it('no new document, no other path, no Docs write under the minutes\' read permission', async () => {
    const before = sent()
    const refused: Array<Record<string, unknown>> = [
      { api: 'docs', method: 'POST', path: '/v1/documents', scope: DOCS_SCOPE, body: { title: 'x' } },
      { api: 'docs', method: 'GET', path: `/v1/documents/${DOC}:batchUpdate`, scope: DOCS_SCOPE },
      { api: 'docs', method: 'POST', path: `/v1/documents/${DOC}`, scope: DOCS_SCOPE, body: {} },
      { api: 'drive', method: 'GET', path: `/drive/v3/files/${DOC}`, scope: DOCS_SCOPE },
      { api: 'docs', method: 'POST', path: `/v1/documents/${DOC}:batchUpdate`, scope: 'https://www.googleapis.com/auth/documents.readonly', body: { requests: [insert()] } },
    ]
    for (const r of refused) {
      const res = await services.googleClient.request(CO, 'd-sato', { operation: 'test', ...r })
      expect(res, JSON.stringify(r)).toMatchObject({ ok: false, kind: 'not-sent', reason: 'call-not-allowed' })
    }
    expect(sent()).toBe(before)
  })
})

describe('docs: records', () => {
  it('admins and the member see the Doc by id; no text, broker token or Google token anywhere', async () => {
    const admin = (await call('d-owner', 'GET', `${C}/google/relay`)).body.data
    const ok = admin.records.find((x: Json) => x.service === 'docs' && x.operation === 'documents.batchUpdate' && x.result === 'ok')
    expect(ok).toMatchObject({ userId: 'd-sato', documentId: DOC, spreadsheetId: null, range: null, status: 200 })
    expect(admin.members.find((m: Json) => m.userId === 'd-sato').allowedServices).toEqual(['sheets', 'docs'])
    expect(admin.members.find((m: Json) => m.userId === 'd-tanaka').allowedServices).toEqual(['sheets'])
    const mine = (await call('d-sato', 'GET', `${C}/me/google/relay`)).body.data.records
    expect(mine.some((x: Json) => x.documentId === DOC)).toBe(true)

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name)
    const dump = tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
    const logs = logLines.join('\n')
    for (const secret of [TEXT, '週次レポート', 'ya29.fake-', ...tokens]) {
      expect(dump).not.toContain(secret)
      expect(logs).not.toContain(secret)
    }
    expect(answers.filter(a => a.includes('ya29.fake-') || a.includes('1//fake-'))).toEqual([])
    const events = JSON.stringify(db.prepare("SELECT * FROM agent_events WHERE tool = 'broker:google'").all())
    expect(events).toContain('docs.googleapis.com')
    expect(events).not.toContain(TEXT)
  })
})
