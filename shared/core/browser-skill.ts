/**
 * A company Skill's browser declaration (`browser.yaml`, redesign step ⑥; agent-browser.md "A Skill's browser
 * declaration and its approval"). The FDE turns a recording into a company Skill; the core reads only this small file:
 * the domain the Skill operates, the write targets it may use with how many times each, the addresses that must never be
 * read (a GET that changes something), the addresses read again after writing, and an optional account marker. The
 * shape is the core's; every value is the company's. **This module knows no site.**
 *
 * Pure (shared-core.md): parsed with the core's strict YAML subset (`yaml-lite.ts`: no anchors, aliases, tags or block
 * scalars), then checked strictly — every object exactly its keys, every list and string within its limit. The server
 * reads the file from the company's own data (never from the app) and builds the write frames from it
 * (`browserSkillFrames`); the domain must be one the company registered (`browserSkillDomainProblem`).
 *
 * Path patterns share the recording's placeholders (`browser-recording.ts`): `{n}` a number, `{x}` any one segment; an
 * after-read address may also use `{created}` (what a write of this run created). A literal segment is plain ASCII
 * (`A–Z a–z 0–9 . _ ~ -`, never `.` or `..`), so an address cannot hide an encoded slash, a dot segment or a query.
 *
 * **What this run made** (agent-browser.md "Writes only to what this run made"): a write target may carry an `id`, and a
 * later target's path one `{made:<id>}` segment — that segment then fits only an id the named target's own write returned
 * in this same run (the server records it from the run's PC's report; `browser-frame-match.ts` asks it). An id named before
 * its target is declared, by the target itself or not declared at all is refused here. The parsed (and the server's
 * frames') path carries the target's place instead: `{made:2}` = the second write target, so the frames need no id.
 */
import { normalizeBrowserHost } from './browser-operation'
import { isSensitiveFieldName } from './browser-recording'
import { isYamlMap, parseYamlLite, type YamlValue } from './yaml-lite'

/** The file's name inside the Skill's folder. */
export const BROWSER_SKILL_FILE = 'browser.yaml'

export const BROWSER_SKILL_LIMITS = Object.freeze({
  /** The file's size in UTF-8 bytes. */
  bytes: 8 * 1024,
  writes: 16,
  /** A write target's most uses in one run. */
  max: 20,
  neverRead: 32,
  afterRead: 16,
  /** Fixed fields of one write target. */
  fields: 8,
  path: 200,
  segments: 16,
  queryParts: 5,
  fieldName: 64,
  fieldValue: 100,
  marker: 64,
})

export type BrowserSkillMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export const BROWSER_SKILL_METHODS: readonly BrowserSkillMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE']
/** What a body's `_method` may say (I4: only on a POST, and only when the frame names it). */
const OVERRIDE_METHODS = ['PUT', 'PATCH', 'DELETE'] as const

/** One write target: the method, the path pattern, at most `max` uses, and body fields that must hold exactly these values. */
export interface BrowserSkillWrite {
  method: BrowserSkillMethod
  path: string
  max: number
  fields: Readonly<Record<string, string>>
}

export interface BrowserSkillDeclaration {
  domain: string
  writes: readonly BrowserSkillWrite[]
  neverRead: readonly string[]
  afterRead: readonly string[]
  /** A generic account marker: the content of `<meta name="…">` on the site's pages. */
  accountMarker: { meta: string } | null
  /** Only `none` today (design memo §7-3: the optional safe patterns come later). */
  safePattern: 'none'
}

/** The frames the server builds from an approved declaration (what step ⑤'s permit checks a write against). */
export type BrowserSkillFrames = BrowserSkillDeclaration

/** Why a declaration is refused: fixed words (never a piece of the file). */
export type BrowserSkillProblem =
  | 'too-large'
  | 'not-yaml'
  | 'not-object'
  | 'unknown-key'
  | 'missing-key'
  | 'bad-domain'
  | 'bad-writes'
  | 'bad-method'
  | 'bad-path'
  | 'bad-max'
  | 'bad-fields'
  | 'bad-override'
  | 'duplicate-write'
  | 'bad-write-id'
  | 'bad-made'
  | 'bad-maker'
  | 'made-covered'
  | 'bad-never-read'
  | 'bad-after-read'
  | 'bad-account-marker'
  | 'bad-safe-pattern'
  | 'not-registered'

