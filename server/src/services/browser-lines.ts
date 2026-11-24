/**
 * Plans of opened lines on the server (generalization PR 4; agent-browser.md "Plans of opened lines on the server";
 * design memo §3-5, §8, §15 C11–C13, §16-1, §16-4, §16-5 with Q14 / Q15, §17). The server is the authority:
 *
 * - **The opened list** `shared/browser-connectors/opened.json` is read once at start; every map is re-hashed and checked
 *   (`browserMapProblem`), every line checked against its map (`browserOpenedLineProblem`) and both of its hashes
 *   recomputed (`browserLineMeaning` / `browserLineMechanics`) — a row whose stored hash differs is left out, never
 *   trusted. A line's `status` is the reviewed one (`pending` / `approved` / `retired`).
 * - **The gate** (create, approve, claim, every permit): first this PC (an enabled registration of the member, and the
 *   plan's own registration: services/browser-devices.ts); then the line is an `approved` row whose site, name, version, map
 *   version, meaning hash and mechanics hash are **all exactly** the request's (`BROWSER_LINE_NOT_APPROVED` /
 *   `BROWSER_LINE_RETIRED`); the member's browser setting lets them use the site at the level the line needs; the AI is
 *   not stopped; the member holds a grant for the line's meaning on this mechanics hash or one the row's reviewed
 *   `grantsFrom` names (Q15), given while they are a member this time.
 * - **Where values come from** (§16-4, Q14): the core's rule (`browserLineValuesProblem`: `which` only from a bound
 *   record field or a person's confirmation, `target` only from the site, the AI only for `write`), and — until a business
 *   plugin's binding exists for the server to re-read — **no record-field value at all** (`BROWSER_VALUE_SOURCE_NOT_YET`).
 * - **An inspection** (a line that writes nothing): made `open` by the member's session after the gate; the app reads the
 *   site (PR 5) and reports, once, the fixed words of each read and check (never a value the site showed); the server
 *   keeps them and says whether every read counted and every check is ✓.
 * - **A plan of writes** (generalization PR 5c): made `draft` from an **approved** line that writes, by the member's session,
 *   with the account the app read (the site's marker) and values whose sources the core accepts — which / when and every
 *   person's value **confirmed one by one** on the card; the server derives the writes and every lock from the line, its map
 *   and the values (never from the app). Approve (the hash the person saw), claim, a permit per write and a report per write
 *   follow the state table (`browser-line-steps.ts`). Both lines that write (`step_template_add`, `landing_create`) stay
 *   `pending` until the owner's test write (PR 7), so the gate refuses them (`BROWSER_LINE_NOT_APPROVED`); a plan whose
 *   line holds no write (or another number of writes) is never approved, claimed or permitted. An inspection of a line
 *   that writes stays refused (`BROWSER_LINE_WRITES_NOT_YET`: it would pass the 「見るだけ」 gate). The rollback floor is
 *   PR 4's build (deployment.md "Rolling back production"): never roll back below it once this build ran.
 * - **The strict read's notice** (§16-1 with Codex round 2 R1 / R2): the app reports a thing it could not read whole as
 *   the map's site, version and thing, a fixed kind and a count — never a key name; only for a map an approved line uses,
 *   only from a member who may use the site and holds a grant on one of its lines, within limits; one notice per company ×
 *   site × version × thing; every owner / admin told once (`browser_shape_changed`). It is an unchecked diagnosis: it
 *   never stops or approves anything.
 *
 * Everything is a person's session except a write execution's report (its secret). No AI token reaches any route.
 */
import { browserAiStopped, levelAllows, type BrowserOperationEffect, type BrowserOperationSettings } from '../../shared/core/browser-operation'
import { BROWSER_MAP_LIMITS, BROWSER_SHAPE_CHANGES, browserMapProblem, type BrowserMap, type BrowserShapeChange } from '../../shared/core/browser-map'
import {
  BROWSER_OPENED_STATUSES, browserLineMeaning, browserLineMechanics, browserOpenedLineProblem, type BrowserOpenedLineRow, type BrowserOpenedMapRow,
} from '../../shared/core/browser-opened'
import { BROWSER_PLAN_TIMES, BROWSER_REPORT_REASONS } from '../../shared/core/browser-plans'
import { browserLineValuesProblem, type BrowserCheckStatus, type BrowserReadStatus } from '../../shared/core/browser-read-line'
import { canonicalJson } from '../../shared/core/fixed-content'
import { browserLineWriteLocks, type BrowserLineWrite as CoreLineWrite } from '../../shared/core/browser-write-line'
import { BROWSER_ID_VALUE_RE } from '../../shared/core/plugin-browser-declaration'
import { parsePluginManifest } from '../../shared/core/plugins'
import type {
  BrowserInspectionResult, BrowserLineClaim, BrowserLineExecutionView, BrowserLineGrantsView, BrowserLinePermit, BrowserLinePlanView,
  BrowserLineRef, BrowserLineReportAnswer, BrowserShapeNoticeView, BrowserWriteResult,
} from '../../shared/types/browser-lines'
import type { BrowserLinesMine } from '../../shared/types/browser-devices'
import type { AccountDirectory } from '../ports/accounts'
import type { BrowserConnectorCatalog } from '../ports/browser-plans'
import type { BrowserLineExecutionLookup, BrowserLineExecutionRow, BrowserLinePlanRow, BrowserLineRepository, BrowserOpenedListSource } from '../ports/browser-lines'
import type { Clock, IdGenerator, MonotonicClock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { hashCanonical } from '../lib/content-hash'
import { hasFullAccess, type Member } from './access'
import type { BrowserDeviceGate } from './browser-devices'
import { BROWSER_LINE_TIMES, createBrowserLineSteps, type BrowserLineWritesContent } from './browser-line-steps'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserLineDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  monotonic: MonotonicClock
  ids: IdGenerator
  tokenDigest: TokenDigest
  opened: BrowserOpenedListSource
  /** The approved combinations (the site's operated host and name come from its approved declaration). */
  catalog: BrowserConnectorCatalog
  executionLookup: BrowserLineExecutionLookup
  memberships: Pick<MembershipRepository, 'roleOf' | 'joinedAt' | 'listByCompany'>
  accounts: Pick<AccountDirectory, 'byIds'>
  browserPolicy: (member: Member) => BrowserOperationSettings
  aiStops: (member: Member) => { all: boolean; tools: readonly string[] }
  /** This PC's registration (agent-browser.md "This PC's registration"): the first check of the gate. */
  devices: BrowserDeviceGate
  /** Tell these members their notices changed (push channel). */
  noticesChanged?: (companyId: string, userIds: string[]) => void
  log?: Pick<Console, 'warn'>
}

