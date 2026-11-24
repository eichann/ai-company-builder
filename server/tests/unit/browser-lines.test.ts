/**
 * Plans of opened lines on the server (services/browser-lines.ts, services/browser-line-steps.ts; agent-browser.md "Plans
 * of opened lines on the server", "Executions with several writes"; design memo §3-5, §8, §15 C11–C13, §16-1, §16-4,
 * §16-5 / Q15), against a real database, the real opened list (shared/browser-connectors/opened.json: `landing_inspect`
 * approved on map 1.0.1) and the real approved Lステップ declaration (the site's host), the server's clocks in the test's
 * hand.
 *
 * Guards: the opened list re-checked (a row whose hashes do not match is never used), the gate an exact match of six
 * fields on an approved row, the site setting, the stop and the per-line grant (meaning + mechanics, carried only by a
 * reviewed `grantsFrom`); where a value comes from (which / when never from the AI or the site, no record field yet, a
 * person's value confirmed); an inspection's result once, fixed words, consistent; no plan of writes in this build; the
 * strict read's notice (names of the map only, a member who may use the site, limits, one per key, owners / admins told
 * once); the write state table row by row (the steps module), one lock key on both paths, and the rollback floor (rows a
 * writing build leaves, read by a build that does not know its line; a shape this build does not know frozen).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteBrowserLineExecutionLookup } from '../../src/adapters/sqlite/browser-lines'
import { fileBrowserConnectorCatalog, fileBrowserOpenedList } from '../../src/adapters/browser-connector-catalog'
import { sha256TokenDigest } from '../../src/adapters/system'
import { hashCanonical } from '../../src/lib/content-hash'
import { createBrowserLineService, BROWSER_SHAPE_NOTICE_LIMITS, type BrowserLineService } from '../../src/services/browser-lines'
import { createBrowserLineSteps, type BrowserLineWritesContent } from '../../src/services/browser-line-steps'
import type { BrowserLinePlanRow } from '../../src/ports/browser-lines'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import { browserLineMeaning, browserLineMechanics, type BrowserOpenedFile, type BrowserOpenedLine, type BrowserOpenedLineRow } from '../../../shared/core/browser-opened'
import { browserLockKey, browserObjectLockKey } from '../../../shared/core/browser-plans'
import { canonicalJson } from '../../../shared/core/fixed-content'
import type { Member } from '../../src/services/access'
import type { Refusal } from '../../src/services/outcome'
import { anyPc } from '../helpers/browser-devices'

const T0 = Date.parse('2026-11-25T00:00:00.000Z')
const CO = 'co-1'
const OTHER_CO = 'co-2'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const bob: Member = { companyId: CO, userId: 'u-bob', role: 'member' }
const HOST = 'manager.linestep.net'
const REAL_OPENED = fileBrowserOpenedList().file() as BrowserOpenedFile
const CATALOG = fileBrowserConnectorCatalog()
const approvedRow = () => REAL_OPENED.lines.find(l => l.name === 'landing_inspect' && l.mapVersion === '1.0.1') as BrowserOpenedLineRow
const pendingRow = () => REAL_OPENED.lines.find(l => l.name === 'landing_inspect' && l.mapVersion === '1.0.0') as BrowserOpenedLineRow
const refOf = (row: BrowserOpenedLineRow) => ({ site: row.site, line: row.name, version: row.version, mapVersion: row.mapVersion, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash })
const site = (value: string) => ({ value, from: { kind: 'site_fact' } })
const VALUES = { landing: site('501'), source: site('400') }

let conn: Database.Database
let now: number
let opened: unknown
let policy: BrowserOperationSettings
let stops: { all: boolean; tools: string[] }
let svc: BrowserLineService
let data: CompanyDataSource
let boot: string
let monoBase: number
const monotonic = { get bootId() { return boot }, monoMs: () => now - monoBase }
const iso = (ms: number) => new Date(ms).toISOString()
const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }
const clock = { now: () => iso(now), nowMs: () => now }

function build() {
  data = sqliteCompanyData(conn)
  svc = createBrowserLineService({
    companyData: data, transactions: sqliteTransactions(conn), clock, monotonic, ids, tokenDigest: sha256TokenDigest,
    opened: { file: () => opened }, catalog: CATALOG, executionLookup: sqliteBrowserLineExecutionLookup(conn),
    memberships: sqliteMembershipRepository(conn), accounts: { byIds: () => new Map() },
    browserPolicy: () => policy, aiStops: () => stops, devices: anyPc, log: { warn: () => {} },
  })
}
function join(companyId: string, userId: string, role: string, at = iso(T0 - 3_600_000)) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, at, at)
}
function value<T>(r: { ok: true; value: T } | Refusal): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)
function grant(m: Member, row = approvedRow()) {
  value(svc.setGrant(owner, m.userId, { site: row.site, line: row.name, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash, allowed: true }))
}
const inspect = (m = alice, values: unknown = VALUES, row = approvedRow()) => svc.create(m, { line: refOf(row), values })

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, alice.userId, 'member'); join(CO, bob.userId, 'member')
  now = T0
  boot = 'boot-1'
  monoBase = T0 - 3_600_000
  opened = REAL_OPENED
  policy = { mode: 'on', sites: [{ host: HOST, level: 'read', assetHosts: [] }] }
  stops = { all: false, tools: [] }
  build()
  grant(alice)
})

/** An opened file with these lines on the real map 1.0.1, their hashes computed as the script does. */
function fileWith(lines: Array<{ line: BrowserOpenedLine; status?: BrowserOpenedLineRow['status']; grantsFrom?: string[]; mechanicsOf?: { readersHash: string } }>): BrowserOpenedFile {
  const mapRow = REAL_OPENED.maps.find(m => m.version === '1.0.1')!
  const maps = [...REAL_OPENED.maps]
  const rows: BrowserOpenedLineRow[] = lines.map(({ line, status, grantsFrom, mechanicsOf }) => {
    let m = mapRow
    if (mechanicsOf) {
      // Another map version with other reader code (the mechanics move; the meaning stays).
      const version = `1.0.${maps.length + 5}`
      const map = { ...mapRow.map, version }
      m = { site: 'lstep', version, map, mapHash: hashCanonical(canonicalJson(map)), readersHash: mechanicsOf.readersHash }
      maps.push(m)
    }
    return {
      name: line.name, version: line.version, site: 'lstep', mapVersion: m.version, status: status ?? 'approved',
      meaningHash: hashCanonical(browserLineMeaning(line, m.map)),
      mechanicsHash: hashCanonical(browserLineMechanics(line, m.map, { mapHash: m.mapHash, readersHash: m.readersHash })),
      ...(grantsFrom ? { grantsFrom } : {}), line,
    }
  })
  return { format: 1, provisional: true, maps, lines: rows }
}
const realLine = () => JSON.parse(JSON.stringify(approvedRow().line)) as BrowserOpenedLine