/** Plain Japanese for each problem (the admin's 「Skill の承認」 and refusals). */
export const BROWSER_SKILL_PROBLEM_WORDS: Readonly<Record<BrowserSkillProblem, string>> = Object.freeze({
  'too-large': '宣言のファイルが大きすぎます（8KB まで）。',
  'not-yaml': '宣言のファイルを読めません（書き方が決まりに合っていません）。',
  'not-object': '宣言のファイルの形が決まりに合っていません。',
  'unknown-key': '宣言に、決まりにない項目があります。',
  'missing-key': '宣言に、必要な項目（domain・writes）がありません。',
  'bad-domain': '宣言のドメインの書き方が決まりに合っていません。',
  'bad-writes': '書き込み先の一覧の書き方が決まりに合っていません。',
  'bad-method': '書き込み先の方法は POST・PUT・PATCH・DELETE のどれかにしてください。',
  'bad-path': '書き込み先のアドレスの書き方が決まりに合っていません。',
  'bad-max': '書き込み先の回数は 1〜20 にしてください。',
  'bad-fields': '書き込み先の決まった項目の書き方が決まりに合っていません。',
  'bad-override': '_method は POST の書き込み先にだけ、PUT・PATCH・DELETE のどれかで書けます。',
  'duplicate-write': '同じ書き込み先が2回書かれています。',
  'bad-write-id': '書き込み先の名前（id）は、英小文字で始まる英小文字・数字・ハイフン（32文字まで）で、ほかと重ならないようにしてください。',
  'bad-made': '「この作業で作ったもの」の指定（{made:名前}）は、それより前に書いた書き込み先の名前を1つだけ指してください。',
  'bad-maker': '名前（id）をつけられるのは、新しく作る書き込み先（_method のない POST）だけです。',
  'made-covered': '「この作業で作ったもの」にだけ書く書き込み先と同じ方法で、ほかのものにも書ける広い書き込み先があります。',
  'bad-never-read': '読んではいけないアドレスの書き方が決まりに合っていません。',
  'bad-after-read': '書いたあとに読むアドレスの書き方が決まりに合っていません。',
  'bad-account-marker': 'アカウントの目印の書き方が決まりに合っていません。',
  'bad-safe-pattern': '安全な型は、いまは none だけです。',
  'not-registered': '宣言のドメインが、この会社のブラウザ操作に登録されていません。',
})

export type BrowserSkillParse = { ok: true; declaration: BrowserSkillDeclaration } | { ok: false; problem: BrowserSkillProblem }

const TOP_KEYS = ['domain', 'writes', 'never_read', 'after_read', 'account_marker', 'safe_pattern'] as const
const WRITE_KEYS = ['id', 'method', 'path', 'max', 'fields'] as const
/** A write target's name (`id`), what a later target's `{made:<id>}` refers to. */
export const BROWSER_SKILL_WRITE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
const MADE_BY_ID_RE = /^\{made:([a-z][a-z0-9-]{0,31})\}$/
const MADE_BY_PLACE_RE = /^\{made:([1-9][0-9]?)\}$/

/**
 * The write target whose own write's id a frame path's `{made:<n>}` segment stands for (1-based, the parsed form), or
 * null when the path has none. Every `{made:…}` path holds exactly one such segment (the parser's rule).
 */
export function browserMadeFrom(path: string): number | null {
  for (const seg of path.split('?')[0].split('/')) {
    const m = MADE_BY_PLACE_RE.exec(seg)
    if (m) return Number(m[1])
  }
  return null
}

/** The `{made:<n>}` segment of the parsed form (`browser-frame-match.ts` reads it). */
export const browserMadeSegmentPlace = (segment: string): number | null => {
  const m = MADE_BY_PLACE_RE.exec(segment)
  return m ? Number(m[1]) : null
}