export const BROWSER_LINE_WORDS = {
  badPlan: '計画の形が正しくありません',
  notFound: '計画が見つかりません',
  executionNotFound: '実行が見つかりません',
  notApproved: 'この点検・操作の行は認められていません。アプリを新しくしてください',
  retired: 'この点検・操作の行は、もう使えません',
  notAllowed: 'この会社では、いまこのサイトは使えません',
  aiStopped: 'AI が止められているので、ブラウザ操作はできません',
  notGranted: 'この点検・操作は、管理者からまだ任されていません',
  valueSource: '値の出どころが認められていません',
  valueUnconfirmed: '値を、カードで1つずつ確かめてください',
  valueSourceNotYet: '記録の欄から読む値は、まだ使えません',
  writesNotYet: '書き込みのある行は、まだ使えません',
  expired: '期限が切れました。もう一度頼んでください',
  notOpen: 'この計画は、もう終わっています',
  resultDone: 'この点検の結果は、もう届いています',
  badResult: '点検の結果の形が正しくありません',
  notDraft: 'この計画は、もう任せる前の状態ではありません',
  contentChanged: '内容が変わりました。もう一度確かめてください',
  notApprovedYet: 'この計画は、まだ任されていないか、もう使われました',
  frozen: 'この計画は、このサーバーでは扱えない形です',
  notYoursYet: '本人が確かめるのを待っています（本人が会社を抜けたか、24時間たつと確かめられます）',
  manageForbidden: 'ブラウザ操作の任せ先を変えられるのは、オーナーと管理者だけです',
  memberNotFound: 'Member not found',
  badNotice: '知らせの形が正しくありません',
  tooManyNotices: '今日は、このサイトの知らせをもう受け取れません',
} as const
const W = BROWSER_LINE_WORDS

/** Plan shapes this build knows (a later one is frozen: never listed, claimed or permitted; a report kept and answered 409). */
export const BROWSER_LINE_PLAN_SHAPES: readonly number[] = [2]
/** Limits of the strict read's notices (an unchecked diagnosis must not flood anyone). */
export const BROWSER_SHAPE_NOTICE_LIMITS = { perMemberSiteDay: 20, perCompanySiteDay: 200 } as const
export const BROWSER_SHAPE_NOTICE_KIND = 'browser_shape_changed'

const PLAN_ID_RE = /^bl_[0-9a-f]{32}$/
const EXEC_ID_RE = /^bw_[0-9a-f]{32}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/
const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/
const CONVERSATION_RE = /^[A-Za-z0-9_-]{1,100}$/
const REASON_RE = /^[a-z][a-z0-9-]{0,39}$/
const CREATED_ID_RE = /^[1-9][0-9]{0,18}$/
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => own(v, k))
const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string) => Date.parse(s)

interface LoadedLine { row: BrowserOpenedLineRow; map: BrowserMap; mapRow: BrowserOpenedMapRow }
interface Opened { maps: BrowserOpenedMapRow[]; lines: LoadedLine[] }
interface Site { host: string; label: string }

/** The fixed content of a line plan (canonical JSON; its hash is what the person approves). */
interface LinePlanContent {
  shape: 2
  company: string
  user: string
  conversation: string | null
  line: BrowserLineRef
  values: Record<string, { value: string; from: Record<string, unknown> }>
  writes: BrowserLineWritesContent['writes']
  locks: string[]
  site: string
  host: string
  account: string | null
  createdAt: string
  expiresAt: string
}

const READ_STATUSES: readonly BrowserReadStatus[] = ['ok', 'not-read', 'wrong-object', 'account-unknown', 'account-mismatch', 'wrong-parent']
const NOW_CHECK_STATUSES: readonly BrowserCheckStatus[] = ['ok', 'ng', 'unreadable']

function parseRef(v: unknown): BrowserLineRef | null {
  if (!isMap(v)) return null
  const { site, line, version, mapVersion, meaningHash, mechanicsHash } = v
  if (typeof site !== 'string' || !NAME_RE.test(site) || typeof line !== 'string' || !NAME_RE.test(line)) return null
  if (typeof version !== 'string' || !VERSION_RE.test(version) || typeof mapVersion !== 'string' || !VERSION_RE.test(mapVersion)) return null
  if (typeof meaningHash !== 'string' || !HASH_RE.test(meaningHash) || typeof mechanicsHash !== 'string' || !HASH_RE.test(mechanicsHash)) return null
  return { site, line, version, mapVersion, meaningHash, mechanicsHash }
}

/**
 * The writes of a plan as the state table reads them, derived from the line and its map alone (never from the app): an
 * `add_child` changes the object its read names; a `create_from` creates a new object of its read's thing, and when it sets
 * a field to what an earlier write created (`{ created }`), the permit binds that id (`on`: the server's recorded id,
 * `createdTarget`). Null when a write cannot be told this way (a create naming two created objects: the permit binds one).
 */
export function browserLineServerWrites(writes: readonly CoreLineWrite[], read: { reads: ReadonlyArray<{ name: string; thing: string }> }, map: BrowserMap): BrowserLineWritesContent['writes'] | null {
  const out: BrowserLineWritesContent['writes'] = []
  const madeBy: Record<string, number> = {}
  for (const [i, w] of writes.entries()) {
    const r = read.reads.find(x => x.name === w.read)
    const thing = r ? map.things[r.thing] : undefined
    if (!r || !thing) return null
    if (w.verb === 'add_child') { out.push({ kind: 'change', thing: r.thing, idField: thing.id }); continue }
    const refs = Object.values(w.set).flatMap(src => ('created' in src ? [src.created] : []))
    if (refs.length > 1 || refs.some(n => !own(madeBy, n))) return null
    out.push({ kind: 'create', thing: r.thing, idField: thing.id, ...(refs.length === 1 ? { on: { created: madeBy[refs[0]] } } : {}) })
    madeBy[w.as] = i + 1
  }
  return out
}

