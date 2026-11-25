// 「ブラウザ操作」's writes on the new path, wired (generalization PR 5c; agent-browser.md "Writing on the new path"):
// the consultation AI proposes (`browser_write`: an approved line that writes, the numbers of what it names, the values it
// suggests) → a card for the member, held here in memory → the member confirms each value only a person may confirm, one by
// one (［確かめた］, person-confirmed provenance §16-4) → main reads the site through the member's own window (strict, GET
// only, between the account markers) and the server makes the plan of writes (its gate; the writes and locks derived from
// the line) → the card shows what was read and what will be done → ［任せる］ once → the write runner (write-line-runner.ts)
// → the card shows the result (§16-3: 済んだこと／していないこと／分からないこと／手でやること) and, for a write in doubt,
// ［済んでいた］［されていなかった］ from its time. No Electron: main.ts hands in the window controller, the policy, the
// session, the shared context and switch, the bundled maps, lines, declarations and the sites' writers.
//
// The AI gets fixed words only (`BROWSER_WRITE_WORDS`): never a value the site showed, the plan's values, a hash or a
// result. What the site showed lives on the member's card alone (never sent to the server, the AI, a log or the disk).
import { browserLineCatalog } from '../../../shared/browser-tool-catalog'
import { randomBytes } from 'node:crypto'
import type { IpcInvokeEvent, IpcMessageEvent, IpcRegistrar } from '../../ipc/registrar'
import type { BrowserOperationLevel } from '../../../../shared/core/browser-operation'
import { levelAllows } from '../../../../shared/core/browser-operation'
import type { BrowserOpenedFile, BrowserOpenedLine, BrowserOpenedLineRow } from '../../../../shared/core/browser-opened'
import { browserLineValuesProblem, type BrowserSuppliedValue } from '../../../../shared/core/browser-read-line'
import { browserWritesPlanProblem, type BrowserLineWrite, type BrowserState } from '../../../../shared/core/browser-write-line'
import { canonicalJson } from '../../../../shared/core/fixed-content'
import { BROWSER_ID_VALUE_RE } from '../../../../shared/core/plugin-browser-declaration'
import { parsePluginManifest } from '../../../../shared/core/plugin-manifest'
import type { BrowserLineRef } from '../../../../shared/types/browser-lines'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import { BROWSER_LINE_PLAN_ID_RE, BROWSER_WRITE_CARD_REF_RE } from '../../../shared/browser-inspection'
import {
  BROWSER_WRITE_CARD_WORDS as CW, BROWSER_WRITE_WORDS as W, browserStoppedLists, browserWriteSentences, lineWriteMechanicsProblem, writerKey,
  type BrowserLineWriters, type BrowserWriteCardValue, type BrowserWriteGetResult, type BrowserWriteResultView, type BrowserWriteView,
} from '../../../shared/browser-line-writes'
import type { BrowserPreviewSurface, BrowserRunSurface } from '../../../shared/browser-runner'
import approved from '../../../../shared/browser-connectors/approved.json'
import carried from '../../../../shared/browser-connectors/carried.json'
import opened from '../../../../shared/browser-connectors/opened.json'
import type { BrowserAiSwitch } from './ai-switch'
import { approvedBundledDeclarations } from './combination'
import type { BrowserContext } from './context'
import { createBrowserLinesHttp } from './lines-api'
import { createBrowserReadRunner } from './read-line-runner'
import type { BrowserInspectionSite } from './inspect'
import type { BrowserRunRecords } from './runner'
import { createBrowserWriteRunner, type BrowserWritePrepared, type BrowserWriteRunResult, type BrowserWriteRunSite } from './write-line-runner'

/** One site's map with its writers (client/connector-maps/<site>/, handed in by main.ts only). */
export interface BrowserWriteSite extends BrowserInspectionSite {
  writers: BrowserLineWriters
}