const isMap = (v: unknown): v is Record<string, YamlValue> => isYamlMap(v as YamlValue | undefined)
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every(k => allowed.includes(k))

/** UTF-8 length without a package or a Node built-in. */
function utf8Length(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

const LITERAL_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/
const QUERY_WORD_RE = /^[A-Za-z0-9._~-]+$/

/**
 * A path pattern: `/` + segments, each a plain literal (not `.` / `..`) or a placeholder (`{n}`, `{x}`, and `{created}`
 * only where allowed); a trailing `/` is kept; a query only where allowed (`key` or `key=value`, plain words).
 */
export function isBrowserSkillPath(s: unknown, allow: { query?: boolean; created?: boolean; made?: boolean } = {}): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > BROWSER_SKILL_LIMITS.path || !s.startsWith('/')) return false
  const q = s.indexOf('?')
  const path = q === -1 ? s : s.slice(0, q)
  const segments = path.split('/').slice(1)
  if (segments.length > BROWSER_SKILL_LIMITS.segments) return false
  const ok = segments.every((seg, i) => {
    if (seg === '') return i === segments.length - 1 // `/` alone, or a trailing slash
    if (seg === '{n}' || seg === '{x}') return true
    if (seg === '{created}') return allow.created === true
    if (MADE_BY_ID_RE.test(seg)) return allow.made === true
    return LITERAL_SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..'
  })
  if (!ok) return false
  if (q === -1) return true
  if (!allow.query) return false
  const parts = s.slice(q + 1).split('&')
  if (parts.length > BROWSER_SKILL_LIMITS.queryParts) return false
  return parts.every((p) => {
    const [k, v, ...rest] = p.split('=')
    return rest.length === 0 && QUERY_WORD_RE.test(k) && (v === undefined || QUERY_WORD_RE.test(v))
  })
}

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.[\]-]*$/
const FIELD_VALUE_RE = /^[A-Za-z0-9_.:-]+$/

function fieldsOf(v: unknown): Record<string, string> | null {
  if (v === undefined) return {}
  if (!isMap(v)) return null
  const keys = Object.keys(v)
  if (keys.length > BROWSER_SKILL_LIMITS.fields) return null
  const out: Record<string, string> = {}
  for (const k of keys) {
    if (k.length > BROWSER_SKILL_LIMITS.fieldName || !FIELD_NAME_RE.test(k)) return null
    // A login, CSRF or session value never belongs in a company file (the page puts it in; the core never sees it).
    if (isSensitiveFieldName(k)) return null
    const raw = v[k]
    const value = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw
    if (typeof value !== 'string' || value.length > BROWSER_SKILL_LIMITS.fieldValue || !FIELD_VALUE_RE.test(value)) return null
    out[k] = value
  }
  return out
}

/** A write target as written: its own `id` (or null) beside the write; the path may still name `{made:<id>}`. */
function writeOf(v: unknown): { id: string | null; write: BrowserSkillWrite } | BrowserSkillProblem {
  if (!isMap(v) || !onlyKeys(v, WRITE_KEYS)) return 'bad-writes'
  if (v.method === undefined || v.path === undefined || v.max === undefined) return 'bad-writes'
  if (v.id !== undefined && (typeof v.id !== 'string' || !BROWSER_SKILL_WRITE_ID_RE.test(v.id))) return 'bad-write-id'
  if (typeof v.method !== 'string' || !(BROWSER_SKILL_METHODS as readonly string[]).includes(v.method)) return 'bad-method'
  if (!isBrowserSkillPath(v.path, { made: true })) return 'bad-path'
  if (typeof v.max !== 'number' || !Number.isSafeInteger(v.max) || v.max < 1 || v.max > BROWSER_SKILL_LIMITS.max) return 'bad-max'
  const fields = fieldsOf(v.fields)
  if (!fields) return 'bad-fields'
  const method = v.method as BrowserSkillMethod
  if ('_method' in fields) {
    if (method !== 'POST' || !(OVERRIDE_METHODS as readonly string[]).includes(fields._method)) return 'bad-override'
  }
  // Only a create names what it made: a write that changes something that already exists (another method, an override)
  // would hand on an id the run did not make (independent review).
  if (v.id !== undefined && (method !== 'POST' || '_method' in fields)) return 'bad-maker'
  return { id: (v.id as string | undefined) ?? null, write: { method, path: v.path, max: v.max, fields: Object.freeze(fields) } }
}

