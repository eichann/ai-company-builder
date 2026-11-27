/**
 * A draft of a company Skill's `browser.yaml`, made from a person's own recordings (agent-browser.md "A Skill's draft from a
 * recording"). Pure (shared-core.md); **knows no site** — every word it writes comes from the recordings, which hold no
 * value (browser-recording.ts).
 *
 * Two rules, one copy for the server and the app:
 *
 * - `browserSkillDraftFrom(recordings)`: the write targets the person really sent, as a declaration the core's parser reads.
 *   Only writes the site took (2xx / 3xx) count; a write with the method DELETE (or `_method=DELETE`), one whose address
 *   begins with a placeholder (it could be any path), one whose method override the declaration cannot say are left out,
 *   each with a fixed reason. **A query is named only when the recording says it was sent exactly as kept** (format 2's
 *   `bareQuery`: names only, plain words, once — `?return`); a query that carried a value, or one a format-1 recording
 *   cannot vouch for, leaves its write out (`query-values`): the kept form drops values, so naming it would permit a request
 *   the person never sent (Codex review of the design memo). `{made:<id>}` is put where a path's one placeholder most likely
 *   holds what one earlier create of the same recording made (its answer carried `id` / `data.id`, the ids the app
 *   reports): it then fits only an id the site handed this run, never any number — whether that endpoint really mints its
 *   ids is the reviewer's check at 「Skill の承認」, as for every `{made}`. Each write carries marks for the person and the
 *   reviewer: it changes something that already exists (`updates-existing`), its body names an id field not taken from an
 *   earlier answer (`id-in-body`: fixing its value for a create keeps it from changing an existing one), its address says
 *   delete / remove in a word (`may-delete`: only the method DELETE is left out; a POST can delete too). The same recordings
 *   always give the same text, and that text always parses.
 * - `browserSkillDraftCoveredProblem(draft, base)`: a change of a draft's declaration is taken only when it is no wider
 *   than what was made from the recordings (`base`): each write fits one base write — the same method, query and method
 *   override, a path the same or narrower at every segment, every fixed field of the base kept —, the uses of the draft
 *   writes a base write covers together at most 20 (one target split into many literal ones keeps one budget), never a
 *   delete, never a path beginning with a placeholder, the same domain. Reads (`never_read`, `after_read`) and the account
 *   marker may be added: they only narrow.
 */
import { browserRecordingProblem, type BrowserRecordedSend, type BrowserRecordingContent } from './browser-recording'
import { browserMadeSegmentPlace, browserSkillQueryProblem, BROWSER_SKILL_LIMITS, isBrowserSkillPath, parseBrowserSkillDeclaration, type BrowserSkillDeclaration, type BrowserSkillWrite } from './browser-skill'
import { browserWriteAnswerKind } from './browser-frame-match'

export const BROWSER_SKILL_DRAFT_LIMITS = Object.freeze({
  /** Recordings one draft is made from (the person's own, of one domain). */
  recordings: 5,
})

/** Why a recorded write is not in the draft: fixed words. */
export type BrowserSkillDraftLeftOut = 'no-answer' | 'not-taken' | 'deletes' | 'wide-path' | 'bad-path' | 'query' | 'query-values' | 'override'
/** What the person and the reviewer are told about a write of the draft: fixed words. */
export type BrowserSkillDraftMark = 'updates-existing' | 'id-in-body' | 'may-delete'
/** Why no draft is made. */
export type BrowserSkillDraftRefusal = 'not-a-recording' | 'domains' | 'too-many-recordings' | 'no-writes' | 'too-many-writes'

export interface BrowserSkillDraftWriteNote {
  /** The write's place in the declaration (1-based, as `{made:<n>}` counts). */
  write: number
  marks: readonly BrowserSkillDraftMark[]
  /** The body fields `id-in-body` names (the recording's kept names). */
  idFields: readonly string[]
  /** Where it was seen: the recording (0-based) and the step id. */
  seen: ReadonlyArray<{ recording: number; step: number }>
}

export interface BrowserSkillDraft {
  /** The declaration's text (`browser.yaml`), in one fixed spelling. */
  text: string
  declaration: BrowserSkillDeclaration
  writes: readonly BrowserSkillDraftWriteNote[]
  leftOut: ReadonlyArray<{ recording: number; step: number; reason: BrowserSkillDraftLeftOut }>
}