describe('the opened list and the gate', () => {
  it('an inspection of the approved line is made open; the same line on the pending map row is not approved', () => {
    const p = value(inspect())
    expect(p.state).toBe('open')
    expect(p.writes).toBe(0)
    expect(p.line.label).toBe('流入経路を点検する')
    // Even with a grant on that row's hashes (written as a later build could have).
    const pending = pendingRow()
    data.forCompany(CO).browserLines.saveGrant({ userId: alice.userId, site: 'lstep', lineName: pending.name, meaningHash: pending.meaningHash, mechanicsHash: pending.mechanicsHash, grantedBy: owner.userId, grantedAt: iso(now) })
    expect(code(inspect(alice, VALUES, pending))).toBe('BROWSER_LINE_NOT_APPROVED')
  })

  it('only an exact match of all six fields passes', () => {
    const ref = refOf(approvedRow())
    const other = `sha256:${'1'.repeat(64)}`
    for (const changed of [{ meaningHash: other }, { mechanicsHash: other }, { version: '1.0.1' }, { mapVersion: '1.0.0' }, { line: 'landing_check' }, { site: 'other' }]) {
      expect(code(svc.create(alice, { line: { ...ref, ...changed }, values: VALUES })), JSON.stringify(changed)).toBe('BROWSER_LINE_NOT_APPROVED')
    }
  })

  it('a row whose stored hashes no longer match what it holds is left out (never trusted), and a retired row refused', () => {
    const edited = JSON.parse(JSON.stringify(REAL_OPENED)) as BrowserOpenedFile
    const row = edited.lines.find(l => l.mapVersion === '1.0.1')!
    row.line.read.checks = row.line.read.checks.slice(0, 1)
    opened = edited; build()
    expect(code(inspect())).toBe('BROWSER_LINE_NOT_APPROVED')
    // A map edited by hand with its hash left: every line on it goes.
    const mapEdited = JSON.parse(JSON.stringify(REAL_OPENED)) as BrowserOpenedFile
    delete (mapEdited.maps.find(m => m.version === '1.0.1')!.map.things.action_set as { must_hold?: unknown }).must_hold
    opened = mapEdited; build()
    expect(code(inspect())).toBe('BROWSER_LINE_NOT_APPROVED')
    const retired = JSON.parse(JSON.stringify(REAL_OPENED)) as BrowserOpenedFile
    retired.lines.find(l => l.mapVersion === '1.0.1')!.status = 'retired'
    opened = retired; build()
    expect(code(inspect())).toBe('BROWSER_LINE_RETIRED')
    // The map listed three times (each copy valid): every copy is out.
    const thrice = JSON.parse(JSON.stringify(REAL_OPENED)) as BrowserOpenedFile
    const m101 = thrice.maps.find(m => m.version === '1.0.1')!
    thrice.maps.push(JSON.parse(JSON.stringify(m101)), JSON.parse(JSON.stringify(m101)))
    opened = thrice; build()
    expect(code(inspect())).toBe('BROWSER_LINE_NOT_APPROVED')
    // No file at all: nothing.
    opened = null; build()
    expect(code(inspect())).toBe('BROWSER_LINE_NOT_APPROVED')
  })

  it('the site setting, the AI stop and the grant, in this order; a grant given before the member left and came back does not count', () => {
    policy = { mode: 'off', sites: [{ host: HOST, level: 'read', assetHosts: [] }] }
    expect(code(inspect())).toBe('BROWSER_NOT_ALLOWED')
    policy = { mode: 'on', sites: [{ host: 'other.example', level: 'delete', assetHosts: [] }] }
    expect(code(inspect())).toBe('BROWSER_NOT_ALLOWED')
    policy = { mode: 'on', sites: [{ host: HOST, level: 'read', assetHosts: [] }] }
    stops = { all: false, tools: ['web'] }
    expect(code(inspect())).toBe('BROWSER_AI_STOPPED')
    stops = { all: false, tools: [] }
    expect(code(inspect(bob))).toBe('BROWSER_TYPE_NOT_GRANTED')
    // Alice leaves and is invited back: her old grant is not hers this time.
    conn.prepare('UPDATE memberships SET created_at = ? WHERE company_id = ? AND user_id = ?').run(iso(T0 + 1000), CO, alice.userId)
    expect(code(inspect())).toBe('BROWSER_TYPE_NOT_GRANTED')
  })

  it('a grant carries to a new mechanics hash only when the row names the old one in its reviewed grantsFrom (Q15)', () => {
    const line = realLine()
    const old = fileWith([{ line }]).lines[0]
    const moved = fileWith([{ line }, { line, mechanicsOf: { readersHash: `sha256:${'9'.repeat(64)}` } }])
    const newRow = moved.lines[1]
    expect(newRow.meaningHash).toBe(old.meaningHash)
    expect(newRow.mechanicsHash).not.toBe(old.mechanicsHash)
    // Alice was granted on the old mechanics only.
    opened = fileWith([{ line }]); build(); grant(alice, old)
    opened = moved; build()
    expect(code(inspect(alice, VALUES, newRow))).toBe('BROWSER_TYPE_NOT_GRANTED')
    const carried = fileWith([{ line }, { line, mechanicsOf: { readersHash: `sha256:${'9'.repeat(64)}` }, grantsFrom: [old.mechanicsHash] }])
    opened = carried; build()
    expect(code(inspect(alice, VALUES, carried.lines[1]))).toBe('ok')
    // The grants read says what is in force and where each came from.
    expect(value(svc.grants(owner)).grants.filter(g => g.userId === alice.userId).map(g => [g.mechanicsHash, g.from.kind])).toEqual([
      [old.mechanicsHash, 'direct'], [carried.lines[1].mechanicsHash, 'carried'],
    ])
    // One untick on the new row takes the carried grant away too (nothing stays in force behind the admin's back).
    value(svc.setGrant(owner, alice.userId, { site: 'lstep', line: 'landing_inspect', meaningHash: carried.lines[1].meaningHash, mechanicsHash: carried.lines[1].mechanicsHash, allowed: false }))
    expect(code(inspect(alice, VALUES, carried.lines[1]))).toBe('BROWSER_TYPE_NOT_GRANTED')
    expect(code(inspect(alice, VALUES, old))).toBe('BROWSER_TYPE_NOT_GRANTED')
    expect(value(svc.grants(owner)).grants).toEqual([])
    // grantsFrom naming a hash no row of the same meaning has: the row is left out.
    const bogus = fileWith([{ line }, { line, mechanicsOf: { readersHash: `sha256:${'9'.repeat(64)}` }, grantsFrom: [`sha256:${'7'.repeat(64)}`] }])
    opened = bogus; build()
    expect(code(inspect(alice, VALUES, bogus.lines[1]))).toBe('BROWSER_LINE_NOT_APPROVED')
  })

  it('grants: owners / admins only, only for an approved row exactly; leaving takes them away', () => {
    expect(svc.grants(alice).ok).toBe(false)
    expect(svc.setGrant(alice, bob.userId, { ...refOf(approvedRow()), allowed: true }).ok).toBe(false)
    const pending = pendingRow()
    expect(code(svc.setGrant(admin, bob.userId, { site: 'lstep', line: pending.name, meaningHash: pending.meaningHash, mechanicsHash: pending.mechanicsHash, allowed: true }))).toBe('BROWSER_LINE_NOT_APPROVED')
    expect(value(svc.grants(admin)).lines.map(l => [l.line, l.mapVersion])).toEqual([['landing_inspect', '1.0.1'], ['landing_inspect', '1.0.2'], ['landing_inspect', '1.0.4']])
    svc.memberLeft(CO, alice.userId)
    expect(value(svc.grants(owner)).grants).toEqual([])
  })
})