/**
 * The path with its `{made:<id>}` segment turned into the place of the target that id names (`{made:2}`), or `bad-made`:
 * more than one such segment, or an id no **earlier** target carries (`earlier`: id → 1-based place).
 */
function placeMade(path: string, earlier: ReadonlyMap<string, number>): string | 'bad-made' {
  let found = 0
  const out = path.split('/').map((seg) => {
    const m = MADE_BY_ID_RE.exec(seg)
    if (!m) return seg
    found++
    const place = earlier.get(m[1])
    return place === undefined ? null : `{made:${place}}`
  })
  if (found === 0) return path
  if (found > 1 || out.some(seg => seg === null)) return 'bad-made'
  return out.join('/')
}

function pathList(v: unknown, allow: { query?: boolean; created?: boolean }, limit: number): string[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > limit) return null
  if (!v.every(p => isBrowserSkillPath(p, allow))) return null
  if (new Set(v).size !== v.length) return null
  return [...(v as string[])]
}

const MARKER_RE = /^[a-z][a-z0-9_.:-]*$/

/** The parsed value checked strictly; null problem = the declaration. */
export function browserSkillDeclarationFrom(value: unknown): BrowserSkillParse {
  if (!isMap(value)) return { ok: false, problem: 'not-object' }
  if (!onlyKeys(value, TOP_KEYS)) return { ok: false, problem: 'unknown-key' }
  if (value.domain === undefined || value.writes === undefined) return { ok: false, problem: 'missing-key' }
  const domain = value.domain
  if (typeof domain !== 'string' || normalizeBrowserHost(domain) !== domain) return { ok: false, problem: 'bad-domain' }
  if (!Array.isArray(value.writes) || value.writes.length === 0 || value.writes.length > BROWSER_SKILL_LIMITS.writes) {
    return { ok: false, problem: 'bad-writes' }
  }
  const writes: BrowserSkillWrite[] = []
  const seen = new Set<string>()
  /** The ids declared so far → their place (a `{made:<id>}` may name only one of these: never itself or a later one). */
  const ids = new Map<string, number>()
  for (const w of value.writes) {
    const parsed = writeOf(w)
    if (typeof parsed === 'string') return { ok: false, problem: parsed }
    const path = placeMade(parsed.write.path, ids)
    if (path === 'bad-made') return { ok: false, problem: 'bad-made' }
    const write: BrowserSkillWrite = { ...parsed.write, path }
    if (parsed.id !== null) {
      if (ids.has(parsed.id)) return { ok: false, problem: 'bad-write-id' }
      ids.set(parsed.id, writes.length + 1)
    }
    const key = JSON.stringify([write.method, write.path, Object.entries(write.fields).sort(([a], [b]) => (a < b ? -1 : 1))])
    if (seen.has(key)) return { ok: false, problem: 'duplicate-write' }
    seen.add(key)
    writes.push(Object.freeze(write))
  }
  // A `{made}` target means "only what this run made" only when no other target of the same method fits those addresses
  // too (`/a/{x}/items` beside `/a/{made:1}/items` would take any id): refused (independent review).
  for (const w of writes) {
    if (browserMadeFrom(w.path) === null) continue
    if (writes.some(o => o !== w && o.method === w.method && patternCovers(o.path, w.path))) return { ok: false, problem: 'made-covered' }
  }
  const neverRead = pathList(value.never_read, { query: true }, BROWSER_SKILL_LIMITS.neverRead)
  if (!neverRead) return { ok: false, problem: 'bad-never-read' }
  const afterRead = pathList(value.after_read, { created: true }, BROWSER_SKILL_LIMITS.afterRead)
  if (!afterRead) return { ok: false, problem: 'bad-after-read' }
  let accountMarker: { meta: string } | null = null
  if (value.account_marker !== undefined) {
    const m = value.account_marker
    if (!isMap(m) || !onlyKeys(m, ['meta']) || typeof m.meta !== 'string' || m.meta.length > BROWSER_SKILL_LIMITS.marker || !MARKER_RE.test(m.meta)) {
      return { ok: false, problem: 'bad-account-marker' }
    }
    accountMarker = Object.freeze({ meta: m.meta })
  }
  if (value.safe_pattern !== undefined && value.safe_pattern !== 'none') return { ok: false, problem: 'bad-safe-pattern' }
  return {
    ok: true,
    declaration: Object.freeze({
      domain,
      writes: Object.freeze(writes),
      neverRead: Object.freeze(neverRead),
      afterRead: Object.freeze(afterRead),
      accountMarker,
      safePattern: 'none' as const,
    }),
  }
}