export interface BrowserWriteLinesDeps<E> {
  aiSwitch: BrowserAiSwitch
  fromMainWindow: (event: E) => boolean
  baseUrl: () => string
  cookies: () => string[]
  /** This PC's key header value (device.ts): only the plan client's gated steps send it. */
  deviceKey?: () => string | null
  userId: () => string | null
  context: BrowserContext
  stopped(companyId: string): boolean
  /** The site's level as the member's current valid policy lists it (null: off or not listed). */
  siteLevel(companyId: string, host: string): BrowserOperationLevel | null
  windows: {
    runWindow(companyId: string, host: string): BrowserRunSurface | null
    previewWindow(companyId: string, host: string): BrowserPreviewSurface | null
  }
  records: BrowserRunRecords
  /** The windows a run holds (shared with the old path's runner). */
  busyWindows: Set<string>
  sites: readonly BrowserWriteSite[]
  lines: readonly BrowserOpenedLine[]
  declarations: readonly string[]
  openedFile?: unknown
  approvedFile?: unknown
  carriedFile?: unknown
  fetch?: typeof fetch
  now?: () => number
  log?: Pick<Console, 'warn'>
}

export type BrowserWriteProposeOutcome = { kind: 'card'; cardId: string; words: string } | { kind: 'refused'; words: string }

interface Entry {
  userId: string
  companyId: string
  conversationId: string | null
  siteLabel: string
  site: BrowserWriteRunSite
  proposed: Record<string, string>
  confirmed: Set<string>
  phase: BrowserWriteView['phase']
  message: string | null
  planId: string | null
  contentHash: string | null
  prepared: BrowserWritePrepared | null
  card: BrowserWriteView['card']
  readAt: string | null
  run: BrowserWriteRunResult | null
  confirmFrom: string | null
}

