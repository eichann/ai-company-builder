/**
 * The write side of an opened line in the app (generalization PR 5c; agent-browser.md "Writing on the new path"). Pure:
 * main, the renderer and the tests import it.
 *
 * - **A writer** (`BrowserLineWriter`) is a site's reviewed code that builds the ONE request of one write of a map thing
 *   (`<thing>.<verb>`), from the ids main hands it and the pages it reads (GET only, through the member's window's
 *   page-less read session), and — for a create — names the new object's id in the site's answer (a candidate only: main
 *   identifies it, C3). Its `mechanics` say what may be sent at all: the method, the exact path and the encoding; for a
 *   form write also every key and where its value comes from (`lineWriteRequestProblem` holds the built request to them —
 *   a form write carries exactly the declared keys with exactly the plan's values, plus the page's ignored fields).
 * - **The gate** (`createLineWriteGate`): the one rule for every request of a write run — the page's own writes refused
 *   for the whole run, the page's reads of the operated host only its parts without a query, nothing from main's write
 *   session but the one armed request, byte for byte, once.
 * - **The card's words** for a write plan: what will be done (`browserWriteSentences`, from the map's headings and the
 *   line's labels), and the stopped card's four lists (§16-3: 済んだこと／していないこと／分からないこと／手でやること).
 *   Built only from the map's and the line's words, the values the person confirmed and the ids main read — never the
 *   AI's word or a page's text.
 * - **The AI's words** (`BROWSER_WRITE_WORDS`): fixed sentences; never a site's value, a plan's value or a result's detail.
 */
import type { BrowserCard } from '../../shared/core/browser-card'
import type { BrowserMap } from '../../shared/core/browser-map'
import type { BrowserOpenedLine } from '../../shared/core/browser-opened'
import type { BrowserLineWrite } from '../../shared/core/browser-write-line'
import type { BrowserGateDecision, BrowserRunGateHooks } from './browser-runner'
import { readBrowserOperatorTrail, readBrowserStopNext, readBrowserStopScreen, type BrowserOperatorTrail, type BrowserStopNext, type BrowserStopScreen } from './browser-operator-trail'

/** A form write's value source: the written object's id, its parent's id, or the value the line adds. */
export type BrowserFormValueSource = '{id}' | '{parent}' | '{value}'

/** What a write of a map thing may send (site data, reviewed with its writer). */
export type BrowserLineWriteMechanics =
  | { method: 'POST'; path: string; encoding: 'form'; form: Readonly<Record<string, BrowserFormValueSource>>; ignoreBody: readonly string[] }
  | { method: 'POST'; path: string; encoding: 'json' | 'multipart' }

/** The one request a writer built. */
export interface BrowserLineWriteRequest {
  method: string
  path: string
  contentType: string
  body: string
}

/** What main hands a writer: the ids it built from the plan and the states it read before, and a read of the site. */
export interface BrowserLineWriteInput {
  /** `add_child`: the written object's id, its parent's id (or null) and the id the line adds. */
  ids?: { id: string; parent: string | null; value: string }
  /** `create_from`: the original's state as main read it, and each set field's value (a created id is the server's). */
  original?: Readonly<Record<string, unknown>>
  set?: Readonly<Record<string, string>>
  /** One GET of exactly this address through the member's window's page-less read session; null: no answer. */
  read(address: string): Promise<{ status: number; body: string } | null>
}

export type BrowserLineWriterBuilt = { request: BrowserLineWriteRequest } | { problem: 'csrf-missing' | 'read-failed' | 'plan' }

export interface BrowserLineWriter {
  mechanics: BrowserLineWriteMechanics
  build(input: BrowserLineWriteInput): Promise<BrowserLineWriterBuilt>
  /** A create's new id in the site's answer (a candidate: main identifies it), or null. */
  createdId?(answer: { status: number; body: string }): string | null
}

/** A site's writers by `<thing>.<verb>` (handed in by main.ts from the site's map folder; none = the line never writes). */
export type BrowserLineWriters = Readonly<Record<string, BrowserLineWriter>>

export const writerKey = (thing: string, verb: string) => `${thing}.${verb}`

const PLAIN_TOKEN_RE = /^[A-Za-z0-9+/=_.:-]{1,512}$/
const PATH_RE = /^\/[A-Za-z0-9/_.-]{1,200}$/
export const FORM_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'
/** A created id as the server records it (routes/browser-lines.ts `CREATED_ID_RE`). */
export const BROWSER_CREATED_ID_RE = /^[1-9][0-9]{0,18}$/