describe('where a value comes from (§16-4, Q14)', () => {
  // The real line with a `which` date the business plugin's check compares (a made-up line on the real map).
  function lineWithWhich(from: string[]): BrowserOpenedLine {
    const line = realLine()
    line.name = 'landing_dated'
    ;(line.read.values as Record<string, unknown>).round = { kind: 'date', role: 'which', from }
    ;(line.read.checks as unknown[]).push({ word: 'date_in_text', read: 'landing', field: 'name', date: 'round', format: 'YYYYMMDD' })
    return line
  }
  it('a target from the AI is refused; a which value from a person only once confirmed; a record field not yet; never the AI', () => {
    expect(code(inspect(alice, { landing: { value: '501', from: { kind: 'ai' } }, source: site('400') }))).toBe('BROWSER_VALUE_REFUSED')
    // A value missing, extra or of the wrong kind.
    expect(code(inspect(alice, { landing: site('501') }))).toBe('BROWSER_VALUE_REFUSED')
    expect(code(inspect(alice, { ...VALUES, extra: site('1') }))).toBe('BROWSER_VALUE_REFUSED')
    expect(code(inspect(alice, { landing: site('a b'), source: site('400') }))).toBe('BROWSER_VALUE_REFUSED')
    const f = fileWith([{ line: lineWithWhich(['record_field', 'person']) }])
    opened = f; build(); grant(alice, f.lines[0])
    const dated = (round: unknown) => inspect(alice, { ...VALUES, round }, f.lines[0])
    expect(code(dated({ value: '2026-12-03', from: { kind: 'person', confirmed: false } }))).toBe('BROWSER_VALUE_UNCONFIRMED')
    expect(code(dated({ value: '2026-12-03', from: { kind: 'person', confirmed: true } }))).toBe('ok')
    expect(code(dated({ value: '2026-12-03', from: { kind: 'record_field', aiWroteLast: false } }))).toBe('BROWSER_VALUE_SOURCE_NOT_YET')
    expect(code(dated({ value: '2026-12-03', from: { kind: 'ai' } }))).toBe('BROWSER_VALUE_REFUSED')
    expect(code(dated({ value: '2026-12-03', from: { kind: 'site_fact' } }))).toBe('BROWSER_VALUE_REFUSED')
  })
})

