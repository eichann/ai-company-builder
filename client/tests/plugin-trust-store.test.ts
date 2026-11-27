/**
 * Plugin trust P2 in the app (`.claude/rules/plugin-trust.md` "P2"): the trust record and halt file
 * under `<userData>/trust/` (`features/plugins/trust-store.ts`), the app's trust state and its
 * refresh (`trust.ts`), the policy marker that starts a refresh (`agent-control/wire.ts`), and the
 * release build's root check (`trust-roots.ts`). Fixtures are P1's (real `ssh-keygen`, test keys
 * only); every test passes its own clock. Each guard is mutation-checked (the rule lists them).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodePluginTrustCrypto as C } from '../electron/features/plugins/trust-crypto'
import { createPluginTrust, type RefreshOutcome } from '../electron/features/plugins/trust'
import { createTrustFiles, TRUST_HALT_FILE, TRUST_RECORD_FILE, TRUST_UNUSABLE_FILE, type TrustFs } from '../electron/features/plugins/trust-store'
import { RELEASE_REQUIRES_PRODUCTION_ROOT, bakedTrustRoot, carriedTrustRoot, releaseTrustRootProblem } from '../electron/features/plugins/trust-roots'
import { wirePluginTrust } from '../electron/features/plugins/trust-wire'
import { refreshTrustOnMarker } from '../electron/features/agent-control/wire'
import { parseAgentPolicy } from '../electron/services/agent-policy-store'
import { parsePluginTrustDocuments, type PluginTrustDocuments } from '../../shared/core/plugin-trust-distribution'
import type { SignedEnvelope } from '../../shared/core/plugin-trust-documents'
import { makeTempDir } from '../../shared/testing/temp-dirs'

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugin-trust')
const DOCS = JSON.parse(fs.readFileSync(path.join(FIX, 'documents.json'), 'utf8')) as Record<string, SignedEnvelope>
const doc = (name: string): SignedEnvelope => { assert.ok(DOCS[name], name); return structuredClone(DOCS[name]) }
const NOW = Date.parse('2026-11-21T12:00:00Z')
const SERVER = 'https://acb.example'

let dir: string
beforeEach(() => { dir = makeTempDir('acb-trust-store-') })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const silent = { warn: () => {}, info: () => {} }

/** An app on this computer: the server answers `answers[companyId]`. Restarting = calling it again. */
function app(opts: {
  answers?: Record<string, PluginTrustDocuments | unknown>
  baked?: string
  server?: string
  now?: number
  fsOps?: TrustFs
  warnings?: string[]
} = {}) {
  const answers = opts.answers ?? {}
  return createPluginTrust({
    files: createTrustFiles(() => dir, opts.fsOps),
    bakedRoot: doc(opts.baked ?? 'root-v1'),
    rootKind: 'development',
    crypto: C,
    serverUrl: () => opts.server ?? `${SERVER}/`,
    fetchDocuments: async companyId => (companyId in answers ? answers[companyId] : null),
    now: () => opts.now ?? NOW,
    log: { info: () => {}, warn: (m: string) => { opts.warnings?.push(m) } },
  })
}
const docs = (o: Partial<{ roots: string[]; targets: string | null; freshness: string | null }>): PluginTrustDocuments => ({
  roots: (o.roots ?? ['root-v1']).map(doc), targets: o.targets ? doc(o.targets) : null, freshness: o.freshness ? doc(o.freshness) : null,
})
const v5 = docs({ targets: 't-c1-v5', freshness: 'f-c1-v5' })
const refused = (r: RefreshOutcome, note: string) => { assert.ok(r.ok, JSON.stringify(r)); assert.ok(r.ok && r.notes.includes(note), JSON.stringify(r)) }
const runsUntil = (a: ReturnType<typeof app>, companyId = 'c1') => { const s = a.status(companyId); return s.ok ? new Date(s.until).toISOString() : s.code }
const file = (name: string) => path.join(dir, name)