/**
 * Whether every address `made` (a `{made:<n>}` pattern) fits could also fit `other`: the same number of segments, and at
 * each one the same text, `{x}` (any segment), or `{n}` / another `{made}` where `made` has a placeholder (an id may be
 * digits). On the safe side: overlap is enough.
 */
function patternCovers(other: string, made: string): boolean {
  const o = other.split('/')
  const m = made.split('/')
  if (o.length !== m.length) return false
  return o.every((seg, i) => {
    if (seg === m[i] || seg === '{x}') return true
    const placeholder = m[i].startsWith('{')
    return placeholder && (seg === '{n}' || browserMadeSegmentPlace(seg) !== null)
  })
}

/** The file's text → the declaration (size first, then the strict YAML subset, then the strict shape). */
export function parseBrowserSkillDeclaration(text: string): BrowserSkillParse {
  if (utf8Length(text) > BROWSER_SKILL_LIMITS.bytes) return { ok: false, problem: 'too-large' }
  const parsed = parseYamlLite(text)
  if (!parsed.ok) return { ok: false, problem: 'not-yaml' }
  return browserSkillDeclarationFrom(parsed.value)
}

/** Null when the declaration's domain is exactly one the company registered now, else `not-registered`. */
export function browserSkillDomainProblem(declaration: Pick<BrowserSkillDeclaration, 'domain'>, registeredHosts: readonly string[]): 'not-registered' | null {
  return registeredHosts.includes(declaration.domain) ? null : 'not-registered'
}

/**
 * The frames built from a declaration the server read and checked itself — a deep copy, so nothing a caller holds can
 * change what a later permit compares against.
 */
export function browserSkillFrames(declaration: BrowserSkillDeclaration): BrowserSkillFrames {
  return Object.freeze({
    domain: declaration.domain,
    writes: Object.freeze(declaration.writes.map(w => Object.freeze({ method: w.method, path: w.path, max: w.max, fields: Object.freeze({ ...w.fields }) }))),
    neverRead: Object.freeze([...declaration.neverRead]),
    afterRead: Object.freeze([...declaration.afterRead]),
    accountMarker: declaration.accountMarker ? Object.freeze({ meta: declaration.accountMarker.meta }) : null,
    safePattern: 'none' as const,
  })
}

const METHOD_WORDS: Readonly<Record<BrowserSkillMethod, string>> = Object.freeze({
  POST: '送る（作る・保存する）',
  PUT: '置き換える',
  PATCH: '一部を変える',
  DELETE: '消す',
})

/**
 * One write target in plain words for the admin's 「Skill の承認」 and the member's card (the path and fields are the
 * company's data). A `{made:<n>}` target says that it writes only to what this run made with the n-th target.
 */
export function browserSkillWriteLine(write: BrowserSkillWrite): string {
  const effective = write.fields._method as BrowserSkillMethod | undefined
  const what = METHOD_WORDS[effective ?? write.method]
  const fixed = Object.entries(write.fields).map(([k, v]) => `${k}=${v}`)
  const made = browserMadeFrom(write.path)
  const only = made === null ? '' : `（この作業の中で、${made}つ目の書き込み先で作ったものにだけ）`
  return `${write.path} に${what}：${write.max}回まで${only}${fixed.length > 0 ? `（決まった項目：${fixed.join('、')}）` : ''}`
}