describe('an inspection', () => {
  const allOk = { reads: { landing: 'ok', landing_row: 'ok', action_set: 'ok', source: 'ok', source_action_set: 'ok' }, checks: ['ok', 'ok', 'ok', 'ok'] }
  it('its result is kept once, as fixed words, and the server says whether everything counted', () => {
    const p = value(inspect())
    const done = value(svc.result(alice, p.id, allOk))
    expect(done.state).toBe('done')
    expect(done.result).toEqual({ state: 'all_ok', ...allOk })
    expect(code(svc.result(alice, p.id, allOk))).toBe('BROWSER_RESULT_DONE')
    const raw = conn.prepare('SELECT result FROM browser_line_plans WHERE id = ?').get(p.id) as { result: string }
    expect(JSON.parse(raw.result)).toEqual({ state: 'all_ok', ...allOk })
    const ng = value(inspect())
    expect(value(svc.result(alice, ng.id, { ...allOk, checks: ['ok', 'ng', 'ok', 'ok'] })).result?.state).toBe('ng')
    const notRead = value(inspect())
    expect(value(svc.result(alice, notRead.id, { reads: { ...allOk.reads, landing_row: 'not-read' }, checks: ['ok', 'ok', 'ok', 'ok'] })).result?.state).toBe('not_read')
  })

  it('a result that is not the line\'s words, or a ✓ for a check whose read did not count, is refused', () => {
    const p = value(inspect())
    const bad = (body: unknown) => code(svc.result(alice, p.id, body))
    expect(bad({ ...allOk, checks: ['ok', 'ok', 'ok'] })).toBe('BROWSER_BAD_RESULT')
    expect(bad({ ...allOk, checks: ['ok', 'ok', 'ok', 'later'] })).toBe('BROWSER_BAD_RESULT')
    expect(bad({ reads: { ...allOk.reads, landing: '流入経路A' }, checks: allOk.checks })).toBe('BROWSER_BAD_RESULT')
    expect(bad({ reads: { ...allOk.reads, extra: 'ok' }, checks: allOk.checks })).toBe('BROWSER_BAD_RESULT')
    expect(bad({ ...allOk, values: { name: 'x' } })).toBe('BROWSER_BAD_RESULT')
    // The source not read whole, yet check 1 (landing vs source) said ✓.
    expect(bad({ reads: { ...allOk.reads, source: 'not-read' }, checks: ['ok', 'ok', 'ok', 'ok'] })).toBe('BROWSER_BAD_RESULT')
    expect(value(svc.get(alice, p.id)).state).toBe('open')
  })

  it('after its hour it closes and takes no result; another member\'s or company\'s plan is one that does not exist', () => {
    const p = value(inspect())
    expect(code(svc.get(bob, p.id))).toBe('BROWSER_PLAN_NOT_FOUND')
    expect(code(svc.get({ ...alice, companyId: OTHER_CO }, p.id))).toBe('BROWSER_PLAN_NOT_FOUND')
    expect(code(svc.result(bob, p.id, allOk))).toBe('BROWSER_PLAN_NOT_FOUND')
    now += 60 * 60_000
    expect(code(svc.result(alice, p.id, allOk))).toBe('BROWSER_PLAN_EXPIRED')
    expect(value(svc.get(alice, p.id)).closeReason).toBe('expired')
  })

  it('cancel closes it; leaving closes it', () => {
    const p = value(inspect())
    expect(value(svc.cancel(alice, p.id)).closeReason).toBe('cancelled')
    const q = value(inspect())
    svc.memberLeft(CO, alice.userId)
    expect(conn.prepare('SELECT state, close_reason FROM browser_line_plans WHERE id = ?').get(q.id)).toEqual({ state: 'closed', close_reason: 'left' })
  })

  it('the fixed content and the result never change once written (trigger)', () => {
    const p = value(inspect())
    expect(() => conn.prepare("UPDATE browser_line_plans SET content = '{}' WHERE id = ?").run(p.id)).toThrow(/never changes/)
    value(svc.result(alice, p.id, allOk))
    expect(() => conn.prepare("UPDATE browser_line_plans SET result = '{}' WHERE id = ?").run(p.id)).toThrow(/never changes/)
  })
})

describe('no plan of writes in this build', () => {
  it('a write plan in the database (as a later build would leave one) is never approved, claimed or permitted: the line holds no write', () => {
    policy = { mode: 'on', sites: [{ host: HOST, level: 'write', assetHosts: [] }] }
    const p = insertWritePlan('draft')
    expect(code(svc.approve(alice, p.id, { contentHash: p.contentHash }))).toBe('BROWSER_LINE_WRITES_NOT_YET')
    const a = insertWritePlan('approved')
    expect(code(svc.claim(alice, a.id))).toBe('BROWSER_LINE_WRITES_NOT_YET')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_line_executions').get()).toEqual({ n: 0 })
  })
})

describe('a line that writes (generalization PR 6)', () => {
  it('is never made an inspection, even approved and granted (it would pass the 「見るだけ」 gate)', () => {
    const writing = JSON.parse(JSON.stringify(REAL_OPENED)) as BrowserOpenedFile
    const row = writing.lines.find(l => l.name === 'step_template_add')!
    expect(row.status).toBe('pending')
    row.status = 'approved'
    opened = writing; build(); grant(alice, row)
    const values = { reminder: site('7100002'), step: site('7200003'), template_folder: site('7300004'), template: site('7400005') }
    expect(code(inspect(alice, values, row))).toBe('BROWSER_LINE_WRITES_NOT_YET')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_line_plans').get()).toEqual({ n: 0 })
  })
  it('as written today it is pending: refused before anything else', () => {
    const row = REAL_OPENED.lines.find(l => l.name === 'step_template_add')!
    expect(code(inspect(alice, {}, row))).toBe('BROWSER_LINE_NOT_APPROVED')
  })
})