export type BrowserSkillDraftResult = { ok: true; draft: BrowserSkillDraft } | { ok: false; refusal: BrowserSkillDraftRefusal }

export const BROWSER_SKILL_DRAFT_WORDS = Object.freeze({
  marks: Object.freeze({
    'updates-existing': 'すでにあるものを変える書き込みです。',
    'id-in-body': '送る中身に番号らしい欄があります。新しく作るときの値を決めておくと、すでにあるものを変えられなくなります。',
    'may-delete': 'アドレスに「消す」にあたる言葉があります。消す書き込みかもしれません。',
  } satisfies Record<BrowserSkillDraftMark, string>),
  leftOut: Object.freeze({
    'no-answer': 'サイトから答えがなかった書き込みは入れていません。',
    'not-taken': 'サイトが受け付けなかった書き込みは入れていません。',
    deletes: '消す書き込みは、下書きには入れていません。',
    'wide-path': 'どこにでも書ける形のアドレスは入れていません。',
    'bad-path': '決まりで書けない形のアドレスは入れていません。',
    query: 'アドレスの ? のあとが決まりで書けない形の書き込みは入れていません。',
    'query-values': 'アドレスの ? のあとに値があった（または記録から分からない）書き込みは入れていません。',
    override: '決まりで書けない方法の書き込みは入れていません。',
  } satisfies Record<BrowserSkillDraftLeftOut, string>),
  refusals: Object.freeze({
    'not-a-recording': '記録の形が決まりに合っていません。',
    domains: '同じサイトの記録だけから下書きを作れます。',
    'too-many-recordings': `下書きは記録${BROWSER_SKILL_DRAFT_LIMITS.recordings}つまでから作れます。`,
    'no-writes': '記録に、下書きにできる書き込みがありません。',
    'too-many-writes': `書き込み先が多すぎます（${BROWSER_SKILL_LIMITS.writes}まで）。`,
  } satisfies Record<BrowserSkillDraftRefusal, string>),
})

const isPlaceholder = (seg: string) => seg.startsWith('{')
const ANSWER_ID_KEYS = ['id', 'data.id']

interface DraftTarget {
  method: BrowserSkillWrite['method']
  override: 'PUT' | 'PATCH' | null
  path: string
  query: string | null
  seen: Array<{ recording: number; step: number }>
  idFields: Set<string>
  /** The first time it was seen, in the order of the recordings and their steps. */
  first: number
  /** Its first create's answer named an id (`id` / `data.id`). */
  answersId: boolean
  recording: number
}

/** A recorded send as a write target, or why it is left out. */
function targetOf(s: BrowserRecordedSend): { method: DraftTarget['method']; override: DraftTarget['override']; path: string; query: string | null } | BrowserSkillDraftLeftOut {
  if (s.status === null) return 'no-answer'
  if (browserWriteAnswerKind(s.status) !== 'done') return 'not-taken'
  if (s.method === 'DELETE' || s.override === 'DELETE') return 'deletes'
  if (s.method !== 'POST' && s.method !== 'PUT' && s.method !== 'PATCH') return 'override'
  if (s.override !== null && (s.method !== 'POST' || (s.override !== 'PUT' && s.override !== 'PATCH'))) return 'override'
  const at = s.address.indexOf('?')
  const path = at === -1 ? s.address : s.address.slice(0, at)
  const first = path.split('/')[1] ?? ''
  if (first === '' || isPlaceholder(first)) return 'wide-path'
  if (!isBrowserSkillPath(path)) return 'bad-path'
  let query: string | null = null
  if (at !== -1) {
    // Only a query the recording vouches for as sent exactly (format 2): the kept form drops values and repeats.
    if (s.bareQuery !== true) return 'query-values'
    query = s.address.slice(at + 1)
    if (query.split('&').some(isPlaceholder) || browserSkillQueryProblem(query)) return 'query'
  }
  return { method: s.method, override: s.override as DraftTarget['override'], path, query }
}

/** A path segment or query name that says delete / remove (`bulk-delete`, `remove_item`): a POST may delete too. */
const DELETE_WORD_RE = /(^|[-_])(delete|remove|destroy|trash|erase|purge|discard)([-_]|$)/i
const saysDelete = (path: string, query: string | null) =>
  [...path.split('/'), ...(query === null ? [] : query.split('&'))].some(w => DELETE_WORD_RE.test(w))