/** A mechanics' own problem (a path with a query, braces, dot segments; a form without keys), or null. */
export function lineWriteMechanicsProblem(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'shape'
  const x = m as Record<string, unknown>
  if (x.method !== 'POST') return 'method'
  if (typeof x.path !== 'string' || !PATH_RE.test(x.path) || x.path.split('/').some(s => s === '.' || s === '..') || x.path.includes('//')) return 'path'
  if (x.encoding === 'form') {
    const form = x.form as Record<string, unknown> | undefined
    if (!form || typeof form !== 'object' || Object.keys(form).length === 0) return 'form'
    if (!Object.values(form).every(v => v === '{id}' || v === '{parent}' || v === '{value}')) return 'form'
    if (!Array.isArray(x.ignoreBody) || !x.ignoreBody.every(k => typeof k === 'string' && !Object.prototype.hasOwnProperty.call(form, k))) return 'form'
    return null
  }
  return x.encoding === 'json' || x.encoding === 'multipart' ? null : 'encoding'
}

/**
 * Why a built request is not exactly what the mechanics let this write send, or null: the method, the exact path, and for
 * a form write the content type and every pair — the declared keys once each with exactly the plan's value, the ignored
 * keys once each with a plain token (the page's CSRF value), nothing else (no repeated key, no `_method`).
 */
export function lineWriteRequestProblem(m: BrowserLineWriteMechanics, request: BrowserLineWriteRequest, ids?: { id: string; parent: string | null; value: string }): string | null {
  if (lineWriteMechanicsProblem(m)) return 'mechanics'
  if (request.method !== m.method) return 'method'
  if (request.path !== m.path) return 'path'
  if (typeof request.body !== 'string' || request.body.length > 1_000_000) return 'body'
  if (m.encoding !== 'form') return typeof request.contentType === 'string' && request.contentType.length > 0 ? null : 'content-type'
  if (request.contentType !== FORM_TYPE || !ids) return 'content-type'
  const pairs = [...new URLSearchParams(request.body)]
  const keys = pairs.map(([k]) => k)
  if (new Set(keys).size !== keys.length) return 'repeated'
  const expected = Object.keys(m.form).length + m.ignoreBody.length
  if (pairs.length !== expected) return 'keys'
  for (const [k, v] of pairs) {
    if (Object.prototype.hasOwnProperty.call(m.form, k)) {
      const src = m.form[k]
      const want = src === '{id}' ? ids.id : src === '{parent}' ? ids.parent : ids.value
      if (want === null || v !== want) return 'value'
    } else if (m.ignoreBody.includes(k)) {
      if (!PLAIN_TOKEN_RE.test(v)) return 'ignored'
    } else return 'keys'
  }
  return null
}

/** The page's parts (scripts, styles, images, fonts) load as they are, without a query. */
const PAGE_PART_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font'])