describe('P2 the app keeps its trust record on disk', () => {
  it('S1 an accepted list and freshness are written; after a restart the record refuses an older list (C3 across a restart)', async () => {
    const first = app({ answers: { c1: v5 } })
    assert.deepEqual(await first.refresh('c1'), { ok: true, settled: true, notes: [] })
    assert.equal(runsUntil(first), '2026-11-24T00:00:00.000Z')
    assert.ok(fs.existsSync(file(TRUST_RECORD_FILE)))
    assert.equal(fs.existsSync(file(TRUST_HALT_FILE)), false)
    // restart: nothing in memory, the server now hands the older v4
    const restarted = app({ answers: { c1: docs({ targets: 't-c1-v4' }) } })
    assert.equal(runsUntil(restarted), 'list-not-current') // no handle before a refresh: nothing runs on the record alone
    refused(await restarted.refresh('c1'), 'list refused: rollback')
    // the same v5 again is fine after the restart
    const again = app({ answers: { c1: v5 } })
    assert.deepEqual(await again.refresh('c1'), { ok: true, settled: true, notes: [] })
    assert.equal(runsUntil(again), '2026-11-24T00:00:00.000Z')
  })

  it('S2 a deleted record is a first start (nothing to compare: v4 is taken) — the documented limit', async () => {
    await app({ answers: { c1: v5 } }).refresh('c1')
    fs.rmSync(file(TRUST_RECORD_FILE))
    const after = app({ answers: { c1: docs({ targets: 't-c1-v4' }) } })
    assert.deepEqual(await after.refresh('c1'), { ok: true, settled: true, notes: ['no freshness handed out'] })
    assert.equal(after.health().problem, null)
  })

  it('S3 a damaged record is unknown, not empty: problem noted, kept aside, never yields its records', async () => {
    await app({ answers: { c1: v5 } }).refresh('c1')
    const good = fs.readFileSync(file(TRUST_RECORD_FILE), 'utf8')
    fs.writeFileSync(file(TRUST_RECORD_FILE), good.slice(0, good.length / 2))
    const warnings: string[] = []
    const damaged = app({ answers: { c1: v5 }, warnings })
    assert.match(damaged.health().problem ?? '', /could not be read/)
    assert.equal(fs.readFileSync(file(TRUST_UNUSABLE_FILE), 'utf8'), good.slice(0, good.length / 2))
    assert.ok(warnings.some(w => /could not be read/.test(w)))
    assert.equal(runsUntil(damaged), 'list-not-current')
  })

  it('S3b "unknown" is kept with the record: a refresh that takes an older list does not make it clean, nor does a restart', async () => {
    await app({ answers: { c1: v5 } }).refresh('c1')
    fs.writeFileSync(file(TRUST_RECORD_FILE), '{ damaged')
    const damaged = app({ answers: { c1: docs({ targets: 't-c1-v4' }) } })
    assert.match(damaged.health().unknown ?? '', /could not be read/)
    // v4 is older than the v5 seen before the damage: with the records lost it cannot be told apart
    // from a first start (the documented limit) — it is taken, but the state stays "unknown"
    assert.equal((await damaged.refresh('c1')).ok, true)
    assert.match(damaged.health().unknown ?? '', /could not be read/)
    assert.match(JSON.parse(fs.readFileSync(file(TRUST_RECORD_FILE), 'utf8')).unknown, /could not be read/)
    const restarted = app({ answers: { c1: docs({ targets: 't-c1-v4' }) } })
    assert.match(restarted.health().unknown ?? '', /could not be read/)
    assert.match(restarted.health().problem ?? '', /could not be read/)
    // a later write keeps it too (only a deliberate clearTrustUnknown ends it)
    assert.equal((await restarted.refresh('c1')).ok, true)
    assert.match(app().health().unknown ?? '', /could not be read/)
  })

  it('S4 a record that exists but cannot be read (a folder in its place) is unknown too, never empty', () => {
    fs.mkdirSync(file(TRUST_RECORD_FILE))
    assert.match(app().health().problem ?? '', /could not be read/)
  })

  it('S5 a root conflict halts, the halt file is written, and the halt survives a restart and a damaged or deleted record', async () => {
    const conflicting = docs({ roots: ['root-v1', 'root-v2', 'root-v2-conflict'], targets: 't-c1-v5', freshness: 'f-c1-v5' })
    const a = app({ answers: { c1: conflicting } })
    refused(await a.refresh('c1'), 'halted: two different signed roots for version 2')
    assert.equal(a.health().halted, true)
    assert.ok(fs.existsSync(file(TRUST_HALT_FILE)))
    assert.equal(app({ answers: { c1: v5 } }).health().halted, true)
    fs.writeFileSync(file(TRUST_RECORD_FILE), '{ not json')
    assert.equal(app().health().halted, true)
    fs.rmSync(file(TRUST_RECORD_FILE))
    const b = app({ answers: { c1: v5 } })
    assert.equal(b.health().halted, true)
    refused(await b.refresh('c1'), 'halted: two different signed roots for version 2')
    assert.equal(runsUntil(b), 'halted')
    // only an app carrying a newer root than the halted version starts clean (and removes the stale halt file)
    const newer = app({ answers: { c1: docs({ roots: ['root-v3'], targets: 't-c1-v6-tb', freshness: 'f-c1-v6-tb-fresh-b' }) }, baked: 'root-v3' })
    assert.equal(newer.health().halted, false)
    assert.ok((await newer.refresh('c1')).ok)
    assert.equal(fs.existsSync(file(TRUST_HALT_FILE)), false)
  })

  it('S6 a halt file that is damaged, empty or unreadable is a halt at the app\'s version', () => {
    fs.writeFileSync(file(TRUST_HALT_FILE), '\u0000garbage')
    assert.equal(app().health().halted, true)
    fs.writeFileSync(file(TRUST_HALT_FILE), '')
    assert.equal(app().health().halted, true)
    fs.rmSync(file(TRUST_HALT_FILE))
    fs.mkdirSync(file(TRUST_HALT_FILE))
    assert.equal(app().health().halted, true)
    fs.rmSync(file(TRUST_HALT_FILE), { recursive: true })
    assert.equal(app().health().halted, false)
  })

  it('S7 an interrupted write leaves the previous record whole; the state in memory does not move ahead of the disk', async () => {
    const first = app({ answers: { c1: v5 } })
    await first.refresh('c1')
    const before = fs.readFileSync(file(TRUST_RECORD_FILE), 'utf8')
    let cut = true
    const broken: TrustFs = { ...fs, renameSync: (a, b) => { if (cut) throw new Error('power cut'); fs.renameSync(a, b) } }
    const answers: Record<string, PluginTrustDocuments> = { c1: docs({ targets: 't-c1-v6', freshness: 'f-c1-v6' }) }
    const b = app({ answers, fsOps: broken })
    await b.refresh('c1').then(r => assert.deepEqual(r, { ok: false, reason: 'not-saved' }))
    assert.equal(fs.readFileSync(file(TRUST_RECORD_FILE), 'utf8'), before)
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [])
    assert.equal(runsUntil(b), 'list-not-current')
    // v6 was not taken in memory either: once the disk works again, v5 is still the current list here
    cut = false
    answers.c1 = v5
    assert.deepEqual(await b.refresh('c1'), { ok: true, settled: true, notes: [] })
    // a leftover .tmp (a crash between write and rename) is never read and is swept at the next start
    fs.writeFileSync(file(`${TRUST_RECORD_FILE}.abc.tmp`), '{"format":1,"chain":[],"marks":{},"freshMarks":{},"halted":null}')
    const c = app({ answers: { c1: docs({ targets: 't-c1-v4' }) } })
    refused(await c.refresh('c1'), 'list refused: rollback')
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [])
  })

  it('S8 a halt is written before the record: a crash after the halt keeps the halt', async () => {
    let renames = 0
    const crashAfterHalt: TrustFs = { ...fs, renameSync: (a, b) => { renames++; if (renames > 1) throw new Error('crash'); fs.renameSync(a, b) } }
    const a = app({ answers: { c1: docs({ roots: ['root-v1', 'root-v2', 'root-v2-conflict'] }) }, fsOps: crashAfterHalt })
    assert.deepEqual(await a.refresh('c1'), { ok: false, reason: 'not-saved' })
    assert.ok(fs.existsSync(file(TRUST_HALT_FILE)))
    assert.equal(app().health().halted, true)
  })
})