describe('the strict read\'s notice (§16-1)', () => {
  const notice = (over: Record<string, unknown> = {}) => ({ site: 'lstep', mapVersion: '1.0.1', thing: 'landing', change: 'unknown_keys', count: 2, ...over })
  const told = () => conn.prepare("SELECT user_id, dedupe_key FROM notifications WHERE kind = 'browser_shape_changed' ORDER BY user_id").all()

  it('one notice per company × site × version × thing; every owner / admin told once, no member; no key name anywhere', () => {
    expect(value(svc.shapeNotice(alice, notice()))).toEqual({ told: true })
    expect(value(svc.shapeNotice(alice, notice({ change: 'missing_keys', count: 1 })))).toEqual({ told: false })
    expect(told()).toEqual([
      { user_id: admin.userId, dedupe_key: 'browser_shape:lstep:1.0.1:landing' },
      { user_id: owner.userId, dedupe_key: 'browser_shape:lstep:1.0.1:landing' },
    ])
    const [n] = value(svc.shapeNotices(admin)).items
    expect(n).toMatchObject({ thing: 'landing', thingLabel: '流入経路', unknownKeys: 2, missingKeys: 1, reports: 2 })
    expect(svc.noticeText(owner, 'browser_shape:lstep:1.0.1:landing')).toBe('ブラウザ操作：「Lステップ」の「流入経路」の形が変わりました（知らない項目が2つ増えた・あるはずの項目が1つない）。メンバーには手で作業してもらっています。地図の確かめが要ります')
    expect(svc.noticeText(alice, 'browser_shape:lstep:1.0.1:landing')).toBeNull()
    expect(svc.shapeNotices(alice).ok).toBe(false)
  })

  it('a key name cannot be sent: only the map\'s names, a fixed kind, a count', () => {
    expect(code(svc.shapeNotice(alice, { ...notice(), keys: ['customer_12345'] }))).toBe('BROWSER_BAD_NOTICE')
    expect(code(svc.shapeNotice(alice, notice({ thing: 'customer_12345' })))).toBe('BROWSER_BAD_NOTICE')
    expect(code(svc.shapeNotice(alice, notice({ change: 'customer_12345' })))).toBe('BROWSER_BAD_NOTICE')
    expect(code(svc.shapeNotice(alice, notice({ mapVersion: '9.9.9' })))).toBe('BROWSER_BAD_NOTICE')
    // A map no approved line uses (1.0.0: its line is pending).
    expect(code(svc.shapeNotice(alice, notice({ mapVersion: '1.0.0' })))).toBe('BROWSER_BAD_NOTICE')
    expect(code(svc.shapeNotice(alice, notice({ count: 0 })))).toBe('BROWSER_BAD_NOTICE')
    expect(code(svc.shapeNotice(alice, notice({ count: 2.5 })))).toBe('BROWSER_BAD_NOTICE')
    expect(told()).toEqual([])
  })

  it('only a member who may use the site and holds a grant on one of its lines; limits per member a day', () => {
    expect(code(svc.shapeNotice(bob, notice()))).toBe('BROWSER_TYPE_NOT_GRANTED')
    policy = { mode: 'off', sites: [] }
    expect(code(svc.shapeNotice(alice, notice()))).toBe('BROWSER_TYPE_NOT_GRANTED')
    policy = { mode: 'on', sites: [{ host: HOST, level: 'read', assetHosts: [] }] }
    for (let i = 0; i < BROWSER_SHAPE_NOTICE_LIMITS.perMemberSiteDay; i++) expect(svc.shapeNotice(alice, notice()).ok).toBe(true)
    expect(code(svc.shapeNotice(alice, notice()))).toBe('BROWSER_NOTICE_LIMIT')
    // Refused reports are not counted: one member past their limit never uses up the company's (Codex review).
    for (let i = 0; i < 300; i++) svc.shapeNotice(alice, notice())
    grant(bob)
    expect(svc.shapeNotice(bob, notice()).ok).toBe(true)
    expect(conn.prepare('SELECT SUM(count) AS n FROM browser_shape_report_counts').get()).toEqual({ n: BROWSER_SHAPE_NOTICE_LIMITS.perMemberSiteDay + 1 })
    now += 86_400_000
    expect(svc.shapeNotice(alice, notice()).ok).toBe(true)
  })
})

// --- the write state table (the steps module; unreachable through the routes in this build) --------------------------------

const steps = () => createBrowserLineSteps({ companyData: data, clock, monotonic, ids })
const allow = () => null
const WRITES: BrowserLineWritesContent = {
  writes: [{ kind: 'create', thing: 'landing', idField: 'id' }, { kind: 'change', thing: 'landing', idField: 'id', on: { created: 1 } }, { kind: 'change', thing: 'action_set', idField: 'id' }],
  locks: ['lock-folder-9', 'lock-existing-E'], host: HOST, account: '90171', site: 'lstep', company: CO,
}
function insertWritePlan(state: BrowserLinePlanRow['state'], writes = 3): BrowserLinePlanRow {
  const row = approvedRow()
  // The fixed content as a writing build would hold it (shape 2: the line, the values, the writes, their locks).
  const content = canonicalJson({
    shape: 2, company: CO, user: alice.userId, conversation: null, line: refOf(row), values: VALUES, writes: WRITES.writes.slice(0, writes),
    locks: WRITES.locks, site: 'lstep', host: HOST, account: WRITES.account, createdAt: iso(now), expiresAt: iso(now + 3_600_000),
  })
  const p: BrowserLinePlanRow = {
    id: `bl_${randomBytes(16).toString('hex')}`, userId: alice.userId, shape: 2, site: 'lstep', lineName: row.name, lineVersion: row.version, mapVersion: row.mapVersion,
    meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash, writes, content, contentHash: hashCanonical(content), state, closeReason: null,
    createdAt: iso(now), expiresAt: iso(now + 3_600_000), approvedAt: state === 'draft' ? null : iso(now), closedAt: null, conversationId: null, result: null, reportedAt: null,
  }
  data.forCompany(CO).browserLines.insertPlan(p)
  return p
}
/** A claimed execution of a plan of writes; each its own objects (locks) unless `locks` is given. */
function claimed(writes = 3, locks?: string[]) {
  const p = insertWritePlan('approved', writes)
  const s = steps()
  const content = { ...WRITES, writes: WRITES.writes.slice(0, writes), locks: locks ?? [`lock-folder-${p.id}`, `lock-existing-${p.id}`] }
  const c = value(s.claim(CO, p, content, 'hash-' + p.id, now))
  return { s, p: data.forCompany(CO).browserLines.plan(p.id)!, id: c.executionId, content }
}
const execOf = (id: string) => data.forCompany(CO).browserLines.execution(id)!
const stepStates = (id: string) => data.forCompany(CO).browserLines.steps(id).map(s => s.state)
const locksOf = (id: string) => (conn.prepare('SELECT lock_key FROM browser_line_locks WHERE execution_id = ? ORDER BY lock_key').all(id) as Array<{ lock_key: string }>).map(r => r.lock_key)