function pathOf(url: string, host: string): { path: string; query: boolean } | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password || parsed.hostname !== host) return null
  const rest = url.replace(/^https:\/\/[^/?#]*/i, '')
  const cut = rest.search(/[?#]/)
  return { path: cut < 0 ? rest : rest.slice(0, cut), query: cut >= 0 }
}

/**
 * The gate of one write run (the window's `ai` mode and main's write session): the page's own writes refused for the whole
 * run, the page's reads of the operated host only its parts without a query (a GET with parameters may do something),
 * and from main's write session only the one armed request — the same method, path and body, byte for byte, never with a
 * query — once. Nothing while stopped. Main's reads never come here (they go through the read session's exact-GET rule).
 */
export function createLineWriteGate(options: { host: string; stopped: () => boolean }) {
  const { host, stopped } = options
  let armed: BrowserLineWriteRequest | null = null
  let sent = 0
  const refusals: string[] = []
  const refuse = (reason: string): BrowserGateDecision => { refusals.push(reason); return { allow: false, reason } }
  const hooks: BrowserRunGateHooks = {
    stopped: () => stopped(),
    pageRead(read) {
      let h: string
      try { h = new URL(read.url).hostname } catch { return false }
      if (h !== host) return true
      const at = pathOf(read.url, host)
      return !!at && !at.query && PAGE_PART_TYPES.has(read.resourceType)
    },
    sessionRequest(request) {
      const at = pathOf(request.url, host)
      if (!at) return refuse('host')
      if (stopped()) return refuse('stopped')
      if (at.query) return refuse('query')
      if (!armed) return refuse('not-armed')
      if (request.body === undefined) return refuse('no-body')
      if (request.method.toUpperCase() !== armed.method || at.path !== armed.path || request.body !== armed.body) return refuse('not-the-write')
      armed = null
      sent++
      return { allow: true }
    },
  }
  return {
    hooks,
    /** Lets exactly this request through once (the runner calls it right before the write). */
    arm(request: BrowserLineWriteRequest) { armed = { ...request, method: request.method.toUpperCase() } },
    disarm() { armed = null },
    /** How many writes the gate let through (tests). */
    sent: () => sent,
    refusals: (): readonly string[] => refusals,
  }
}

export type BrowserLineWriteGate = ReturnType<typeof createLineWriteGate>

// ---------------------------------------------------------------------------
// The card's words (built only from the map's and the line's words and the values the person confirmed)
// ---------------------------------------------------------------------------

/** One write as the card says it: what it does, in the map's headings. */
export function browserWriteSentences(line: BrowserOpenedLine, map: BrowserMap, values: Readonly<Record<string, string>>): string[] {
  const writes = (line.writes ?? []) as readonly BrowserLineWrite[]
  const labelOf = (read: string) => line.readLabels?.[read] ?? read
  const madeLabel: Record<string, string> = {}
  return writes.map(w => {
    const r = line.read.reads.find(x => x.name === w.read)
    const thing = r ? map.things[r.thing] : undefined
    if (!r || !thing) return '（読めない書き込み）'
    if (w.verb === 'add_child') {
      const field = thing.fields[w.field]?.label ?? w.field
      const valueRead = line.read.reads.find(x => 'value' in x.id && x.id.value === w.value)
      return `「${labelOf(w.read)}」の「${field}」に、「${valueRead ? labelOf(valueRead.name) : w.value}」を足す`
    }
    const parts = Object.entries(w.set).map(([f, src]) => {
      const heading = thing.fields[f]?.label ?? f
      if ('created' in src) return `${heading}は「${madeLabel[src.created] ?? src.created}」`
      const read = line.read.reads.find(x => 'value' in x.id && x.id.value === src.value)
      const text = read ? `「${labelOf(read.name)}」` : `「${values[src.value] ?? '—'}」`
      return `${heading}を${text}に`
    })
    madeLabel[w.as] = `新しい${thing.label}`
    return `新しい「${thing.label}」を作る（元：${labelOf(w.read)}。${parts.join('、')}）`
  })
}

/** A write's state as the card shows it (from the server's view of the execution, and this run's own result). */
export type BrowserWriteCardState = 'done' | 'not_sent' | 'unknown' | 'confirmed_done' | 'confirmed_not_done' | 'pending' | 'permitted'

/** The stopped card's four lists (§16-3): only writes surely not sent go to 「していないこと」 (§16-7 R4). */
export function browserStoppedLists(sentences: readonly string[], states: readonly BrowserWriteCardState[]): {
  done: string[]; notDone: string[]; unknown: string[]; byHand: string[]
} {
  const done: string[] = []
  const notDone: string[] = []
  const unknown: string[] = []
  sentences.forEach((s, i) => {
    const st = states[i] ?? 'pending'
    if (st === 'done' || st === 'confirmed_done') done.push(s)
    else if (st === 'unknown' || st === 'permitted') unknown.push(s)
    else notDone.push(s)
  })
  const byHand = unknown.length > 0 ? [] : notDone.map((s, i) => `${i + 1}. サイトの画面で、${s}`)
  return { done, notDone, unknown, byHand }
}

export const BROWSER_WRITE_CARD_WORDS = {
  title: (label: string) => `ブラウザ操作：${label}`,
  confirmHeading: '書く値を、1つずつ確かめてください（AI が提案した値です）',
  aiProposed: 'AI が提案した値',
  confirm: '確かめた',
  confirmed: '確かめました',
  targetsHeading: 'サイトから読む対象（番号）',
  willDo: 'これからすること',
  readHeading: 'アプリがサイトから読み取った情報（相談の AI には渡していません）',
  /** A write run's card: values the operator AI read on the page during its preview — read by an AI, never machine-checked. */
  previewValues: '下見で読んだ大事な値（ブラウザ操作の係の AI がページから読んだ値です。相談の AI には渡していません。機械で確かめた値ではありません）',
  entrust: '任せる',
  cancel: 'やめる',
  entrusting: '書いています…',
  preparing: 'サイトを読んで、計画を作っています…',
  doneAll: 'すべて済みました。書いたあと読んで、計画どおりの状態になっていることを確かめました。',
  notSentAny: '送る前に止めました。サイトは何も変えていません。',
  partial: (done: number, all: number) => `途中で止めました。${all}つのうち${done}つ目まで済んでいます。`,
  unknown: (k: number) => `${k}つ目が届いたか分かりません。`,
  doneList: '済んだこと',
  notDoneList: 'していないこと（送っていません）',
  unknownList: '分からないこと',
  byHandList: '手でやること',
  confirmUnknown: '［済んでいた］［されていなかった］は、サイトで確かめてから押してください。',
  confirmDone: '済んでいた',
  confirmNotDone: 'されていなかった',
  confirmAt: (hhmm: string) => `${hhmm} から確かめられます（まだ送られるかもしれないため）。`,
  noResend: 'もう一度は送りません。続きをやるときは、相談で頼み直してください（そのときは、今のサイトの状態から読み直します）。',
  gone: 'このカードは、このアプリを開き直したので消えました（サイトから読んだ値は、パソコンに残しません）。もう一度やるときは、相談で頼み直してください。',
} as const

/**
 * What the consultation AI gets back from `browser_write` (and nothing else): fixed words. Never a site's value, a value
 * the plan holds, the plan's hash or a run's detail — the card is the member's.
 */
export const BROWSER_WRITE_WORDS = {
  off: 'ブラウザ操作は、このアプリではまだ使えません。ユーザーにそう伝えてください。',
  badInput: '頼み方の形が正しくありません。site と line と values（番号と、書く値の案）を入れて、もう一度呼んでください。',
  unknownLine: 'その操作の種類は、このアプリにはありません。',
  notApproved: 'この操作は、いまは使えません（まだ許可されていない、または取り下げられています）。ユーザーにそう伝えてください。',
  notSupported: 'この操作は、このアプリではまだ書き込めません（サイトへの書き方がまだ入っていません）。ユーザーにそう伝えてください。',
  values: '値の形が正しくありません。ユーザーに、番号と書く値を確かめてもらってから、もう一度呼んでください。',
  proposed: 'カードを相談に出しました。ユーザーがカードで書く値を1つずつ確かめると、アプリがサイトを読んで計画を作り、ユーザーが［任せる］を押したときだけ書きます。' +
    'あなたには結果もサイトの値も届きません。値を推測して書かず、ユーザーにカードを見るよう伝えてください。',
  failed: 'カードを作れませんでした。サイトは何も変えていません。少し待ってから、もう一度頼むようユーザーに伝えてください。',
} as const

// ---------------------------------------------------------------------------
// The write card as main hands it to the renderer (`browserLines:writeCard`): memory only, this member's
// ---------------------------------------------------------------------------

/** One value on the card: a target (a number the site is read by) or a value to write (AI proposed, the person confirms). */
export interface BrowserWriteCardValue {
  name: string
  label: string
  value: string
  /** A value only a person may confirm (which / when, or a person's value to write): ［確かめた］ until confirmed. */
  needsConfirm: boolean
  confirmed: boolean
}

export type BrowserWriteCardPhase = 'confirming' | 'preparing' | 'ready' | 'running' | 'finished' | 'failed'

export interface BrowserWriteResultView {
  outcome: 'succeeded' | 'stopped' | 'failed' | 'partial' | 'unknown'
  headline: string
  done: string[]
  notDone: string[]
  unknown: string[]
  byHand: string[]
  /** The unknown write's confirm: from when (ISO, the server's estimate), and whether it can be pressed now. */
  confirm: { from: string | null; canNow: boolean } | null
}

export interface BrowserWriteView {
  title: string
  siteLabel: string
  phase: BrowserWriteCardPhase
  values: BrowserWriteCardValue[]
  sentences: string[]
  /** What main read from the site (the generic card), once read. */
  card: BrowserCard | null
  readAt: string | null
  /** The fixed content's hash the card shows (what ［任せる］ hands back). */
  contentHash: string | null
  /** A plain sentence (why it cannot go on), or null. */
  message: string | null
  result: BrowserWriteResultView | null
  /** ［やめる］ can be pressed (a write run's card waiting for ［任せる］, step ⑤b); absent: no such button. */
  cancellable?: boolean
  /** A write run's operator trail, its preview and its work (outside text, the person's card only; agent-browser.md "The operator's trail on the card"). */
  trail?: BrowserOperatorTrail
  /** What a write run that stopped asks of the member first (agent-browser.md "The stopped card asks one thing"); absent: nothing. */
  next?: BrowserStopNext
  /** The screen when it stopped to ask (beside `next` only; memory only: agent-browser.md "The stopped card shows the screen"). */
  screen?: BrowserStopScreen
}

export type BrowserWriteGetResult = { ok: true; view: BrowserWriteView } | { ok: false; message: string }

const isStrMax = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const strList = (v: unknown, n = 20): v is string[] => Array.isArray(v) && v.length <= n && v.every(x => isStrMax(x, 1000))
const PHASES: readonly BrowserWriteCardPhase[] = ['confirming', 'preparing', 'ready', 'running', 'finished', 'failed']
const OUTCOMES = ['succeeded', 'stopped', 'failed', 'partial', 'unknown']

/** A write card's view as the renderer is handed it (every field checked for its shape and copied alone), or null. */
export function readBrowserWriteView(v: unknown, readCard: (c: unknown) => BrowserCard | null): BrowserWriteView | null {
  if (!v || typeof v !== 'object') return null
  const x = v as Record<string, unknown>
  if (!isStrMax(x.title, 200) || !isStrMax(x.siteLabel, 200) || !PHASES.includes(x.phase as BrowserWriteCardPhase)) return null
  if (!Array.isArray(x.values) || x.values.length > 20 || !strList(x.sentences)) return null
  const values: BrowserWriteCardValue[] = []
  for (const raw of x.values) {
    const e = raw as Record<string, unknown>
    if (!e || !isStrMax(e.name, 64) || !isStrMax(e.label, 200) || !isStrMax(e.value, 400) || typeof e.needsConfirm !== 'boolean' || typeof e.confirmed !== 'boolean') return null
    values.push({ name: e.name, label: e.label, value: e.value, needsConfirm: e.needsConfirm, confirmed: e.confirmed })
  }
  const card = x.card === null ? null : readCard(x.card)
  if (x.card !== null && !card) return null
  if (!(x.readAt === null || isStrMax(x.readAt, 40)) || !(x.contentHash === null || (typeof x.contentHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(x.contentHash)))) return null
  if (!(x.message === null || isStrMax(x.message, 1000))) return null
  let result: BrowserWriteResultView | null = null
  if (x.result !== null) {
    const r = x.result as Record<string, unknown>
    if (!r || !OUTCOMES.includes(r.outcome as string) || !isStrMax(r.headline, 300) || !strList(r.done) || !strList(r.notDone) || !strList(r.unknown) || !strList(r.byHand)) return null
    let confirm: BrowserWriteResultView['confirm'] = null
    if (r.confirm !== null) {
      const c = r.confirm as Record<string, unknown>
      if (!c || !(c.from === null || isStrMax(c.from, 40)) || typeof c.canNow !== 'boolean') return null
      confirm = { from: c.from as string | null, canNow: c.canNow }
    }
    result = { outcome: r.outcome as BrowserWriteResultView['outcome'], headline: r.headline, done: [...r.done], notDone: [...r.notDone], unknown: [...r.unknown], byHand: [...r.byHand], confirm }
  }
  if (x.cancellable !== undefined && typeof x.cancellable !== 'boolean') return null
  // A trail not in its shape or past its caps is left off (the card itself still shows).
  const trail = x.trail === undefined ? null : readBrowserOperatorTrail(x.trail)
  // So is a `next` off its shape (the card then asks nothing; its fixed reason still shows).
  const next = x.next === undefined ? null : readBrowserStopNext(x.next)
  // The stop screen only beside what the card asks, and only in its exact shape (else left off; the card still shows).
  const screen = next && x.screen !== undefined ? readBrowserStopScreen(x.screen) : null
  return {
    title: x.title, siteLabel: x.siteLabel, phase: x.phase as BrowserWriteCardPhase, values, sentences: [...x.sentences], card,
    readAt: x.readAt as string | null, contentHash: x.contentHash as string | null, message: x.message as string | null, result,
    ...(x.cancellable === true ? { cancellable: true } : {}), ...(trail ? { trail } : {}), ...(next ? { next } : {}), ...(screen ? { screen } : {}),
  }
}