describe('P2 roots, servers, companies and clocks through the store', () => {
  it('B6 a dormant computer catches up from its stored chain after a restart (v1 → v2 → v3 kept on disk)', async () => {
    const a = app({ answers: { c1: docs({ roots: ['root-v1', 'root-v2', 'root-v3'], targets: 't-c1-v6-tb', freshness: 'f-c1-v6-tb-fresh-b' }) } })
    assert.ok((await a.refresh('c1')).ok)
    const later = app({ answers: { c1: docs({ roots: [], targets: 't-c1-v6-tb', freshness: 'f-c1-v6-tb-fresh-b' }) } })
    assert.deepEqual(await later.refresh('c1'), { ok: true, settled: true, notes: [] }) // the stored chain still has v3's keys
  })

  it('B7 a new app carrying v3 keeps the records of the same generation from disk', async () => {
    await app({ answers: { c1: docs({ roots: ['root-v1', 'root-v2', 'root-v3'], targets: 't-c1-v6-tb' }) } }).refresh('c1')
    const v3app = app({ baked: 'root-v3', answers: { c1: docs({ roots: ['root-v3'], targets: 't-c1-v5' }) } })
    refused(await v3app.refresh('c1'), 'list refused: threshold') // v5 is under the old key: never again
  })

  it('B9 a stored chain that no longer authenticates is dropped (problem noted), the app\'s root used', async () => {
    await app({ answers: { c1: docs({ roots: ['root-v1', 'root-v2'] }) } }).refresh('c1')
    const rec = JSON.parse(fs.readFileSync(file(TRUST_RECORD_FILE), 'utf8'))
    rec.chain[1].signatures = rec.chain[1].signatures.slice(0, 1)
    fs.writeFileSync(file(TRUST_RECORD_FILE), JSON.stringify(rec))
    assert.match(app().health().problem ?? '', /did not authenticate/)
  })

  it('C14 records are per server: the same company on staging after production is not a rollback, across a restart', async () => {
    await app({ answers: { c1: docs({ targets: 't-c1-v5' }) } }).refresh('c1')
    const staging = app({ server: 'https://staging.example', answers: { c1: docs({ targets: 't-c1-v4-staging' }) } })
    assert.deepEqual(await staging.refresh('c1'), { ok: true, settled: true, notes: ['no freshness handed out'] })
    // and production's record is untouched by staging's
    refused(await app({ answers: { c1: docs({ targets: 't-c1-v4' }) } }).refresh('c1'), 'list refused: rollback')
  })

  it('C1 another company\'s list handed for this company is refused; this company\'s handle never runs for another', async () => {
    refused(await app({ answers: { c1: docs({ targets: 't-c2-v5' }) } }).refresh('c1'), 'list refused: other-company')
    const a = app({ answers: { c1: v5, c2: v5 } })
    await a.refresh('c1')
    refused(await a.refresh('c2'), 'list refused: other-company')
    assert.equal(runsUntil(a, 'c2'), 'list-not-current')
    assert.equal(runsUntil(a, 'c1'), '2026-11-24T00:00:00.000Z')
  })

  it('T1 the app\'s clock decides, never the server\'s: 20 minutes behind the list\'s issue time refuses it; 5 minutes is within the skew', async () => {
    const behind = app({ answers: { c1: v5 }, now: Date.parse('2026-11-20T23:40:00Z') })
    refused(await behind.refresh('c1'), 'list refused: issued-in-future')
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir)
    const slightly = app({ answers: { c1: v5 }, now: Date.parse('2026-11-20T23:55:00Z') })
    assert.ok((await slightly.refresh('c1')).ok)
    // after the freshness ran out by the app's clock, nothing runs, whatever the server handed
    const late = app({ answers: { c1: v5 }, now: Date.parse('2026-11-24T00:00:01Z') })
    refused(await late.refresh('c1'), 'freshness refused: expired')
    assert.equal(runsUntil(late), 'no-freshness')
  })

  it('R a malformed answer changes nothing; an unreachable server changes nothing; a server URL with a path cannot be named', async () => {
    const a = app({ answers: { c1: { roots: [], targets: null, freshness: null, extra: 1 } } })
    assert.deepEqual(await a.refresh('c1'), { ok: false, reason: 'unreadable' })
    assert.equal(fs.existsSync(file(TRUST_RECORD_FILE)), false)
    assert.deepEqual(await app().refresh('c1'), { ok: false, reason: 'unreachable' })
    assert.deepEqual(await app({ server: 'https://acb.example/sub', answers: { c1: v5 } }).refresh('c1'), { ok: false, reason: 'no-server' })
  })

  it('R a build whose root cannot start keeps no trust and says so (never throws into the app)', async () => {
    const a = createPluginTrust({
      files: createTrustFiles(() => dir), bakedRoot: { placeholder: 'x' }, rootKind: 'production', crypto: C, serverUrl: () => SERVER,
      fetchDocuments: async () => v5, now: () => NOW, log: silent,
    })
    assert.deepEqual(await a.refresh('c1'), { ok: false, reason: 'no-trust' })
    assert.deepEqual(a.status('c1'), { ok: false, code: 'no-trust' })
  })
})