describe('executions with several writes: the state table', () => {
  it('claim takes every lock and makes one pending row per write; a key held on either path is busy', () => {
    const c = claimed(3, ['lock-folder-9', 'lock-existing-E'])
    expect(execOf(c.id).state).toBe('claimed')
    expect(stepStates(c.id)).toEqual(['pending', 'pending', 'pending'])
    expect(locksOf(c.id)).toEqual(['lock-existing-E', 'lock-folder-9'])
    const again = insertWritePlan('approved')
    expect(code(steps().claim(CO, again, WRITES, 'h2', now))).toBe('BROWSER_TARGET_BUSY')
    // The old path holding the key (one object, one key, C11).
    conn.prepare(`INSERT INTO browser_plans (company_id, id, user_id, connector_id, connector_version, operation, declaration_hash, checker_hash, facts_version, account, content, content_hash, state, created_at, expires_at)
      VALUES (?, 'bp_old', ?, 'lstep', '0.6.3', 'op', 'h', 'h', 2, 'a', '{}', 'h', 'claimed', ?, ?)`).run(CO, bob.userId, iso(now), iso(now + 3_600_000))
    conn.prepare(`INSERT INTO browser_executions (company_id, id, plan_id, user_id, secret_hash, lock_key, state, claimed_at) VALUES (?, 'bx_old', 'bp_old', ?, 'oldsecret', 'lock-old-X', 'claimed', ?)`).run(CO, bob.userId, iso(now))
    conn.prepare("INSERT INTO browser_target_locks (company_id, lock_key, execution_id, created_at) VALUES (?, 'lock-old-X', 'bx_old', ?)").run(CO, iso(now))
    const third = insertWritePlan('approved')
    expect(code(steps().claim(CO, third, { ...WRITES, locks: ['lock-old-X'] }, 'h3', now))).toBe('BROWSER_TARGET_BUSY')
    expect(data.forCompany(CO).browserLines.plan(third.id)!.state).toBe('approved')
  })

  it('write k only after write k−1 was reported done; once per write; never out of order', () => {
    const { s, p, id, content } = claimed()
    expect(code(s.permit(CO, execOf(id), p, content, 2, allow, now))).toBe('BROWSER_LINE_NOT_IN_ORDER')
    const one = value(s.permit(CO, execOf(id), p, content, 1, allow, now))
    expect(one.createdTarget).toBeNull()
    expect(execOf(id).state).toBe('running')
    expect(code(s.permit(CO, execOf(id), p, content, 1, allow, now))).toBe('BROWSER_PERMIT_USED')
    expect(code(s.permit(CO, execOf(id), p, content, 2, allow, now))).toBe('BROWSER_LINE_NOT_YET')
    expect(code(s.permit(CO, execOf(id), p, content, 3, allow, now))).toBe('BROWSER_LINE_NOT_IN_ORDER')
    // A create is done only with what it created; that id is recorded, its lock taken, and the next write bound to it.
    expect(code(s.report(CO, execOf(id), p, content, { index: 1, result: 'done', reason: null, createdId: null }, now))).toBe('BROWSER_BAD_REPORT')
    expect(value(s.report(CO, execOf(id), p, content, { index: 1, result: 'done', reason: null, createdId: '7001' }, now)).step).toBe('done')
    const createdKey = browserObjectLockKey({ company: CO, host: HOST, account: '90171', site: 'lstep', thing: 'landing', id: { field: 'id', value: '7001' } })
    expect(locksOf(id)).toContain(createdKey)
    expect(value(s.permit(CO, execOf(id), p, content, 2, allow, now)).createdTarget).toBe('7001')
    value(s.report(CO, execOf(id), p, content, { index: 2, result: 'done', reason: null, createdId: null }, now))
    value(s.permit(CO, execOf(id), p, content, 3, allow, now))
    expect(value(s.report(CO, execOf(id), p, content, { index: 3, result: 'done', reason: null, createdId: null }, now)).state).toBe('succeeded')
    expect(stepStates(id)).toEqual(['done', 'done', 'done'])
    expect(locksOf(id)).toEqual([])
    expect(data.forCompany(CO).browserLines.plan(p.id)!.state).toBe('done')
  })

  it('not sent: write 1 → failed, a later one → partial; the rest skipped, the locks gone', () => {
    const a = claimed()
    value(a.s.permit(CO, execOf(a.id), a.p, a.content, 1, allow, now))
    expect(value(a.s.report(CO, execOf(a.id), a.p, a.content, { index: 1, result: 'not_sent', reason: 'permit-late', createdId: null }, now)).state).toBe('failed')
    expect(stepStates(a.id)).toEqual(['not_sent', 'skipped', 'skipped'])
    const b = claimed()
    value(b.s.permit(CO, execOf(b.id), b.p, b.content, 1, allow, now))
    value(b.s.report(CO, execOf(b.id), b.p, b.content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))
    value(b.s.permit(CO, execOf(b.id), b.p, b.content, 2, allow, now))
    expect(value(b.s.report(CO, execOf(b.id), b.p, b.content, { index: 2, result: 'not_sent', reason: null, createdId: null }, now)).state).toBe('partial')
    expect(stepStates(b.id)).toEqual(['done', 'not_sent', 'skipped'])
    expect(locksOf(b.id)).toEqual([])
  })

  it('unknown ends the run for good: the rest skipped, nothing permitted after it, the locks kept; a late sure done ends it (never running again)', () => {
    const { s, p, id, content } = claimed()
    value(s.permit(CO, execOf(id), p, content, 1, allow, now))
    value(s.report(CO, execOf(id), p, content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))
    value(s.permit(CO, execOf(id), p, content, 2, allow, now))
    expect(value(s.report(CO, execOf(id), p, content, { index: 2, result: 'unknown', reason: 'no-answer', createdId: null }, now)).state).toBe('unknown')
    expect(stepStates(id)).toEqual(['done', 'unknown', 'skipped'])
    expect(code(s.permit(CO, execOf(id), p, content, 3, allow, now))).toBe('BROWSER_LINE_AFTER_UNKNOWN')
    expect(locksOf(id).length).toBe(3)
    // The same report again is the same; a late sure "done" for that write ends the execution partial (write 3 never tried).
    expect(value(s.report(CO, execOf(id), p, content, { index: 2, result: 'unknown', reason: null, createdId: null }, now)).outcome).toBe('same')
    expect(value(s.report(CO, execOf(id), p, content, { index: 2, result: 'done', reason: null, createdId: null }, now)).state).toBe('partial')
    expect(stepStates(id)).toEqual(['done', 'done', 'skipped'])
    expect(locksOf(id)).toEqual([])
    expect(code(s.permit(CO, execOf(id), p, content, 3, allow, now))).toBe('BROWSER_EXECUTION_CLOSED')
  })

  it('a report names its write and moves no other; one for a write never permitted is a conflict (kept); a contradicting one too', () => {
    const { s, p, id, content } = claimed()
    value(s.permit(CO, execOf(id), p, content, 1, allow, now))
    expect(code(s.report(CO, execOf(id), p, content, { index: 2, result: 'done', reason: null, createdId: null }, now))).toBe('BROWSER_REPORT_CONFLICT')
    expect(stepStates(id)).toEqual(['permitted', 'pending', 'pending'])
    value(s.report(CO, execOf(id), p, content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))
    expect(code(s.report(CO, execOf(id), p, content, { index: 1, result: 'not_sent', reason: null, createdId: null }, now))).toBe('BROWSER_REPORT_CONFLICT')
    expect(code(s.report(CO, execOf(id), p, content, { index: 1, result: 'done', reason: null, createdId: '9' }, now))).toBe('BROWSER_REPORT_CONFLICT')
    expect(value(s.report(CO, execOf(id), p, content, { index: 1, result: 'done', reason: null, createdId: '8' }, now)).outcome).toBe('same')
    expect(data.forCompany(CO).browserLines.reports(id).map(r => [r.index, r.outcome])).toEqual([[2, 'conflict'], [1, 'applied'], [1, 'conflict'], [1, 'conflict'], [1, 'same']])
    expect(() => conn.prepare("UPDATE browser_line_reports SET outcome = 'same'").run()).toThrow(/append-only/)
  })

  it('a write\'s state never moves backwards (trigger)', () => {
    const { s, p, id, content } = claimed()
    value(s.permit(CO, execOf(id), p, content, 1, allow, now))
    expect(() => conn.prepare("UPDATE browser_execution_steps SET state = 'pending' WHERE execution_id = ? AND idx = 1").run(id)).toThrow(/backwards/)
    expect(() => conn.prepare("UPDATE browser_execution_steps SET state = 'done' WHERE execution_id = ? AND idx = 2").run(id)).toThrow(/backwards/)
  })

  it('the gate refusing: claimed → void (the writes stay pending); running with nothing open → partial (the rest skipped)', () => {
    const refuseIt = () => ({ ok: false as const, kind: 'conflict' as const, body: { error: 'x', code: 'BROWSER_AI_STOPPED' } })
    const a = claimed()
    expect(code(a.s.permit(CO, execOf(a.id), a.p, a.content, 1, refuseIt, now))).toBe('BROWSER_AI_STOPPED')
    expect(execOf(a.id)).toMatchObject({ state: 'void', voidReason: 'BROWSER_AI_STOPPED' })
    expect(stepStates(a.id)).toEqual(['pending', 'pending', 'pending'])
    expect(locksOf(a.id)).toEqual([])
    const b = claimed()
    value(b.s.permit(CO, execOf(b.id), b.p, b.content, 1, allow, now))
    value(b.s.report(CO, execOf(b.id), b.p, b.content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))
    expect(code(b.s.permit(CO, execOf(b.id), b.p, b.content, 2, refuseIt, now))).toBe('BROWSER_AI_STOPPED')
    expect(execOf(b.id).state).toBe('partial')
    expect(stepStates(b.id)).toEqual(['done', 'skipped', 'skipped'])
  })

  it('time: 2 minutes without a permit → void; a write silent past its own window on both clocks → unknown; a gap past the run\'s limit → partial', () => {
    const a = claimed()
    now += 2 * 60_000
    expect(a.s.settle(CO, execOf(a.id), a.p, now).state).toBe('void')
    expect(stepStates(a.id)).toEqual(['pending', 'pending', 'pending'])
    const b = claimed()
    value(b.s.permit(CO, execOf(b.id), b.p, b.content, 1, allow, now))
    value(b.s.report(CO, execOf(b.id), b.p, b.content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))
    now += 30_000; monoBase -= 0
    value(b.s.permit(CO, execOf(b.id), b.p, b.content, 2, allow, now))
    // 35 s from write 1's permit but not from write 2's: still permitted (the window is this write's own).
    now += 6_000
    expect(b.s.settle(CO, execOf(b.id), b.p, now).state).toBe('running')
    // The wall clock jumping forward alone never opens it.
    now += 60_000; monoBase += 60_000
    expect(b.s.settle(CO, execOf(b.id), b.p, now).state).toBe('running')
    now += 30_000
    expect(b.s.settle(CO, execOf(b.id), b.p, now).state).toBe('unknown')
    expect(stepStates(b.id)).toEqual(['done', 'unknown', 'skipped'])
    const c = claimed()
    value(c.s.permit(CO, execOf(c.id), c.p, c.content, 1, allow, now))
    value(c.s.report(CO, execOf(c.id), c.p, c.content, { index: 1, result: 'done', reason: null, createdId: '9' }, now))
    now += 2 * 60_000
    expect(c.s.settle(CO, execOf(c.id), c.p, now).state).toBe('partial')
    expect(stepStates(c.id)).toEqual(['done', 'skipped', 'skipped'])
    expect(locksOf(c.id)).toEqual([])
  })

  it('confirm: only the unknown write, only past its own window, never with the clock behind; then the locks go and nothing more moves', () => {
    const { s, p, id, content } = claimed()
    value(s.permit(CO, execOf(id), p, content, 1, allow, now))
    value(s.report(CO, execOf(id), p, content, { index: 1, result: 'unknown', reason: null, createdId: null }, now))
    expect(code(s.confirm(CO, execOf(id), p, 2, 'done', alice.userId, now))).toBe('BROWSER_NOT_PERMITTED')
    expect(code(s.confirm(CO, execOf(id), p, 1, 'not_done', alice.userId, now))).toBe('BROWSER_TOO_EARLY')
    expect(code(s.confirm(CO, execOf(id), p, 1, 'not_done', alice.userId, now - 1000))).toBe('BROWSER_CLOCK_BACKWARDS')
    now += 35_000
    expect(value(s.confirm(CO, execOf(id), p, 1, 'not_done', alice.userId, now)).state).toBe('confirmed_not_done')
    expect(locksOf(id)).toEqual([])
    expect(code(s.confirm(CO, execOf(id), p, 1, 'done', alice.userId, now))).toBe('BROWSER_ALREADY_SETTLED')
    expect(code(s.report(CO, execOf(id), p, content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))).toBe('BROWSER_REPORT_CONFLICT')
    expect(execOf(id).state).toBe('confirmed_not_done')
  })

  it('giving the rest back: claimed → void, running with nothing open → partial, a write open → refused (it may have been sent)', () => {
    const a = claimed()
    value(a.s.giveBack(CO, execOf(a.id), a.p, 'cancelled', now))
    expect(execOf(a.id).state).toBe('void')
    const b = claimed()
    value(b.s.permit(CO, execOf(b.id), b.p, b.content, 1, allow, now))
    expect(code(b.s.giveBack(CO, execOf(b.id), b.p, 'cancelled', now))).toBe('BROWSER_MAY_HAVE_SENT')
    value(b.s.report(CO, execOf(b.id), b.p, b.content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))
    value(b.s.giveBack(CO, execOf(b.id), b.p, 'cancelled', now))
    expect(execOf(b.id).state).toBe('partial')
    expect(stepStates(b.id)).toEqual(['done', 'skipped', 'skipped'])
  })
})