export function createBrowserLineService(deps: BrowserLineDeps) {
  const { companyData, transactions, clock, monotonic, ids, tokenDigest, executionLookup, memberships } = deps
  const log = deps.log ?? console
  const steps = createBrowserLineSteps({ companyData, clock, monotonic, ids })
  const repo = (companyId: string): BrowserLineRepository => companyData.forCompany(companyId).browserLines

  // --- the opened list, checked once -------------------------------------------------------------

  let opened: Opened | null = null
  function load(): Opened {
    if (opened) return opened
    opened = { maps: [], lines: [] }
    const file = deps.opened.file()
    if (!isMap(file) || file.format !== 1 || file.provisional !== true || !Array.isArray(file.maps) || !Array.isArray(file.lines)) {
      if (file !== null) log.warn('[browser-lines] the opened list is not of a known shape; no line is accepted')
      return opened
    }
    for (const m of file.maps as unknown[]) {
      const fine = isMap(m) && typeof m.site === 'string' && typeof m.version === 'string' && typeof m.mapHash === 'string' && typeof m.readersHash === 'string'
        && HASH_RE.test(m.readersHash) && !browserMapProblem(m.map) && (m.map as BrowserMap).site === m.site && (m.map as BrowserMap).version === m.version
        && hashCanonical(canonicalJson(m.map)) === m.mapHash
      if (!fine) { log.warn('[browser-lines] a map of the opened list does not match its hash; left out'); continue }
      opened.maps.push(m as unknown as BrowserOpenedMapRow)
    }
    // A map version listed more than once: every copy left out (independent review L2: also a third one).
    const mapKey = (x: BrowserOpenedMapRow) => `${x.site}\n${x.version}`
    const twice = new Set(opened.maps.map(mapKey).filter((k, i, all) => all.indexOf(k) !== i))
    if (twice.size > 0) log.warn('[browser-lines] a map version is listed twice; every copy left out')
    opened.maps = opened.maps.filter(x => !twice.has(mapKey(x)))
    const rows: LoadedLine[] = []
    for (const l of file.lines as unknown[]) {
      const mapRow = isMap(l) ? opened.maps.find(m => m.site === l.site && m.version === l.mapVersion) : undefined
      const fine = isMap(l) && mapRow !== undefined && (BROWSER_OPENED_STATUSES as readonly unknown[]).includes(l.status)
        && typeof l.name === 'string' && typeof l.version === 'string' && typeof l.meaningHash === 'string' && typeof l.mechanicsHash === 'string'
        && !browserOpenedLineProblem(l.line, mapRow.map)
        && isMap(l.line) && l.line.name === l.name && l.line.version === l.version && isMap(l.line.read) && l.line.read.site === l.site
        && (l.grantsFrom === undefined || (Array.isArray(l.grantsFrom) && l.grantsFrom.every(h => typeof h === 'string' && HASH_RE.test(h))))
      if (!fine) { log.warn('[browser-lines] a line of the opened list does not open against its map; left out'); continue }
      const row = l as unknown as BrowserOpenedLineRow
      const meaning = hashCanonical(browserLineMeaning(row.line, mapRow.map))
      const mechanics = hashCanonical(browserLineMechanics(row.line, mapRow.map, { mapHash: mapRow.mapHash, readersHash: mapRow.readersHash }))
      if (meaning !== row.meaningHash || mechanics !== row.mechanicsHash) { log.warn('[browser-lines] a line of the opened list does not match its hashes; left out'); continue }
      rows.push({ row, map: mapRow.map, mapRow })
    }
    const id = (x: LoadedLine) => `${x.row.site}\n${x.row.name}\n${x.row.version}\n${x.row.mapVersion}`
    for (const x of rows) {
      if (rows.filter(y => id(y) === id(x)).length > 1) { log.warn('[browser-lines] a line is listed twice under one version; left out'); continue }
      // A grant carries over only from another row of the same line and meaning (a reviewed "compatible", Q15).
      const from = x.row.grantsFrom ?? []
      if (!from.every(h => h !== x.row.mechanicsHash && rows.some(y => y.row.site === x.row.site && y.row.name === x.row.name && y.row.meaningHash === x.row.meaningHash && y.row.mechanicsHash === h))) {
        log.warn('[browser-lines] a line carries grants from no row of the same meaning; left out')
        continue
      }
      opened.lines.push(x)
    }
    return opened
  }

  // The site's operated host and name: its one approved declaration (two hosts → none: nothing is allowed).
  let sites: Map<string, Site | null> | null = null
  function siteOf(site: string): Site | null {
    if (!sites) {
      sites = new Map()
      for (const row of deps.catalog.combinations()) {
        if (!isMap(row) || row.status !== 'approved' || typeof row.declaration !== 'string' || hashCanonical(row.declaration) !== row.declarationHash) continue
        const parsed = parsePluginManifest(row.declaration)
        if (!parsed.ok || !parsed.value.browser || parsed.value.id !== row.connector) continue
        const found: Site = { host: parsed.value.browser.host, label: parsed.value.label }
        const was = sites.get(row.connector)
        sites.set(row.connector, was === undefined || (was && was.host === found.host) ? found : null)
      }
    }
    return sites.get(site) ?? null
  }

  const lineName = (l: LoadedLine) => l.row.line.label
  const refOf = (l: LoadedLine): BrowserLineRef => ({
    site: l.row.site, line: l.row.name, version: l.row.version, mapVersion: l.row.mapVersion, meaningHash: l.row.meaningHash, mechanicsHash: l.row.mechanicsHash,
  })
  const findLine = (ref: BrowserLineRef) => load().lines.find(l => l.row.site === ref.site && l.row.name === ref.line && l.row.version === ref.version
    && l.row.mapVersion === ref.mapVersion && l.row.meaningHash === ref.meaningHash && l.row.mechanicsHash === ref.mechanicsHash) ?? null
  const planRef = (p: BrowserLinePlanRow): BrowserLineRef => ({
    site: p.site, line: p.lineName, version: p.lineVersion, mapVersion: p.mapVersion, meaningHash: p.meaningHash, mechanicsHash: p.mechanicsHash,
  })

  /** Whether the member holds a grant for this row now (§16-5, Q15): its meaning, on its mechanics or one it carries from. */
  function granted(member: Member, row: BrowserOpenedLineRow): boolean {
    const joined = memberships.joinedAt(member.companyId, member.userId)
    if (typeof joined !== 'string') return false
    const carried = new Set([row.mechanicsHash, ...(row.grantsFrom ?? [])])
    return repo(member.companyId).grantsOf(member.userId, row.site, row.name)
      .some(g => g.meaningHash === row.meaningHash && carried.has(g.mechanicsHash) && g.grantedAt >= joined)
  }

  /** May the member use the site at this level now (the company's setting with their own mode)? */
  function siteAllowed(member: Member, site: string, effect: BrowserOperationEffect): boolean {
    const s = siteOf(site)
    const settings = deps.browserPolicy(member)
    const setting = s ? settings.sites.find(x => x.host === s.host) : undefined
    return settings.mode === 'on' && !!setting && levelAllows(setting.level, effect)
  }

  /**
   * Every rule a line plan's step must pass now, in this order (create, approve, claim, every permit): this PC (an enabled
   * registration of the member, the plan's own registration — `devices.check`), the line, the setting, the stop, the grant.
   */
  function gate(member: Member, ref: BrowserLineRef, effect: BrowserOperationEffect, device: { key: string | undefined; planId: string | null }):
    Outcome<LoadedLine & { deviceId: string | null }> {
    const pc = deps.devices.check(member, device.key, device.planId === null ? null : { path: 'line', planId: device.planId })
    if (!pc.ok) return pc
    const line = findLine(ref)
    if (!line || line.row.status === 'pending') return refuse('conflict', W.notApproved, { code: 'BROWSER_LINE_NOT_APPROVED' })
    if (line.row.status !== 'approved') return refuse('conflict', W.retired, { code: 'BROWSER_LINE_RETIRED' })
    if (!siteAllowed(member, ref.site, effect)) return refuse('conflict', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
    if (browserAiStopped(deps.aiStops(member))) return refuse('conflict', W.aiStopped, { code: 'BROWSER_AI_STOPPED' })
    if (!granted(member, line.row)) return refuse('forbidden', W.notGranted, { code: 'BROWSER_TYPE_NOT_GRANTED' })
    return ok({ ...line, deviceId: pc.value.deviceId })
  }

  /**
   * The gate for a plan of writes (approve, claim, every permit): the line's gate at level 「入力・保存まで」 — an approved
   * row exactly (the PC registration adds its check in `gate`, the one seam) —, and the row's line must write exactly as
   * many times as the plan holds: a plan whose line writes nothing (an inspection's row) or writes otherwise is never
   * approved, claimed or permitted, whatever a row in the database says.
   */
  function writeGate(member: Member, p: BrowserLinePlanRow, deviceKey: string | undefined): Outcome<LoadedLine> {
    const passed = gate(member, planRef(p), 'write', { key: deviceKey, planId: p.id })
    if (!passed.ok) return passed
    const writes = passed.value.row.line.writes
    if (!writes || writes.length !== p.writes || p.writes < 1) return refuse('conflict', W.notApproved, { code: 'BROWSER_LINE_NOT_APPROVED' })
    return passed
  }

  const contentOf = (p: BrowserLinePlanRow) => JSON.parse(p.content) as LinePlanContent
  const frozen = (p: BrowserLinePlanRow) => !BROWSER_LINE_PLAN_SHAPES.includes(p.shape)
  const writesContent = (c: LinePlanContent): BrowserLineWritesContent => ({
    writes: c.writes, locks: c.locks, host: c.host, account: c.account ?? '', site: c.site, company: c.company,
  })
  const planMissing = (): Refusal => refuse('not-found', W.notFound, { code: 'BROWSER_PLAN_NOT_FOUND' })
  const execMissing = (): Refusal => refuse('not-found', W.executionNotFound, { code: 'BROWSER_EXECUTION_NOT_FOUND' })
  const frozenRefusal = (): Refusal => refuse('conflict', W.frozen, { code: 'BROWSER_PLAN_FROZEN' })

  /** The member's own plan (anyone else's, or another company's, is one that does not exist). */
  function ownPlan(member: Member, planId: string): BrowserLinePlanRow | null {
    if (!PLAN_ID_RE.test(planId)) return null
    const p = repo(member.companyId).plan(planId)
    return p && p.userId === member.userId ? p : null
  }

  /** An open inspection / a draft or approved plan past its hour closes. */
  function settlePlan(companyId: string, p: BrowserLinePlanRow, now: number): BrowserLinePlanRow {
    if ((p.state === 'open' || p.state === 'draft' || p.state === 'approved') && now >= ms(p.expiresAt)) {
      repo(companyId).setPlanState(p.id, p.state, 'closed', { closedAt: iso(now), closeReason: 'expired' })
      return repo(companyId).plan(p.id) as BrowserLinePlanRow
    }
    return p
  }

  function executionView(companyId: string, e: BrowserLineExecutionRow): BrowserLineExecutionView {
    return {
      id: e.id, state: e.state, claimedAt: e.claimedAt, settledAt: e.settledAt, voidReason: e.voidReason, confirmedBy: e.confirmedBy,
      steps: repo(companyId).steps(e.id).map(s => ({
        index: s.index, kind: s.kind, state: s.state, permittedAt: s.permittedAt, settledAt: s.settledAt, createdId: s.createdId,
        confirmableAt: s.permittedAt ? iso(ms(s.permittedAt) + BROWSER_LINE_TIMES.permit + BROWSER_LINE_TIMES.grace) : null,
      })),
    }
  }

  function planView(companyId: string, p: BrowserLinePlanRow): BrowserLinePlanView {
    const c = contentOf(p)
    const line = findLine(planRef(p))
    const e = repo(companyId).executionOfPlan(p.id)
    return {
      id: p.id, state: p.state, closeReason: p.closeReason, line: { ...planRef(p), label: line ? lineName(line) : p.lineName }, writes: p.writes,
      values: c.values, createdAt: p.createdAt, expiresAt: p.expiresAt, approvedAt: p.approvedAt, contentHash: p.contentHash,
      result: p.result ? JSON.parse(p.result) as BrowserInspectionResult : null,
      execution: e ? executionView(companyId, e) : null,
    }
  }

  /** The inspection's result: fixed words only, consistent with themselves (a check is ✓ only when every read it names counted). */
  function parseResult(line: LoadedLine, body: unknown): BrowserInspectionResult | null {
    if (!isMap(body) || !exactKeys(body, ['reads', 'checks'])) return null
    const reads = body.reads
    const names = line.row.line.read.reads.map(r => r.name)
    if (!isMap(reads) || !exactKeys(reads, names) || !names.every(n => (READ_STATUSES as readonly unknown[]).includes(reads[n]))) return null
    const checks = body.checks
    const declared = line.row.line.read.checks
    if (!Array.isArray(checks) || checks.length !== declared.length || !checks.every(c => (NOW_CHECK_STATUSES as readonly unknown[]).includes(c))) return null
    for (let i = 0; i < declared.length; i++) {
      const c = declared[i] as unknown as Record<string, unknown>
      const named = [c.read, c.reference].filter((v): v is string => typeof v === 'string')
      if (checks[i] === 'ok' && !named.every(n => reads[n] === 'ok')) return null
    }
    const allRead = names.every(n => reads[n] === 'ok')
    const state = !allRead ? 'not_read' : checks.every(c => c === 'ok') ? 'all_ok' : 'ng'
    return { state, reads: reads as Record<string, string>, checks: checks as string[] }
  }

  function grantsView(member: Member): BrowserLineGrantsView {
    const lines = load().lines.filter(l => l.row.status === 'approved').map(l => ({ ...refOf(l), label: lineName(l) }))
    const rows = repo(member.companyId).grants().filter(g => {
      const joined = memberships.joinedAt(member.companyId, g.userId)
      return typeof joined === 'string' && g.grantedAt >= joined
    })
    const people = deps.accounts.byIds([...new Set(rows.map(g => g.userId))])
    // The grants **in force**, per approved row and person: given on that row's own mechanics (`direct`) or carried by
    // its reviewed grantsFrom from another row (`carried`, which row) — never a stored pair that counts nowhere.
    const all = load().lines
    const grants: BrowserLineGrantsView['grants'] = []
    for (const l of all.filter(x => x.row.status === 'approved')) {
      const carried = new Set(l.row.grantsFrom ?? [])
      for (const g of rows) {
        if (g.site !== l.row.site || g.lineName !== l.row.name || g.meaningHash !== l.row.meaningHash) continue
        const direct = g.mechanicsHash === l.row.mechanicsHash
        if (!direct && !carried.has(g.mechanicsHash)) continue
        const origin = direct ? null : all.find(x => x.row.site === l.row.site && x.row.name === l.row.name && x.row.mechanicsHash === g.mechanicsHash) ?? null
        grants.push({
          userId: g.userId, name: people.get(g.userId)?.name ?? null, ...refOf(l),
          from: direct ? { kind: 'direct' } : { kind: 'carried', version: origin?.row.version ?? null, mapVersion: origin?.row.mapVersion ?? null, mechanicsHash: g.mechanicsHash },
          grantedAt: g.grantedAt, grantedBy: g.grantedBy,
        })
      }
    }
    return { lines, grants }
  }

  const DEDUPE_RE = /^browser_shape:([a-z][a-z0-9_]{0,39}):([0-9.]{5,14}):([a-z][a-z0-9_]{0,39})$/
  const CHANGE_WORDS: Record<BrowserShapeChange, (n: number) => string> = {
    unknown_keys: n => `知らない項目が${n}つ増えた`,
    missing_keys: n => `あるはずの項目が${n}つない`,
    unreadable: () => '読み取れない',
  }
  function noticeView(n: ReturnType<BrowserLineRepository['shapeNotices']>[number]): BrowserShapeNoticeView {
    const map = load().maps.find(m => m.site === n.site && m.version === n.mapVersion)?.map
    return {
      site: n.site, mapVersion: n.mapVersion, thing: n.thing, thingLabel: map?.things[n.thing]?.label ?? n.thing,
      unknownKeys: n.unknownKeys, missingKeys: n.missingKeys, unreadable: n.unreadable, reports: n.reports, firstAt: n.firstAt, lastAt: n.lastAt,
    }
  }

  return {
    /** Whether the new path holds this lock key (the old path's claim asks it: one object, one key on both paths, C11). */
    lockHeld(companyId: string, lockKey: string): boolean {
      return repo(companyId).lockHolder(lockKey) !== null
    },

    /**
     * POST /browser-line-plans { line, values, conversationId?, account? }: without `account`, an inspection of an approved
     * line that writes nothing (the gate at level 「見るだけ」; a line that writes is refused, `BROWSER_LINE_WRITES_NOT_YET`);
     * with `account` (the site's marker as the app read it, a plain id), a **plan of writes** of an approved line that writes
     * (the gate at level 「入力・保存まで」), made `draft`: the writes and every lock derived here from the line, its map and the
     * values (C11). Values: where they come from (§16-4; which / when and every person's value confirmed one by one).
     */
    create(member: Member, body: unknown, deviceKey?: string): Outcome<BrowserLinePlanView> {
      if (!isMap(body) || Object.keys(body).some(k => !['line', 'values', 'conversationId', 'account'].includes(k))) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      const ref = parseRef(body.line)
      if (!ref || (body.conversationId !== undefined && (typeof body.conversationId !== 'string' || !CONVERSATION_RE.test(body.conversationId)))) {
        return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      }
      const writing = own(body, 'account')
      if (writing && (typeof body.account !== 'string' || !BROWSER_ID_VALUE_RE.test(body.account))) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      const passed = gate(member, ref, writing ? 'write' : 'read', { key: deviceKey, planId: null })
      if (!passed.ok) return passed
      const line = passed.value
      const lineWrites = line.row.line.writes
      // A line that writes is never made an inspection (it would pass the 「見るだけ」 gate); a plan of writes needs a line that writes.
      if (!writing && lineWrites !== undefined) return refuse('conflict', W.writesNotYet, { code: 'BROWSER_LINE_WRITES_NOT_YET' })
      if (writing && (lineWrites === undefined || lineWrites.length === 0)) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      const site = siteOf(ref.site) as Site
      // Values: the core's one rule, then — until the server can re-read a business plugin's bound field — no record field.
      const problem = browserLineValuesProblem(line.row.line.read, body.values)
      if (problem) {
        const unconfirmed = problem.problem === 'unconfirmed'
        return refuse('bad-request', unconfirmed ? W.valueUnconfirmed : W.valueSource, { code: unconfirmed ? 'BROWSER_VALUE_UNCONFIRMED' : 'BROWSER_VALUE_REFUSED', value: problem.value, problem: problem.problem })
      }
      const values = JSON.parse(canonicalJson(body.values)) as LinePlanContent['values']
      for (const [name, v] of Object.entries(values)) {
        if (v.from.kind === 'record_field') return refuse('bad-request', W.valueSourceNotYet, { code: 'BROWSER_VALUE_SOURCE_NOT_YET', value: name })
      }
      let writes: LinePlanContent['writes'] = []
      let locks: string[] = []
      const account = writing ? body.account as string : null
      if (writing) {
        // The writes and the locks from the line alone (C11): the app never names a write, a target or a key.
        const derived = browserLineServerWrites(lineWrites as CoreLineWrite[], line.row.line.read, line.map)
        const plain = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]))
        const keys = browserLineWriteLocks(line.row.line.read, lineWrites as CoreLineWrite[], line.map, plain, { company: member.companyId, host: site.host, account: account as string })
        if (!derived || !keys || keys.length === 0) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
        writes = derived
        locks = keys
      }
      const now = clock.nowMs()
      const content: LinePlanContent = {
        shape: 2, company: member.companyId, user: member.userId, conversation: (body.conversationId as string | undefined) ?? null, line: ref,
        values, writes, locks, site: ref.site, host: site.host, account, createdAt: iso(now), expiresAt: iso(now + BROWSER_PLAN_TIMES.planLifetime),
      }
      const canonical = canonicalJson(content)
      const row: BrowserLinePlanRow = {
        id: `bl_${ids.newToken().slice(0, 32)}`, userId: member.userId, shape: 2, site: ref.site, lineName: ref.line, lineVersion: ref.version,
        mapVersion: ref.mapVersion, meaningHash: ref.meaningHash, mechanicsHash: ref.mechanicsHash, writes: writes.length, content: canonical,
        contentHash: hashCanonical(canonical), state: writing ? 'draft' : 'open', closeReason: null, createdAt: content.createdAt, expiresAt: content.expiresAt,
        approvedAt: null, closedAt: null, conversationId: content.conversation, result: null, reportedAt: null,
      }
      // The plan and the PC that made it, together: it goes on only on that registration.
      transactions.run(() => {
        repo(member.companyId).insertPlan(row)
        deps.devices.bind(member, 'line', row.id, passed.value.deviceId)
      })
      return ok(planView(member.companyId, row))
    },

    /** GET /browser-line-plans/:planId: the member's own plan (time-outs judged on this touch). */
    get(member: Member, planId: string): Outcome<BrowserLinePlanView> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      if (frozen(found)) return frozenRefusal()
      return transactions.run(() => {
        const now = clock.nowMs()
        const p = settlePlan(member.companyId, found, now)
        const e = repo(member.companyId).executionOfPlan(p.id)
        if (e) steps.settle(member.companyId, e, p, now)
        return ok(planView(member.companyId, repo(member.companyId).plan(p.id) as BrowserLinePlanRow))
      })
    },

    /**
     * POST /browser-line-plans/:planId/result: the inspection's result, once (fixed words: each read's status, each check's
     * ✓ / ✗ / 「読み取れませんでした」). Never a value the site showed. A report after the hour or a second one is refused.
     */
    result(member: Member, planId: string, body: unknown): Outcome<BrowserLinePlanView> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      if (frozen(found)) return frozenRefusal()
      const line = findLine(planRef(found))
      if (found.writes !== 0) return refuse('conflict', W.badResult, { code: 'BROWSER_NOT_AN_INSPECTION' })
      return transactions.run(() => {
        const now = clock.nowMs()
        const p = settlePlan(member.companyId, found, now)
        if (p.state === 'closed' && p.closeReason === 'expired') return refuse('conflict', W.expired, { code: 'BROWSER_PLAN_EXPIRED' })
        if (p.state === 'done') return refuse('conflict', W.resultDone, { code: 'BROWSER_RESULT_DONE' })
        if (p.state !== 'open') return refuse('conflict', W.notOpen, { code: 'BROWSER_PLAN_NOT_OPEN' })
        // The line as it was approved when the plan was made; a line retired since still takes its result (clean-up).
        if (!line) return refuse('conflict', W.notApproved, { code: 'BROWSER_LINE_NOT_APPROVED' })
        const result = parseResult(line, body)
        if (!result) return refuse('bad-request', W.badResult, { code: 'BROWSER_BAD_RESULT' })
        if (!repo(member.companyId).setPlanState(p.id, 'open', 'done', { result: canonicalJson(result), reportedAt: iso(now), closedAt: iso(now) })) {
          return refuse('conflict', W.resultDone, { code: 'BROWSER_RESULT_DONE' })
        }
        return ok(planView(member.companyId, repo(member.companyId).plan(p.id) as BrowserLinePlanRow))
      })
    },

    /** POST /browser-line-plans/:planId/approve { contentHash }: a plan of writes (none can be made in this build). */
    approve(member: Member, planId: string, body: unknown, deviceKey?: string): Outcome<BrowserLinePlanView> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      if (frozen(found)) return frozenRefusal()
      const shown = isMap(body) ? body.contentHash : undefined
      if (typeof shown !== 'string' || !HASH_RE.test(shown)) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      return transactions.run(() => {
        const now = clock.nowMs()
        const p = settlePlan(member.companyId, found, now)
        if (p.state === 'closed' && p.closeReason === 'expired') return refuse('conflict', W.expired, { code: 'BROWSER_PLAN_EXPIRED' })
        if (p.state !== 'draft') return refuse('conflict', W.notDraft, { code: 'BROWSER_PLAN_NOT_DRAFT' })
        if (shown !== p.contentHash) return refuse('conflict', W.contentChanged, { code: 'CONTENT_CHANGED' })
        const passed = writeGate(member, p, deviceKey)
        if (!passed.ok) return passed
        if (!repo(member.companyId).setPlanState(p.id, 'draft', 'approved', { approvedAt: iso(now) })) return refuse('conflict', W.notDraft, { code: 'BROWSER_PLAN_NOT_DRAFT' })
        return ok(planView(member.companyId, repo(member.companyId).plan(p.id) as BrowserLinePlanRow))
      })
    },

    /**
     * POST /browser-line-plans/:planId/cancel: an open inspection or a draft / approved plan closes; a claimed one gives the
     * rest back (`AppStopsBetween`: claimed → void; running with nothing open → partial). A write open may have been sent.
     */
    cancel(member: Member, planId: string): Outcome<BrowserLinePlanView> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      if (frozen(found)) return frozenRefusal()
      return transactions.run(() => {
        const now = clock.nowMs()
        const r = repo(member.companyId)
        const p = settlePlan(member.companyId, found, now)
        if (p.state === 'open' || p.state === 'draft' || p.state === 'approved') {
          if (!r.setPlanState(p.id, p.state, 'closed', { closedAt: iso(now), closeReason: 'cancelled' })) return refuse('conflict', W.notOpen, { code: 'BROWSER_PLAN_NOT_OPEN' })
        } else if (p.state === 'claimed') {
          const given = steps.giveBack(member.companyId, r.executionOfPlan(p.id) as BrowserLineExecutionRow, p, 'cancelled', now)
          if (!given.ok) return given
        } else return refuse('conflict', W.notOpen, { code: 'BROWSER_PLAN_NOT_OPEN' })
        return ok(planView(member.companyId, r.plan(p.id) as BrowserLinePlanRow))
      })
    },

    /** POST /browser-line-plans/:planId/claim: once per plan of writes; every lock in one transaction; the secret once. */
    claim(member: Member, planId: string, deviceKey?: string): Outcome<BrowserLineClaim> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      if (frozen(found)) return frozenRefusal()
      return transactions.run(() => {
        const now = clock.nowMs()
        const p = settlePlan(member.companyId, found, now)
        if (p.state === 'closed' && p.closeReason === 'expired') return refuse('conflict', W.expired, { code: 'BROWSER_PLAN_EXPIRED' })
        if (p.state !== 'approved' || p.writes === 0) return refuse('conflict', W.notApprovedYet, { code: 'BROWSER_PLAN_NOT_APPROVED' })
        const passed = writeGate(member, p, deviceKey)
        if (!passed.ok) return passed
        const secret = ids.newToken()
        const claimed = steps.claim(member.companyId, p, writesContent(contentOf(p)), tokenDigest.digest(secret), now)
        if (!claimed.ok) return claimed
        return ok({ executionId: claimed.value.executionId, secret, fixed: { content: p.content, contentHash: p.contentHash } })
      })
    },

    /** POST /browser-line-executions/:executionId/permit { index } (the secret in a header): one write's permit, the gate again. */
    permit(member: Member, executionId: string, secret: string | undefined, body: unknown, deviceKey?: string): Outcome<BrowserLinePermit> {
      if (!EXEC_ID_RE.test(executionId) || typeof secret !== 'string' || secret.length < 32 || secret.length > 200) return execMissing()
      const found = repo(member.companyId).execution(executionId)
      if (!found || found.userId !== member.userId || found.secretHash !== tokenDigest.digest(secret)) return execMissing()
      const index = isMap(body) && exactKeys(body, ['index']) && Number.isSafeInteger(body.index) ? body.index as number : null
      if (index === null || index < 1) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_WRITE_INDEX' })
      return transactions.run(() => {
        const now = clock.nowMs()
        const p = repo(member.companyId).plan(found.planId) as BrowserLinePlanRow
        if (frozen(p)) return frozenRefusal()
        const gateNow = (): Refusal | null => { const g = writeGate(member, p, deviceKey); return g.ok ? null : g }
        return steps.permit(member.companyId, found, p, writesContent(contentOf(p)), index, gateNow, now)
      })
    },

    /**
     * POST /api/browser-line-executions/report { index, result, reason?, createdId? } with the secret alone (the member may
     * have left). Every report is kept; a frozen shape's report is kept and answered 409.
     */
    report(secret: string | undefined, body: unknown): Outcome<BrowserLineReportAnswer> {
      if (typeof secret !== 'string' || secret.length < 32 || secret.length > 200) return refuse('unauthorized', 'Unauthorized')
      const where = executionLookup.bySecretHash(tokenDigest.digest(secret))
      if (!where) return refuse('unauthorized', 'Unauthorized')
      const results: readonly BrowserWriteResult[] = ['done', 'not_sent', 'unknown']
      if (!isMap(body) || Object.keys(body).some(k => !['index', 'result', 'reason', 'createdId'].includes(k)) || !Number.isSafeInteger(body.index) || (body.index as number) < 1
        || !(results as readonly unknown[]).includes(body.result) || (body.reason !== undefined && (typeof body.reason !== 'string' || !REASON_RE.test(body.reason)))
        || (body.createdId !== undefined && (typeof body.createdId !== 'string' || !CREATED_ID_RE.test(body.createdId)))) {
        return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_REPORT' })
      }
      // Only a word of the one list is kept (independent review L1): a slug-shaped word could carry text from a page.
      const reason = typeof body.reason === 'string' && (BROWSER_REPORT_REASONS as readonly string[]).includes(body.reason) ? body.reason : null
      const input = { index: body.index as number, result: body.result as BrowserWriteResult, reason, createdId: (body.createdId as string | undefined) ?? null }
      return transactions.run(() => {
        const now = clock.nowMs()
        const r = repo(where.companyId)
        const exec = r.execution(where.executionId)
        if (!exec) return refuse('unauthorized', 'Unauthorized')
        const p = r.plan(exec.planId) as BrowserLinePlanRow
        if (frozen(p)) {
          r.appendReport({ id: ids.newId(), executionId: exec.id, index: input.index, result: input.result, reason: input.reason, createdId: input.createdId, outcome: 'conflict', stateBefore: 'pending', at: iso(now) })
          return frozenRefusal()
        }
        return steps.report(where.companyId, exec, p, writesContent(contentOf(p)), input, now)
      })
    },

    /**
     * POST /browser-line-executions/:executionId/confirm { index, result }: the unknown write 「済んでいた / されていなかった」 —
     * the plan's member; an owner / admin once the member left or 24 hours after that write's permit; others 404.
     */
    confirm(member: Member, executionId: string, body: unknown): Outcome<BrowserLineExecutionView> {
      if (!EXEC_ID_RE.test(executionId)) return execMissing()
      const r = repo(member.companyId)
      const found = r.execution(executionId)
      if (!found) return execMissing()
      const mine = found.userId === member.userId
      if (!mine && !hasFullAccess(member.role)) return execMissing()
      const index = isMap(body) && exactKeys(body, ['index', 'result']) && Number.isSafeInteger(body.index) ? body.index as number : null
      const result = isMap(body) ? body.result : undefined
      if (index === null || (result !== 'done' && result !== 'not_done')) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_CONFIRM' })
      return transactions.run(() => {
        const now = clock.nowMs()
        const p = r.plan(found.planId) as BrowserLinePlanRow
        if (frozen(p)) return frozenRefusal()
        if (!mine) {
          const step = r.steps(found.id).find(s => s.index === index)
          const left = memberships.roleOf(member.companyId, found.userId) === null
          const late = !!step?.permittedAt && now >= ms(step.permittedAt) + BROWSER_PLAN_TIMES.adminConfirmAfter
          if (!left && !late) return refuse('forbidden', W.notYoursYet, { code: 'BROWSER_CONFIRM_NOT_YET' })
        }
        const done = steps.confirm(member.companyId, found, p, index, result, member.userId, now)
        return done.ok ? ok(executionView(member.companyId, done.value)) : done
      })
    },

    /** GET /browser-line-grants (owner/admin): the approved lines and who may use them. */
    grants(member: Member): Outcome<BrowserLineGrantsView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', W.manageForbidden)
      return ok(grantsView(member))
    },

    /**
     * GET /browser-lines-mine: the approved lines the member holds a grant in force for — names, labels and whether the line
     * writes, nothing else (the app's settings screen and request tool: whether to offer anything at all). Any member.
     */
    mine(member: Member): Outcome<BrowserLinesMine> {
      return ok({
        lines: load().lines.filter(l => l.row.status === 'approved' && granted(member, l.row))
          .map(l => ({ ...refOf(l), label: lineName(l), writes: l.row.line.writes !== undefined })),
      })
    },

    /**
     * PUT /browser-line-grants/:userId { site, line, meaningHash, mechanicsHash, allowed } (owner/admin): a grant only for
     * an approved row exactly; taking one away removes that exact grant.
     */
    setGrant(member: Member, userId: string, body: unknown): Outcome<BrowserLineGrantsView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', W.manageForbidden)
      if (memberships.roleOf(member.companyId, userId) === null) return refuse('not-found', W.memberNotFound)
      if (!isMap(body) || !exactKeys(body, ['site', 'line', 'meaningHash', 'mechanicsHash', 'allowed']) || typeof body.allowed !== 'boolean') {
        return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_GRANT' })
      }
      const { site, line, meaningHash, mechanicsHash } = body
      if (typeof site !== 'string' || !NAME_RE.test(site) || typeof line !== 'string' || !NAME_RE.test(line)
        || typeof meaningHash !== 'string' || !HASH_RE.test(meaningHash) || typeof mechanicsHash !== 'string' || !HASH_RE.test(mechanicsHash)) {
        return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_GRANT' })
      }
      const r = repo(member.companyId)
      if (!body.allowed) {
        // Unticking takes away every grant of this person on this line — the one given here and any a reviewed
        // grantsFrom carries (owner's 「使える人」 design §11): nothing stays in force behind the admin's back.
        r.removeLineGrantsOf(userId, site, line)
        return ok(grantsView(member))
      }
      const known = load().lines.some(l => l.row.status === 'approved' && l.row.site === site && l.row.name === line && l.row.meaningHash === meaningHash && l.row.mechanicsHash === mechanicsHash)
      if (!known) return refuse('bad-request', W.notApproved, { code: 'BROWSER_LINE_NOT_APPROVED' })
      r.saveGrant({ userId, site, lineName: line, meaningHash, mechanicsHash, grantedBy: member.userId, grantedAt: clock.now() })
      return ok(grantsView(member))
    },

    /**
     * POST /browser-shape-notices { site, mapVersion, thing, change, count }: a thing the app could not read whole (§16-1).
     * The map's own names (a map an approved line uses, a thing it has), a fixed kind and a count — no key name can be
     * sent. Only a member who may use the site and holds a grant on one of its approved lines; limits per member and
     * company a day; one notice per company × site × version × thing, every owner / admin told the first time.
     */
    shapeNotice(member: Member, body: unknown): Outcome<{ told: boolean }> {
      if (!isMap(body) || !exactKeys(body, ['site', 'mapVersion', 'thing', 'change', 'count'])) return refuse('bad-request', W.badNotice, { code: 'BROWSER_BAD_NOTICE' })
      const { site, mapVersion, thing, change, count } = body
      if (typeof site !== 'string' || typeof mapVersion !== 'string' || typeof thing !== 'string' || !(BROWSER_SHAPE_CHANGES as readonly unknown[]).includes(change)
        || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > BROWSER_MAP_LIMITS.answerPaths) {
        return refuse('bad-request', W.badNotice, { code: 'BROWSER_BAD_NOTICE' })
      }
      const o = load()
      const map = o.maps.find(m => m.site === site && m.version === mapVersion)?.map
      const lines = o.lines.filter(l => l.row.status === 'approved' && l.row.site === site)
      if (!map || !own(map.things, thing) || !lines.some(l => l.row.mapVersion === mapVersion)) return refuse('bad-request', W.badNotice, { code: 'BROWSER_BAD_NOTICE' })
      if (!siteAllowed(member, site, 'read') || !lines.some(l => granted(member, l.row))) return refuse('forbidden', W.notGranted, { code: 'BROWSER_TYPE_NOT_GRANTED' })
      const kind = change as BrowserShapeChange
      return transactions.run(() => {
        const now = clock.now()
        const day = now.slice(0, 10)
        const r = repo(member.companyId)
        // Only an accepted report is counted (Codex review): a member past their own limit never eats the company's.
        if (r.shapeReportsOf(member.userId, site, day) >= BROWSER_SHAPE_NOTICE_LIMITS.perMemberSiteDay) return refuse('rate-limited', W.tooManyNotices, { code: 'BROWSER_NOTICE_LIMIT' })
        if (r.shapeReportsOn(site, day) >= BROWSER_SHAPE_NOTICE_LIMITS.perCompanySiteDay) return refuse('rate-limited', W.tooManyNotices, { code: 'BROWSER_NOTICE_LIMIT' })
        r.countShapeReport(member.userId, site, day)
        const was = r.shapeNotice(site, mapVersion, thing)
        const counts = {
          unknownKeys: kind === 'unknown_keys' ? count as number : was?.unknownKeys ?? 0,
          missingKeys: kind === 'missing_keys' ? count as number : was?.missingKeys ?? 0,
          unreadable: kind === 'unreadable' ? count as number : was?.unreadable ?? 0,
        }
        r.saveShapeNotice({ site, mapVersion, thing, ...counts, reports: (was?.reports ?? 0) + 1, firstAt: was?.firstAt ?? now, lastAt: now })
        if (was) return ok({ told: false })
        const admins = deps.memberships.listByCompany(member.companyId).filter(m => hasFullAccess(m.role)).map(m => m.user_id)
        companyData.forCompany(member.companyId).notifications.insert(admins.map(userId => ({
          id: ids.newId(), userId, kind: BROWSER_SHAPE_NOTICE_KIND, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
          dedupeKey: `browser_shape:${site}:${mapVersion}:${thing}`, createdAt: now, readAt: null,
        })))
        try { deps.noticesChanged?.(member.companyId, admins) } catch { /* their own check catches up */ }
        return ok({ told: true })
      })
    },

    /** GET /browser-shape-notices (owner/admin): what changed shape, by the map's names and counts. */
    shapeNotices(member: Member): Outcome<{ items: BrowserShapeNoticeView[] }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', W.manageForbidden)
      return ok({ items: repo(member.companyId).shapeNotices().map(n => noticeView(n)) })
    },

    /** The inbox's text of a `browser_shape_changed` notice, built when read (owner / admin only; else not shown). */
    noticeText(member: Member, dedupeKey: string | null): string | null {
      if (!hasFullAccess(member.role) || !dedupeKey) return null
      const m = DEDUPE_RE.exec(dedupeKey)
      if (!m) return null
      const n = repo(member.companyId).shapeNotice(m[1], m[2], m[3])
      if (!n) return null
      const view = noticeView(n)
      const parts = [
        ...(n.unknownKeys > 0 ? [CHANGE_WORDS.unknown_keys(n.unknownKeys)] : []),
        ...(n.missingKeys > 0 ? [CHANGE_WORDS.missing_keys(n.missingKeys)] : []),
        ...(n.unreadable > 0 ? [CHANGE_WORDS.unreadable(n.unreadable)] : []),
      ]
      const site = siteOf(n.site)?.label ?? n.site
      return `ブラウザ操作：「${site}」の「${view.thingLabel}」の形が変わりました（${parts.join('・')}）。メンバーには手で作業してもらっています。地図の確かめが要ります`
    },

    /**
     * In removeMember's transaction: their open / draft / approved plans close (`left`), a claimed execution is void, a
     * running one with nothing open is partial (nothing more is sent), one with a write open stays (an owner / admin
     * confirms it; the app's report still counts), and their grants go.
     */
    memberLeft(companyId: string, userId: string): void {
      const r = repo(companyId)
      const now = clock.nowMs()
      // A shape this build does not know is left as it is (frozen: the build that knows it settles it).
      for (const p of r.plansOf(userId, ['open', 'draft', 'approved'])) if (!frozen(p)) r.setPlanState(p.id, p.state, 'closed', { closedAt: iso(now), closeReason: 'left' })
      for (const e of r.executionsOf(userId, ['claimed', 'running'])) {
        const p = r.plan(e.planId) as BrowserLinePlanRow
        if (frozen(p)) continue
        steps.giveBack(companyId, e, p, 'left', now)
      }
      r.removeGrantsOf(userId)
    },
  }
}

export type BrowserLineService = ReturnType<typeof createBrowserLineService>