/** A body field's last word ends with `id` (`aid`, `group_id`, `items[{n}][id]`): it may name an existing thing. */
const namesAnId = (name: string) => /id$/i.test(name.split(/[.[\]]+/).filter(Boolean).pop() ?? '')

/** The declaration's one spelling: flow mappings, every string double-quoted (the words hold no `"` or `\`). */
function declarationText(domain: string, writes: ReadonlyArray<{ id: string | null; method: string; path: string; query: string | null; max: number; override: string | null }>): string {
  const lines = [`domain: ${domain}`, 'writes:']
  for (const w of writes) {
    const parts = [
      ...(w.id ? [`id: ${w.id}`] : []),
      `method: ${w.method}`,
      `path: "${w.path}"`,
      ...(w.query !== null ? [`query: "${w.query}"`] : []),
      `max: ${w.max}`,
      ...(w.override ? [`fields: { _method: ${w.override} }`] : []),
    ]
    lines.push(`  - { ${parts.join(', ')} }`)
  }
  lines.push('safe_pattern: none', '')
  return lines.join('\n')
}

/**
 * The draft of `browser.yaml` made from a person's own recordings (1–5, one domain, in the order they were made), or why
 * none is made. Each recording must be one the server's rule accepts (`browserRecordingProblem`).
 */
export function browserSkillDraftFrom(recordings: readonly BrowserRecordingContent[]): BrowserSkillDraftResult {
  if (!Array.isArray(recordings) || recordings.length === 0) return { ok: false, refusal: 'not-a-recording' }
  if (recordings.length > BROWSER_SKILL_DRAFT_LIMITS.recordings) return { ok: false, refusal: 'too-many-recordings' }
  const domain = recordings[0]?.domain
  for (const r of recordings) {
    if (typeof r !== 'object' || r === null || typeof r.domain !== 'string' || browserRecordingProblem(r, r.domain) !== null) return { ok: false, refusal: 'not-a-recording' }
    if (r.domain !== domain) return { ok: false, refusal: 'domains' }
  }

  const groups = new Map<string, DraftTarget>()
  const leftOut: Array<{ recording: number; step: number; reason: BrowserSkillDraftLeftOut }> = []
  let order = 0
  recordings.forEach((r, recording) => {
    for (const s of r.steps) {
      if (s.kind !== 'send' || s.method === 'GET' || s.method === 'HEAD' || s.method === 'OPTIONS') continue
      order++
      const t = targetOf(s)
      if (typeof t === 'string') {
        leftOut.push({ recording, step: s.id, reason: t })
        continue
      }
      const key = JSON.stringify([t.method, t.override, t.path, t.query])
      let g = groups.get(key)
      if (!g) {
        g = { ...t, seen: [], idFields: new Set(), first: order, answersId: false, recording }
        groups.set(key, g)
        g.answersId = t.method === 'POST' && t.override === null && (s.answerKeys ?? []).some((k: string) => ANSWER_ID_KEYS.includes(k))
      }
      g.seen.push({ recording, step: s.id })
      for (const f of s.fields ?? []) if (f.from === null && f.value !== 'empty' && namesAnId(f.name)) g.idFields.add(f.name)
    }
  })

  const list = [...groups.values()].sort((a, b) => a.first - b.first)
  if (list.length === 0) return { ok: false, refusal: 'no-writes' }
  if (list.length > BROWSER_SKILL_LIMITS.writes) return { ok: false, refusal: 'too-many-writes' }

  // `{made}`: a path with exactly one placeholder, and exactly one earlier create of the same recording whose answer named an id.
  const madeBy = new Map<DraftTarget, DraftTarget>()
  for (const g of list) {
    const segs = g.path.split('/')
    if (segs.filter(isPlaceholder).length !== 1) continue
    const makers = list.filter(m => m !== g && m.first < g.first && m.recording === g.recording && m.answersId && !m.path.split('/').some(isPlaceholder))
    if (makers.length === 1) madeBy.set(g, makers[0])
  }

  const build = (links: ReadonlyMap<DraftTarget, DraftTarget>) => {
    const ids = new Map<DraftTarget, string>()
    for (const maker of links.values()) if (!ids.has(maker)) ids.set(maker, `w${list.indexOf(maker) + 1}`)
    return declarationText(domain, list.map(g => {
      const maker = links.get(g)
      const path = maker ? g.path.split('/').map(seg => (isPlaceholder(seg) ? `{made:${ids.get(maker)}}` : seg)).join('/') : g.path
      return { id: ids.get(g) ?? null, method: g.method, path, query: g.query, max: Math.min(g.seen.length, BROWSER_SKILL_LIMITS.max), override: g.override }
    }))
  }

  let links: ReadonlyMap<DraftTarget, DraftTarget> = madeBy
  let text = build(links)
  let parsed = parseBrowserSkillDeclaration(text)
  // A broader target of the same method beside a `{made}` one (`made-covered`): keep the placeholders instead.
  if (!parsed.ok && links.size > 0) {
    links = new Map()
    text = build(links)
    parsed = parseBrowserSkillDeclaration(text)
  }
  // The one spelling never fails to parse (every piece was checked above); if it ever does, no draft rather than a guess.
  if (!parsed.ok) return { ok: false, refusal: 'no-writes' }

  const writes = list.map((g, i): BrowserSkillDraftWriteNote => {
    const linked = links.has(g)
    const changesExisting = !linked && (g.method !== 'POST' || g.override !== null || g.path.split('/').some(isPlaceholder))
    const creates = g.method === 'POST' && g.override === null
    const idFields = creates ? [...g.idFields].sort() : []
    const marks: BrowserSkillDraftMark[] = []
    if (changesExisting) marks.push('updates-existing')
    if (idFields.length > 0) marks.push('id-in-body')
    if (saysDelete(g.path, g.query)) marks.push('may-delete')
    return { write: i + 1, marks, idFields, seen: g.seen }
  })
  return { ok: true, draft: { text, declaration: parsed.declaration, writes, leftOut } }
}