describe('one lock key on both paths (C11)', () => {
  it('a map thing\'s key is byte-equal to the old path\'s key for the same object', () => {
    const old = browserLockKey({ company: CO, host: HOST, account: '90171', kind: 'lstep.reminder_step', fields: { reminder: 'id', step: 'id' }, target: { reminder: '11', step: '22' } })
    const fresh = browserObjectLockKey({ company: CO, host: HOST, account: '90171', site: 'lstep', thing: 'reminder_step', id: { field: 'step', value: '22' }, parent: { field: 'reminder', value: '11' } })
    expect(fresh).toBe(old)
  })
})

describe('the rollback floor (deployment.md): rows a writing build leaves, read by a build that does not know its line', () => {
  it('running, unknown and partial executions: no permit, reports still kept and settling, confirm works, locks held until final', () => {
    policy = { mode: 'on', sites: [{ host: HOST, level: 'write', assetHosts: [] }] }
    // A "later build" left: one running between writes, one unknown, one partial.
    const running = claimed(); value(running.s.permit(CO, execOf(running.id), running.p, running.content, 1, allow, now))
    value(running.s.report(CO, execOf(running.id), running.p, running.content, { index: 1, result: 'done', reason: null, createdId: '8' }, now))
    const unknown = claimed(); value(unknown.s.permit(CO, execOf(unknown.id), unknown.p, unknown.content, 1, allow, now))
    value(unknown.s.report(CO, execOf(unknown.id), unknown.p, unknown.content, { index: 1, result: 'unknown', reason: null, createdId: null }, now))
    // This build (no line that writes) serves them now through its routes' service.
    const secretOf = (id: string) => { const s = randomBytes(32).toString('hex'); conn.prepare('DROP TRIGGER browser_line_executions_fixed').run(); conn.prepare('UPDATE browser_line_executions SET secret_hash = ? WHERE id = ?').run(sha256TokenDigest.digest(s), id); initDatabase(conn); return s }
    const runSecret = secretOf(running.id)
    expect(code(svc.permit(alice, running.id, runSecret, { index: 2 }))).toBe('BROWSER_LINE_WRITES_NOT_YET')
    expect(execOf(running.id).state).toBe('partial')
    expect(stepStates(running.id)).toEqual(['done', 'skipped', 'skipped'])
    const unknownSecret = secretOf(unknown.id)
    expect(code(svc.permit(alice, unknown.id, unknownSecret, { index: 2 }))).toBe('BROWSER_LINE_AFTER_UNKNOWN')
    expect(locksOf(unknown.id).length).toBe(2)
    // Its late report still lands (the secret alone), and ends it; a reason not of the one list is not kept.
    expect(value(svc.report(unknownSecret, { index: 1, result: 'done', createdId: '5', reason: 'tanaka-taro-0901234' })).state).toBe('partial')
    expect(data.forCompany(CO).browserLines.reports(unknown.id).map(r => r.reason)).toEqual([null, null])
    value(svc.report(unknownSecret, { index: 1, result: 'done', createdId: '5', reason: 'no-answer' }))
    expect(data.forCompany(CO).browserLines.reports(unknown.id).map(r => r.reason)).toEqual([null, null, 'no-answer'])
    expect(locksOf(unknown.id)).toEqual([])
  })

  it('a plan of a shape this build does not know is frozen: not read, claimed, permitted or confirmed; a report kept and answered 409; its locks kept; leaving leaves it', () => {
    const { id, p } = claimed()
    conn.prepare('DROP TRIGGER browser_line_plans_fixed').run()
    conn.prepare('UPDATE browser_line_plans SET shape = 3 WHERE id = ?').run(p.id)
    initDatabase(conn)
    const secret = randomBytes(32).toString('hex')
    conn.prepare('DROP TRIGGER browser_line_executions_fixed').run()
    conn.prepare('UPDATE browser_line_executions SET secret_hash = ? WHERE id = ?').run(sha256TokenDigest.digest(secret), id)
    initDatabase(conn)
    expect(code(svc.get(alice, p.id))).toBe('BROWSER_PLAN_FROZEN')
    expect(code(svc.cancel(alice, p.id))).toBe('BROWSER_PLAN_FROZEN')
    expect(code(svc.permit(alice, id, secret, { index: 1 }))).toBe('BROWSER_PLAN_FROZEN')
    expect(code(svc.confirm(alice, id, { index: 1, result: 'done' }))).toBe('BROWSER_PLAN_FROZEN')
    expect(code(svc.report(secret, { index: 1, result: 'done', createdId: '1' }))).toBe('BROWSER_PLAN_FROZEN')
    expect(data.forCompany(CO).browserLines.reports(id).map(r => r.outcome)).toEqual(['conflict'])
    // An open inspection of that unknown shape too: leaving leaves both as they are.
    const open = value(inspect())
    conn.prepare('DROP TRIGGER browser_line_plans_fixed').run()
    conn.prepare('UPDATE browser_line_plans SET shape = 3 WHERE id = ?').run(open.id)
    initDatabase(conn)
    now += 10 * 60_000
    svc.memberLeft(CO, alice.userId)
    expect(conn.prepare('SELECT state FROM browser_line_plans WHERE id = ?').get(open.id)).toEqual({ state: 'open' })
    expect(execOf(id).state).toBe('claimed')
    expect(locksOf(id).length).toBe(2)
  })
})

describe('leaving the company', () => {
  it('a claimed write execution becomes void, a running one with nothing open partial, one with a write open stays with its locks', () => {
    const a = claimed()
    const b = claimed(); value(b.s.permit(CO, execOf(b.id), b.p, b.content, 1, allow, now))
    svc.memberLeft(CO, alice.userId)
    expect(execOf(a.id).state).toBe('void')
    expect(execOf(b.id).state).toBe('running')
    expect(locksOf(b.id).length).toBe(2)
  })
})