const KEPT_CARDS = 100
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Why the card cannot go on, in plain words (never a server's text). */
const MESSAGES = {
  notMainWindow: 'このカードは、アプリのメインの窓の相談で開いてください（別の窓では開けません）。',
  badInput: '入力が正しくありません。',
  off: 'この機能は、このアプリではまだ使えません。',
  stopped: 'AI の動きが止められているため、続けられません。',
  noWindow: 'このパソコンでサイトの窓が開いていません。設定の「ブラウザ操作」で窓を開いてログインしてから、もう一度頼んでください。',
  readFailed: 'サイトを読み切れなかったので、計画を作りませんでした（サイトは何も変えていません）。',
  plan: 'この値では計画を作れません（複製元と同じ値になるなど）。相談で頼み直してください。',
  server: (code: string | null) => code === 'BROWSER_TYPE_NOT_GRANTED' ? 'この操作は、管理者からまだ任されていません。'
    : code === 'BROWSER_NOT_ALLOWED' ? 'この会社では、いまこのサイトに書き込めません（設定の段階が「入力・保存まで」ではないなど）。'
      : code === 'BROWSER_AI_STOPPED' ? 'AI の動きが止められているため、計画を作りませんでした。'
        : code === 'BROWSER_LINE_NOT_APPROVED' || code === 'BROWSER_LINE_RETIRED' ? 'この操作は、いまは使えません（まだ許可されていない、または取り下げられています）。'
          : 'サーバーが計画を受け付けませんでした。少し待ってから、相談で頼み直してください。',
  offline: 'サーバーにつながらなかったので、計画を作りませんでした。少し待ってから、もう一度押してください。',
  notReady: 'まだ任せられる状態ではありません。',
  changed: 'カードの中身が変わりました。もう一度確かめてください。',
  confirmFailed: '確かめを送れませんでした。少し待ってから、もう一度押してください。',
} as const

export function wireBrowserWriteLines<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E, IpcMessageEvent>, deps: BrowserWriteLinesDeps<E>) {
  const now = deps.now ?? Date.now
  const http = createBrowserLinesHttp({ baseUrl: deps.baseUrl, cookies: deps.cookies, deviceKey: deps.deviceKey, fetch: deps.fetch })
  const file = (deps.openedFile ?? opened) as BrowserOpenedFile
  // The site's operated host and name only from its reviewed declaration this build carries and the approved list approves.
  const declared = approvedBundledDeclarations(deps.approvedFile ?? approved, deps.carriedFile ?? carried, deps.declarations)
    .map(text => parsePluginManifest(text)).flatMap(r => (r.ok && r.value.browser ? [{ id: r.value.id, label: r.value.label, host: r.value.browser.host }] : []))
  const siteOf = (site: string): { host: string; label: string } | null => {
    const found = declared.filter(d => d.id === site)
    const hosts = new Set(found.map(d => d.host))
    return found.length > 0 && hosts.size === 1 ? { host: found[0].host, label: found[found.length - 1].label } : null
  }
  /**
   * What the AI is told it may ask in this company (agent-browser.md "The tools' words"): the bundled lines of this kind
   * whose row in the opened list is approved, on a site whose reviewed declaration this build carries **and the company
   * registered** (its current valid policy). A company that registered none of them hears no site's words.
   */
  const catalog = (companyId: string) => browserLineCatalog(
    deps.lines.filter(l => file.lines?.some(r => r.name === l.name && r.version === l.version && r.site === l.read.site && r.status === 'approved')),
    id => { const s = siteOf(id); return s && deps.siteLevel(companyId, s.host) !== null ? { id, label: s.label } : null }, 'write')
  const reader = createBrowserReadRunner({
    aiSwitch: deps.aiSwitch, stopped: deps.stopped, window: deps.windows.previewWindow, context: scope => deps.context.capture(scope), reporter: http, now,
  })
  const allowed = (companyId: string, host: string) => { const l = deps.siteLevel(companyId, host); return l !== null && levelAllows(l, 'write') }
  const runner = createBrowserWriteRunner({
    aiSwitch: deps.aiSwitch, api: http, read: input => reader.run(input), stopped: deps.stopped, allowed,
    window: (companyId, host) => {
      const run = deps.windows.runWindow(companyId, host)
      const preview = deps.windows.previewWindow(companyId, host)
      return run && preview ? { run, preview } : null
    },
    // The card's press has no conversation: the sign-in, the company's setting, quitting and the switch decide.
    context: () => deps.context.capture({ companyId: '' }),
    records: deps.records, now, busyWindows: deps.busyWindows, log: deps.log,
  })

  const entries = new Map<string, Entry>()
  const keep = (id: string, e: Entry) => {
    entries.delete(id)
    entries.set(id, e)
    while (entries.size > KEPT_CARDS) entries.delete(entries.keys().next().value as string)
  }

  /** The bundled line that writes, its map, its writers and its row — the very line and map the opened list holds — or null. */
  function lineOf(site: string, name: string): { line: BrowserOpenedLine; s: BrowserWriteSite; row: BrowserOpenedLineRow } | null {
    const line = deps.lines.find(l => l.read.site === site && l.name === name)
    const s = deps.sites.find(x => x.map.site === site)
    if (!line || !s || !line.writes || line.writes.length === 0) return null
    const rows = (isMap(file) && Array.isArray(file.lines) ? file.lines : []).filter(r => isMap(r) && r.site === site && r.name === name && r.version === line.version && r.mapVersion === s.map.version)
    const mapRows = (isMap(file) && Array.isArray(file.maps) ? file.maps : []).filter(m => isMap(m) && m.site === site && m.version === s.map.version)
    if (rows.length !== 1 || mapRows.length !== 1) return null
    try {
      if (canonicalJson(rows[0].line) !== canonicalJson(line) || canonicalJson(mapRows[0].map) !== canonicalJson(s.map)) return null
    } catch { return null }
    return { line, s, row: rows[0] }
  }

  /** Where a value comes from on this card: a target is the site's; a person's value only once confirmed here. */
  function supplied(e: Entry, confirmedOnly: boolean): Record<string, BrowserSuppliedValue> | null {
    const out: Record<string, BrowserSuppliedValue> = {}
    for (const [name, decl] of Object.entries(e.site.line.read.values)) {
      const value = e.proposed[name]
      if (decl.role === 'target') { out[name] = { value, from: { kind: 'site_fact' } }; continue }
      if (decl.from.includes('person')) { out[name] = { value, from: { kind: 'person', confirmed: e.confirmed.has(name) || !confirmedOnly } }; continue }
      if (decl.from.includes('ai')) { out[name] = { value, from: { kind: 'ai' } }; continue }
      return null
    }
    return out
  }

  /** `browser_write`: the AI's proposal → a card (values to confirm). Nothing is read, made or sent here. */
  async function propose(input: { companyId: string; conversationId: string | null; site: string; line: string; values: Record<string, string> }): Promise<BrowserWriteProposeOutcome> {
    const refused = (words: string): BrowserWriteProposeOutcome => ({ kind: 'refused', words })
    if (!deps.aiSwitch()) return refused(W.off)
    const userId = deps.userId()
    if (!userId || !BROWSER_COMPANY_ID_RE.test(input.companyId)) return refused(W.failed)
    const found = lineOf(input.site, input.line)
    if (!found) return refused(W.unknownLine)
    const { line, s, row } = found
    if (row.status !== 'approved') return refused(W.notApproved)
    // Every write needs its site's reviewed writer (none yet: the real ones come with the owner's test write, PR 7).
    for (const w of line.writes as BrowserLineWrite[]) {
      const r = line.read.reads.find(x => x.name === w.read)
      const writer = r ? s.writers[writerKey(r.thing, w.verb)] : undefined
      if (!writer || lineWriteMechanicsProblem(writer.mechanics)) return refused(W.notSupported)
    }
    const site = siteOf(line.read.site)
    if (!site) return refused(W.notApproved)
    const names = Object.keys(line.read.values)
    if (!isMap(input.values) || Object.keys(input.values).length !== names.length || !names.every(n => own(input.values, n) && typeof input.values[n] === 'string')) return refused(W.values)
    const ref: BrowserLineRef = { site: row.site, line: row.name, version: row.version, mapVersion: row.mapVersion, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash }
    const e: Entry = {
      userId, companyId: input.companyId, conversationId: input.conversationId, siteLabel: site.label,
      site: { host: site.host, ref, line, lineStatus: row.status, map: s.map, readers: s.readers, addresses: s.addresses, account: s.account, writers: s.writers },
      proposed: { ...input.values }, confirmed: new Set(), phase: 'confirming', message: null, planId: null, contentHash: null, prepared: null,
      card: null, readAt: null, run: null, confirmFrom: null,
    }
    // The shapes only (a person's value still unconfirmed passes as a shape check here): a number is a plain id, a date a day.
    const shapes = supplied(e, false)
    if (!shapes || browserLineValuesProblem(line.read, shapes)) return refused(W.values)
    if (!Object.entries(line.read.values).every(([n, d]) => d.role !== 'target' || BROWSER_ID_VALUE_RE.test(e.proposed[n]))) return refused(W.values)
    const cardId = `wp_${randomBytes(16).toString('hex')}`
    keep(cardId, e)
    // Nothing for a person to confirm (every value a target the read itself checks): read and make the draft now, as an
    // inspection reads on the AI's request; ［任せる］ is still the member's.
    if (!Object.values(line.read.values).some(d => d.role !== 'target' && d.from.includes('person'))) {
      await prepare(e).catch(() => { e.phase = 'failed'; e.message = MESSAGES.readFailed })
    }
    return { kind: 'card', cardId, words: W.proposed }
  }

  /** All values confirmed: main reads the site and the server makes the plan of writes (draft). */
  async function prepare(e: Entry): Promise<void> {
    e.phase = 'preparing'
    const fail = (message: string) => { e.phase = 'failed'; e.message = message }
    if (!deps.aiSwitch()) return fail(MESSAGES.off)
    if (deps.stopped(e.companyId)) return fail(MESSAGES.stopped)
    const win = deps.windows.previewWindow(e.companyId, e.site.host)
    if (!win || win.closed()) return fail(MESSAGES.noWindow)
    const values = supplied(e, true)
    if (!values || browserLineValuesProblem(e.site.line.read, values)) return fail(MESSAGES.badInput)
    const stillCurrent = deps.context.capture({ companyId: e.companyId })
    const read = await reader.run({
      companyId: e.companyId, host: e.site.host, line: e.site.line, lineStatus: e.site.lineStatus, map: e.site.map, readers: e.site.readers,
      addresses: e.site.addresses, account: e.site.account, values,
    })
    if (!stillCurrent()) return fail(MESSAGES.changed)
    if (read.status !== 'judged') return fail(MESSAGES.readFailed)
    e.card = read.card
    e.readAt = new Date(now()).toISOString()
    const account = read.facts.account?.before
    if (!read.ok || typeof account !== 'string' || account !== read.facts.account?.after) return fail(MESSAGES.readFailed)
    if (browserWritesPlanProblem(e.site.line.read, e.site.line.writes as BrowserLineWrite[], e.site.map, { ...read.facts, expectedAccount: account }, account)) return fail(MESSAGES.plan)
    const before: Record<string, BrowserState> = {}
    for (const r of e.site.line.read.reads) {
      const got = read.facts.reads[r.name]
      if (!got || got.status !== 'read') return fail(MESSAGES.readFailed)
      before[r.name] = got.state
    }
    const made = await http.createWrites(e.companyId, { line: e.site.ref, values, account, ...(e.conversationId ? { conversationId: e.conversationId } : {}) })
    if (made.kind === 'no-answer') return fail(MESSAGES.offline)
    if (made.kind === 'refused') return fail(MESSAGES.server(made.code))
    const v = made.value
    if (!isMap(v) || typeof v.id !== 'string' || !BROWSER_LINE_PLAN_ID_RE.test(v.id) || typeof v.contentHash !== 'string' || v.state !== 'draft') return fail(MESSAGES.server(null))
    e.planId = v.id
    e.contentHash = v.contentHash
    e.prepared = { values, account, before }
    e.phase = 'ready'
  }

  /** The server's view of the run (each write's state and the unknown one's confirm time), read again for the card. */
  async function refreshServer(e: Entry): Promise<void> {
    if (!e.planId || !e.run || e.run.outcome !== 'unknown') return
    const got = await http.get(e.companyId, e.planId)
    if (got.kind !== 'ok' || !isMap(got.value) || !isMap(got.value.execution) || !Array.isArray(got.value.execution.steps)) return
    const steps = got.value.execution.steps as Array<Record<string, unknown>>
    // A write still `permitted` there (its report lost, its window not yet past) is as unresolved as an unknown one.
    const open = steps.find(s => s.state === 'unknown' || s.state === 'permitted')
    e.confirmFrom = open && typeof open.confirmableAt === 'string' ? open.confirmableAt : null
    // A confirm (here or by an admin), or a late sure "done", settled it: take the server's states.
    const states = steps.map(s => String(s.state))
    if (!open && states.length === e.run.states.length) {
      e.run = { ...e.run, states: states.map(s => (s === 'skipped' ? 'pending' : s)) as BrowserWriteRunResult['states'], outcome: states.every(s => s === 'done' || s === 'confirmed_done') ? 'succeeded' : 'partial' }
    }
  }

  function resultView(e: Entry): BrowserWriteResultView | null {
    const r = e.run
    if (!r || r.outcome === 'refused') return null
    const sentences = browserWriteSentences(e.site.line, e.site.map, e.proposed)
    const lists = browserStoppedLists(sentences, r.states)
    const k = r.states.findIndex(s => s === 'unknown' || s === 'permitted') + 1
    const done = r.states.filter(s => s === 'done' || s === 'confirmed_done').length
    const headline = r.outcome === 'succeeded' ? CW.doneAll
      : r.outcome === 'unknown' ? CW.unknown(k || 1)
        : done === 0 ? CW.notSentAny : CW.partial(done, r.states.length)
    const confirm = r.outcome === 'unknown' ? { from: e.confirmFrom, canNow: e.confirmFrom !== null && Date.parse(e.confirmFrom) <= now() } : null
    return { outcome: r.outcome, headline, ...lists, confirm }
  }

  function viewOf(e: Entry): BrowserWriteView {
    const values: BrowserWriteCardValue[] = Object.entries(e.site.line.read.values).map(([name, decl]) => {
      const read = e.site.line.read.reads.find(r => 'value' in r.id && r.id.value === name)
      const field = (e.site.line.writes as BrowserLineWrite[]).flatMap(w => {
        if (w.verb !== 'create_from') return []
        const t = e.site.map.things[e.site.line.read.reads.find(r => r.name === w.read)?.thing ?? '']
        return Object.entries(w.set).filter(([, src]) => 'value' in src && src.value === name).map(([f]) => t?.fields[f]?.label ?? f)
      })[0]
      const label = read ? e.site.line.readLabels?.[read.name] ?? read.name : field ?? name
      const needsConfirm = decl.role !== 'target' && decl.from.includes('person')
      return { name, label, value: e.proposed[name], needsConfirm, confirmed: e.confirmed.has(name) }
    })
    return {
      title: CW.title(e.site.line.label), siteLabel: e.siteLabel, phase: e.phase, values,
      sentences: browserWriteSentences(e.site.line, e.site.map, e.proposed), card: e.card, readAt: e.readAt,
      contentHash: e.phase === 'ready' ? e.contentHash : null, message: e.message, result: resultView(e),
    }
  }

  /** This member's card from the main window's page, or why not. */
  function mine(event: E, companyId: unknown, cardId: unknown): { e: Entry } | { message: string } {
    if (!deps.fromMainWindow(event)) return { message: MESSAGES.notMainWindow }
    if (typeof companyId !== 'string' || !BROWSER_COMPANY_ID_RE.test(companyId) || typeof cardId !== 'string' || !BROWSER_WRITE_CARD_REF_RE.test(cardId)) return { message: MESSAGES.badInput }
    const userId = deps.userId()
    const e = entries.get(cardId)
    return e && userId && e.userId === userId && e.companyId === companyId ? { e } : { message: CW.gone }
  }
  const answer = (e: Entry): BrowserWriteGetResult => ({ ok: true, view: viewOf(e) })

  ipc.handle('browserLines:writeCard', async (event, companyId, cardId): Promise<BrowserWriteGetResult> => {
    const got = mine(event, companyId, cardId)
    if ('message' in got) return { ok: false, message: got.message }
    await refreshServer(got.e).catch(() => {})
    return answer(got.e)
  })

  // ［確かめた］: one value the person confirmed (only a value that needs it, only while confirming). The last one starts the
  // site's read and the server's plan; nothing is sent to the site.
  ipc.handle('browserLines:confirmValue', async (event, companyId, cardId, name): Promise<BrowserWriteGetResult> => {
    const got = mine(event, companyId, cardId)
    if ('message' in got) return { ok: false, message: got.message }
    const e = got.e
    const decl = typeof name === 'string' && Object.prototype.hasOwnProperty.call(e.site.line.read.values, name) ? e.site.line.read.values[name] : undefined
    if (e.phase !== 'confirming' || !decl || decl.role === 'target' || !decl.from.includes('person')) return { ok: false, message: MESSAGES.badInput }
    e.confirmed.add(name as string)
    const waiting = Object.entries(e.site.line.read.values).filter(([n, d]) => d.role !== 'target' && d.from.includes('person') && !e.confirmed.has(n))
    if (waiting.length === 0) await prepare(e).catch(() => { e.phase = 'failed'; e.message = MESSAGES.readFailed })
    return answer(e)
  })

  // ［任せる］: the hash the card showed, once; then the run (the only way to the write runner).
  ipc.handle('browserLines:runWrite', async (event, companyId, cardId, contentHash): Promise<BrowserWriteGetResult> => {
    const got = mine(event, companyId, cardId)
    if ('message' in got) return { ok: false, message: got.message }
    const e = got.e
    if (e.phase !== 'ready' || !e.planId || !e.prepared) return { ok: false, message: MESSAGES.notReady }
    if (typeof contentHash !== 'string' || contentHash !== e.contentHash) return { ok: false, message: MESSAGES.changed }
    e.phase = 'running'
    try {
      e.run = await runner.run({ companyId: e.companyId, planId: e.planId, contentHash, site: e.site, prepared: e.prepared })
    } catch {
      e.run = null
    }
    if (!e.run || e.run.outcome === 'refused') {
      e.phase = 'failed'
      e.message = e.run?.reason === 'off' ? MESSAGES.off : e.run?.reason === 'busy' ? 'このサイトの窓は、いま別の操作で使っています。少し待ってから、相談で頼み直してください。' : CW.notSentAny
      return answer(e)
    }
    e.phase = 'finished'
    await refreshServer(e).catch(() => {})
    return answer(e)
  })

  // ［済んでいた］［されていなかった］: the write in doubt only, the person's answer to the server (it decides when).
  ipc.handle('browserLines:confirmWrite', async (event, companyId, cardId, result): Promise<BrowserWriteGetResult> => {
    const got = mine(event, companyId, cardId)
    if ('message' in got) return { ok: false, message: got.message }
    const e = got.e
    const index = e.run ? e.run.states.findIndex(s => s === 'unknown') + 1 : 0
    if ((result !== 'done' && result !== 'not_done') || !e.run?.executionId || index < 1) return { ok: false, message: MESSAGES.badInput }
    const sent = await http.confirm(e.companyId, e.run.executionId, index, result)
    if (sent.kind !== 'ok') return { ok: false, message: MESSAGES.confirmFailed }
    const states = [...e.run.states]
    states[index - 1] = result === 'done' ? 'confirmed_done' : 'confirmed_not_done'
    e.run = { ...e.run, states, outcome: result === 'done' && index === states.length ? 'succeeded' : 'partial' }
    e.confirmFrom = null
    return answer(e)
  })

  return {
    /** Whether the write tool may exist at all (the switch, asked per turn). */
    writeAvailable: () => deps.aiSwitch(),
    catalog,
    propose,
    /** Sign-out: no card of the previous account stays in memory. */
    clear: () => entries.clear(),
  }
}

export type BrowserWriteLinesWiring = ReturnType<typeof wireBrowserWriteLines>