describe('P2 the answer and the policy marker', () => {
  it('W1 parsePluginTrustDocuments is strict: three keys, envelopes only, no freshness without a list', () => {
    assert.ok(parsePluginTrustDocuments({ roots: [DOCS['root-v1']], targets: DOCS['t-c1-v5'], freshness: null }))
    assert.equal(parsePluginTrustDocuments({ roots: [DOCS['root-v1']], targets: null, freshness: null, more: [] }), null)
    assert.equal(parsePluginTrustDocuments({ roots: [{ signed: 'x' }], targets: null, freshness: null }), null)
    assert.equal(parsePluginTrustDocuments({ roots: [], targets: null, freshness: DOCS['f-c1-v5'] }), null)
    assert.equal(parsePluginTrustDocuments({ roots: [], targets: 'x', freshness: null }), null)
  })

  it('W2 the policy keeps a hex marker only', () => {
    const base = { version: 'v1', sandbox: { mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' } }
    assert.equal(parseAgentPolicy({ ...base, pluginTrust: 'ab12' })?.pluginTrust, 'ab12')
    assert.equal(parseAgentPolicy({ ...base, pluginTrust: '../x' })?.pluginTrust, undefined)
  })

  it('W3 a refresh runs once per new marker per company, again after a failure, never without a marker', async () => {
    const calls: string[] = []
    let ok = false
    const onMarker = refreshTrustOnMarker({ refresh: async c => { calls.push(c); return ok ? { ok: true, settled: true, notes: [] } : { ok: false, reason: 'unreachable' } } })
    const settle = () => new Promise(r => setTimeout(r, 0))
    onMarker('c1', undefined); await settle()
    onMarker('c1', 'm1'); await settle()
    ok = true
    onMarker('c1', 'm1'); await settle()
    onMarker('c1', 'm1'); await settle()
    onMarker('c2', 'm1'); await settle()
    onMarker('c1', 'm2'); await settle()
    assert.deepEqual(calls, ['c1', 'c1', 'c2', 'c1'])
  })

  it('W4 documents refused because this computer\'s clock was behind are taken in once the clock is right, with the same marker', async () => {
    let now = Date.parse('2026-11-20T23:00:00Z') // an hour behind the list's issue time
    const trust = createPluginTrust({
      files: createTrustFiles(() => dir), bakedRoot: doc('root-v1'), rootKind: 'development', crypto: C, serverUrl: () => SERVER,
      fetchDocuments: async () => v5, now: () => now, log: silent,
    })
    const settle = () => new Promise(r => setTimeout(r, 20))
    const outcomes: RefreshOutcome[] = []
    const onMarker = refreshTrustOnMarker({ refresh: async c => { const r = await trust.refresh(c); outcomes.push(r); return r } })
    onMarker('c1', 'm1'); await settle()
    assert.deepEqual(outcomes[0], { ok: true, settled: false, notes: ['list refused: issued-in-future'] })
    now = NOW
    onMarker('c1', 'm1'); await settle()
    assert.deepEqual(outcomes[1], { ok: true, settled: true, notes: [] })
    assert.equal(runsUntil(trust), '2026-11-24T00:00:00.000Z')
    onMarker('c1', 'm1'); await settle()
    assert.equal(outcomes.length, 2) // done now: the same marker is not fetched again
  })

  it('W5 a refusal for good (another company\'s list) is done: the same marker is not fetched again', async () => {
    const outcomes: RefreshOutcome[] = []
    const a = app({ answers: { c1: docs({ targets: 't-c2-v5' }) } })
    const onMarker = refreshTrustOnMarker({ refresh: async c => { const r = await a.refresh(c); outcomes.push(r); return r } })
    const settle = () => new Promise(r => setTimeout(r, 20))
    onMarker('c1', 'm1'); await settle()
    onMarker('c1', 'm1'); await settle()
    assert.deepEqual(outcomes, [{ ok: true, settled: true, notes: ['list refused: other-company'] }])
  })
})

describe('P2 a release build carries the production root', () => {
  const dev = bakedTrustRoot('development')
  it('K1 the placeholder production root refuses a release build', () => {
    assert.match(releaseTrustRootProblem(bakedTrustRoot('production'), dev, C, NOW) ?? '', /placeholder/)
  })
  it('K2 the development root (or any root sharing a key with it) refuses a release build', () => {
    assert.match(releaseTrustRootProblem(dev, dev, C, NOW) ?? '', /shares a key/)
    assert.match(releaseTrustRootProblem(doc('root-v3'), doc('root-v1'), C, NOW) ?? '', /shares a key/)
  })
  it('K3 a root that does not carry its own threshold, or expires within 30 days, refuses it; a real other root passes', () => {
    const one = doc('root-v1'); one.signatures = one.signatures.slice(0, 1)
    assert.match(releaseTrustRootProblem(one, dev, C, NOW) ?? '', /not a valid root/)
    assert.match(releaseTrustRootProblem(doc('root-v1'), dev, C, Date.parse('2027-11-01T00:00:00Z')) ?? '', /expires within 30 days/)
    assert.equal(releaseTrustRootProblem(doc('root-v1'), dev, C, NOW), null)
  })
  it('K4 the development root is a valid root of its own (a development build starts)', () => {
    assert.equal(app({ baked: undefined }).health().available, true)
    const a = createPluginTrust({ files: createTrustFiles(() => dir), bakedRoot: dev, rootKind: 'development', crypto: C, serverUrl: () => SERVER, fetchDocuments: async () => null, log: silent })
    assert.equal(a.health().available, true)
  })

  it('K5 what a build carries: unpackaged → development; packaged without a real production root → development and said so (until required); required → never the development root', () => {
    const roots = { production: bakedTrustRoot('production'), development: dev }
    assert.deepEqual(carriedTrustRoot(false, C, NOW, roots), { kind: 'development', envelope: dev, warning: null })
    const fallback = carriedTrustRoot(true, C, NOW, roots, false)
    assert.equal(fallback.kind, 'development')
    assert.match(fallback.warning ?? '', /DEVELOPMENT plugin trust root.*placeholder/)
    const required = carriedTrustRoot(true, C, NOW, roots, true)
    assert.equal(required.kind, 'production')
    assert.equal(required.envelope, roots.production)
    const real = carriedTrustRoot(true, C, NOW, { production: doc('root-v1'), development: dev }, false)
    assert.deepEqual([real.kind, real.warning], ['production', null])
    // the switch is off until the enforcement PR (owner decision): a release build is not refused meanwhile
    assert.equal(RELEASE_REQUIRES_PRODUCTION_ROOT, false)
  })

  it('K6 the app reports which root it carries, and keeps a record per root kind (a development app never shares one with a packaged app)', async () => {
    const answer = { data: { roots: [], targets: null, freshness: null } }
    const fakeFetch = (async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch
    const trust = wirePluginTrust({ userDataDir: () => dir, serverUrl: () => SERVER, session: { cookies: () => [] }, packaged: true, log: silent, fetch: fakeFetch })
    assert.equal(trust.health().root, 'development') // the production root is still the placeholder
    assert.ok((await trust.refresh('c1')).ok)
    assert.ok(fs.existsSync(path.join(dir, 'trust', 'development', TRUST_RECORD_FILE)))
    assert.equal(fs.existsSync(path.join(dir, 'trust', TRUST_RECORD_FILE)), false)
  })
})