// ── A change of a draft: never wider than what the recordings gave ─────────────

export type BrowserSkillDraftChangeProblem = 'domain' | 'deletes' | 'wide-path' | 'not-covered' | 'too-many-uses'

/** One segment of a draft's path within the base's segment at the same place. */
function segmentWithin(draft: string, base: string): boolean {
  if (draft === base) return true
  const madeDraft = browserMadeSegmentPlace(draft) !== null
  if (base === '{x}') return draft !== '' && draft !== '{created}'
  if (base === '{n}') return madeDraft || /^[0-9]+$/.test(draft)
  // A base `{made}`: only another `{made}` (what this run made, by a create the draft also holds within the base).
  if (browserMadeSegmentPlace(base) !== null) return madeDraft
  return false
}

function pathWithin(draft: string, base: string): boolean {
  const d = draft.split('/')
  const b = base.split('/')
  return d.length === b.length && d.every((seg, i) => segmentWithin(seg, b[i]))
}

function writeWithin(draft: BrowserSkillWrite, base: BrowserSkillWrite): boolean {
  if (draft.method !== base.method || draft.query !== base.query) return false
  if (draft.fields._method !== base.fields._method) return false
  if (!Object.entries(base.fields).every(([k, v]) => draft.fields[k] === v)) return false
  return pathWithin(draft.path, base.path)
}

/**
 * Null when `draft` (a parsed declaration) is no wider than `base` (what `browserSkillDraftFrom` made), else the first
 * problem and the draft write it is about (1-based; null for the domain).
 */
export function browserSkillDraftCoveredProblem(draft: BrowserSkillDeclaration, base: BrowserSkillDeclaration): { problem: BrowserSkillDraftChangeProblem; write: number | null } | null {
  if (draft.domain !== base.domain) return { problem: 'domain', write: null }
  /** The uses of the draft writes each base write covers, together. */
  const uses = base.writes.map(() => 0)
  for (const [i, w] of draft.writes.entries()) {
    const write = i + 1
    if (w.method === 'DELETE' || w.fields._method === 'DELETE') return { problem: 'deletes', write }
    const first = w.path.split('/')[1] ?? ''
    if (first === '' || isPlaceholder(first)) return { problem: 'wide-path', write }
    const covering = base.writes.flatMap((b, j) => (writeWithin(w, b) ? [j] : []))
    if (covering.length === 0) return { problem: 'not-covered', write }
    // One target split into many narrower ones keeps one budget: every base write that covers it counts its uses.
    for (const j of covering) {
      uses[j] += w.max
      if (uses[j] > BROWSER_SKILL_LIMITS.max) return { problem: 'too-many-uses', write }
    }
  }
  return null
}
