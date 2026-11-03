// The left 「探す」 tab's logic (owner-approved redesign 2026-11-03; records.md "探す"): one row per
// thing found — a record, a file or an AI consultation, never one per line — with its best sentence;
// summary cards for a 相手 / 案件 whose name holds the words; 名前で見つかったもの before
// 中身で見つかったもの; kinds named like everywhere else; narrowed by department, period and 「自分」.
// Pure: the panel and its hook only feed it what was read. ~300 lines: one search's rules.
import type { FindHitView } from '../../../shared/record-views'
import type { BundleKindsResult, RecordFindHub } from '../../../../shared/types/records'
import { foldAsciiCase } from '../../../../shared/core/paths'
import { consultationLinkedRecord, type ConsultationTopic, type TopicRecordLook } from '../../../shared/consultation-topics'
import { THING_NAMES, type ThingKind } from '../../../shared/thing-words'

export type Period = 'week' | 'month' | 'all'
export interface FindFilters {
  /** The department folder searched; null = 全社. */
  scope: string | null
  period: Period
  mineOnly: boolean
  /** The member's day, YYYY-MM-DD. */
  today: string
}

/** Words as compared: NFC, A–Z folded (the record search's and the push checker's rule). */
export const foldWords = (s: string): string => foldAsciiCase(s.normalize('NFC')).trim()

/** A consultation of this PC's history, as 探す reads it. */
export interface FindConsultation {
  id: string
  title: string
  updatedAt: string
  topicRecordId?: string
  /** The one record it is found by (`consultationLinkedRecord`: its own やること, else its 案件), when readable. */
  linked?: TopicRecordLook | null
  /** The 案件 it belongs to (its topic, or its topic's 案件), when readable. */
  bundleId?: string
}

/** The consultations with what each is about (`recordViews:topics`, shared with 「AIへの相談」). */
export function withTopics(list: readonly FindConsultation[], topics: ReadonlyMap<string, ConsultationTopic | null> | undefined): FindConsultation[] {
  return list.map(c => {
    const topic = c.topicRecordId ? topics?.get(c.topicRecordId) : null
    const linked = consultationLinkedRecord(topic)
    return { ...c, linked, ...(topic?.bundle ? { bundleId: topic.bundle.id } : {}) }
  })
}
/** One line of a file that holds the words (git grep, capped in main). */
export interface FindLine { file: string; line: number; text: string }

export interface FoundThing {
  key: string
  kind: ThingKind
  /** The kind's own label (案件, 番組…), for bundles and a company's kinds. */
  typeLabel?: string
  title: string
  /** Department folder; null = the whole company. */
  department: string | null
  /** When it last moved (ISO); '' = not known. */
  at: string
  mine: boolean
  finished?: boolean
  recordId?: string
  /** A record's summary: the sentences looked into. */
  body?: string
  bundle?: { id: string; title: string }
  /** A file's company path, and its lines that hold the words. */
  path?: string
  lines?: FindLine[]
  sessionId?: string
  topicRecordId?: string
  meetingAt?: string
  /** A consultation found through its record: 「やること『見積書を直す』の相談」. */
  why?: string
}

export interface FindInputs {
  query: string
  hits: readonly FindHitView[]
  hubs: readonly RecordFindHub[]
  /** File names (company paths) to match by name. */
  files: readonly string[]
  lines: readonly FindLine[]
  /** When each file last changed (ISO), for those read. */
  fileTimes: Readonly<Record<string, string>>
  consultations: readonly FindConsultation[]
  bundleKinds?: BundleKindsResult | null
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const departmentOfPath = (p: string): string | null => (p.includes('/') ? p.slice(0, p.indexOf('/')) : null)

/** A kind's name for the member (a business kind by its own label, the core's under the company's name). */
export function bundleName(type: string, fallback: string, kinds?: BundleKindsResult | null): string {
  return kinds?.kinds.find(k => k.type === type)?.name ?? fallback
}

/** 「やること『見積書を直す』の相談」: why a consultation shows up under words it does not hold. */
export const consultWhy = (kindName: string, title: string) => `${kindName}『${title}』の相談`

/** Everything found, one per thing, before any narrowing. */
export function foundThings(inp: FindInputs): FoundThing[] {
  const w = foldWords(inp.query)
  if (!w) return []
  const byRecord = new Map(inp.hits.map(h => [h.record.id, h]))
  const out: FoundThing[] = inp.hits.map(h => ({
    key: `record:${h.record.id}`, kind: h.record.thing,
    typeLabel: h.record.thing === 'bundle' ? bundleName(h.record.type, h.record.typeLabel, inp.bundleKinds) : h.record.typeLabel,
    title: h.record.title, department: h.department, at: h.record.updatedAt, mine: h.mine,
    ...(h.record.finished ? { finished: true } : {}),
    recordId: h.record.id, body: h.record.summary,
    ...(h.bundle ? { bundle: h.bundle } : {}), ...(h.meetingAt ? { meetingAt: h.meetingAt } : {}),
  }))
  const lines = new Map<string, FindLine[]>()
  for (const l of inp.lines) lines.set(l.file, [...(lines.get(l.file) ?? []), l])
  const paths = new Set([...inp.files.filter(f => foldWords(baseName(f)).includes(w)), ...lines.keys()])
  for (const path of paths) {
    out.push({ key: `file:${path}`, kind: 'file', title: baseName(path), department: departmentOfPath(path), at: inp.fileTimes[path] ?? '', mine: false, path, lines: lines.get(path) ?? [] })
  }
  // A consultation by its title, or through its one linked record (its own やること, else its 案件).
  for (const c of inp.consultations) {
    const byTitle = foldWords(c.title).includes(w)
    const viaRecord = !byTitle && !!c.linked && foldWords(c.linked.title).includes(w)
    if (!byTitle && !viaRecord) continue
    const rec = c.linked ? byRecord.get(c.linked.id) : undefined
    out.push({
      key: `consultation:${c.id}`, kind: 'consultation', title: c.title, department: rec?.department ?? null, at: c.updatedAt, mine: true,
      sessionId: c.id, ...(c.topicRecordId ? { topicRecordId: c.topicRecordId } : {}),
      ...(viaRecord && c.linked ? { why: consultWhy(c.linked.kindName, c.linked.title) } : {}),
    })
  }
  return out
}

const DAY_MS = 86_400_000
/** Whole days from `today` (YYYY-MM-DD) back to `at`'s local day; negative = in the future. */
export function daysAgo(at: string, today: string): number {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return 0
  const local = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((Date.parse(`${today}T00:00:00Z`) - local) / DAY_MS)
}

/** Kept by the narrowing: the scope (things of no department stay in every one), period, 「自分が関わった」. */
export function passes(t: FoundThing, f: FindFilters): boolean {
  if (f.scope !== null && t.department !== null && t.department !== f.scope) return false
  if (f.mineOnly && !t.mine) return false
  if (f.period !== 'all' && t.at) {
    const ago = daysAgo(t.at, f.today)
    if (ago > (f.period === 'week' ? 6 : 30)) return false
  }
  return true
}

export const nameHit = (t: FoundThing, q: string) => foldWords(t.title).includes(foldWords(q))
const contentHit = (t: FoundThing, q: string) => (t.lines?.length ?? 0) > 0 || (!!t.body && foldWords(t.body).includes(foldWords(q)))

export interface Found {
  cards: FoundThing[]
  byName: FoundThing[]
  byContent: FoundThing[]
}

const newest = (a: FoundThing, b: FoundThing) => b.at.localeCompare(a.at)
const mineThenNewest = (a: FoundThing, b: FoundThing) => Number(b.mine) - Number(a.mine) || newest(a, b)

/**
 * Summary cards (the hubs the server summarised, unfinished and 相手 first), then the things whose
 * name holds the words (and consultations found through their record), then the rest by content.
 */
export function classify(things: readonly FoundThing[], hubs: readonly RecordFindHub[], q: string, f: FindFilters): Found {
  const hubIds = new Set(hubs.map(h => h.id))
  const kept = things.filter(t => passes(t, f))
  const cards = kept.filter(t => t.recordId && hubIds.has(t.recordId))
    .sort((a, b) => Number(!!a.finished) - Number(!!b.finished) || Number(b.kind === 'counterpart') - Number(a.kind === 'counterpart') || mineThenNewest(a, b))
  const inCards = new Set(cards.map(c => c.key))
  const rest = kept.filter(t => !inCards.has(t.key))
  const byName = rest.filter(t => nameHit(t, q) || t.why).sort(mineThenNewest)
  const named = new Set(byName.map(t => t.key))
  const byContent = rest.filter(t => !named.has(t.key) && contentHit(t, q)).sort(newest)
  return { cards, byName, byContent }
}

export const foundCount = (f: Found) => f.cards.length + f.byName.length + f.byContent.length

// --- Kinds: one key per chip and group, named like everywhere else --------------------------

const ORDER = ['task', 'meeting', 'decision', 'bundle', 'counterpart', 'incoming', 'sent', 'approval', 'consultation', 'other', 'file']
const KEY_OF: Partial<Record<ThingKind, string>> = { minutes_check: 'task', reply_request: 'task', outbound: 'sent' }

export function kindKey(t: Pick<FoundThing, 'kind' | 'typeLabel'>): string {
  if (t.kind === 'bundle' || t.kind === 'other') return `${t.kind}:${t.typeLabel ?? ''}`
  return KEY_OF[t.kind] ?? t.kind
}
export function kindLabel(key: string, items?: readonly FoundThing[]): string {
  const [k, label] = key.split(':')
  if (k === 'bundle') return label || 'プロジェクト'
  if (k === 'other') return label || '記録'
  if (k === 'sent' && items && items.some(i => i.kind === 'outbound') && items.every(i => i.kind === 'outbound')) return THING_NAMES.outbound
  return THING_NAMES[k as keyof typeof THING_NAMES] ?? k
}
export function kindLook(key: string): { kind: ThingKind; typeLabel?: string } {
  const [k, label] = key.split(':')
  return { kind: (k === 'sent' ? 'sent' : k) as ThingKind, ...(label ? { typeLabel: label } : {}) }
}
const rank = (key: string) => ORDER.indexOf(key.split(':')[0])

export interface Group { key: string; items: FoundThing[] }
export function groupByKind(list: readonly FoundThing[]): Group[] {
  const map = new Map<string, FoundThing[]>()
  for (const t of list) map.set(kindKey(t), [...(map.get(kindKey(t)) ?? []), t])
  return [...map].map(([key, items]) => ({ key, items })).sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}

/** Chips: only kinds that have something, with counts. */
export function chipsOf(found: Found): Array<{ key: string; label: string; count: number }> {
  return groupByKind([...found.cards, ...found.byName, ...found.byContent]).map(g => ({ key: g.key, label: kindLabel(g.key, g.items), count: g.items.length }))
}

export function onlyKind(found: Found, key: string | null): Found {
  if (key === null) return found
  const keep = (t: FoundThing) => kindKey(t) === key
  return { cards: found.cards.filter(keep), byName: found.byName.filter(keep), byContent: found.byContent.filter(keep) }
}

// --- One row's words -------------------------------------------------------------------------

/** The sentence that shows the match best: the most hits, then the shortest. */
export function bestSentence(text: string, q: string): string | null {
  const w = foldWords(q)
  if (!w) return null
  let best: { s: string; hits: number } | null = null
  for (const raw of text.split(/\n|(?<=[。！？])/)) {
    const s = raw.replace(/^#+\s*/, '').trim()
    const hits = s ? foldWords(s).split(w).length - 1 : 0
    if (hits === 0) continue
    if (!best || hits > best.hits || (hits === best.hits && s.length < best.s.length)) best = { s, hits }
  }
  return best?.s ?? null
}

/** The row's sentence: a record's best one in its summary, a file's best line. */
export function sentenceOf(t: FoundThing, q: string): string | null {
  if (t.lines && t.lines.length > 0) return bestSentence(t.lines.map(l => l.text).join('\n'), q)
  return t.body ? bestSentence(t.body, q) : null
}

/** The line a file opens at: the one with its best sentence. */
export function lineOf(t: FoundThing, q: string): number {
  const s = sentenceOf(t, q)
  return t.lines?.find(l => s !== null && l.text.includes(s))?.line ?? t.lines?.[0]?.line ?? 1
}

/** Where a thing found by name lives: a file's folder inside its department, a record's 案件. */
export function whereOf(t: FoundThing): string | null {
  if (t.path) {
    const parts = t.path.split('/').slice(t.department ? 1 : 0, -1)
    return parts.length > 0 ? parts.join('/') : 'フォルダの直下'
  }
  return t.bundle?.title ?? null
}

/**
 * The consultations about a row: a やること's are those started from it; a 案件's every one in it
 * (about it or about one of its やること); a 相手's every one in its 案件.
 */
export function consultationsOf(t: FoundThing, consultations: readonly FindConsultation[], hub?: RecordFindHub): FindConsultation[] {
  const id = t.recordId
  if (!id) return []
  const inHub = new Set(hub?.memberIds ?? [])
  const about = (c: FindConsultation) => {
    if (t.kind === 'bundle') return c.bundleId === id || c.topicRecordId === id
    if (t.kind === 'counterpart') return (!!c.bundleId && inHub.has(c.bundleId)) || c.topicRecordId === id
    return c.topicRecordId === id
  }
  return consultations.filter(about).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** A summary card's counts, in the member's words, only the ones with something. */
export function hubCounts(hub: RecordFindHub, bundleWord: string, consults: number): Array<{ label: string; n: number }> {
  return [
    { label: bundleWord, n: hub.counts.bundles }, { label: THING_NAMES.task, n: hub.counts.openTasks },
    { label: '会議', n: hub.counts.meetings }, { label: THING_NAMES.decision, n: hub.counts.decisions },
    { label: THING_NAMES.file, n: hub.counts.files }, { label: '相談', n: consults },
  ].filter(c => c.n > 0)
}

// --- Dates in the member's words ---------------------------------------------------------------

const WEEKDAYS = '日月火水木金土'
/** 11/6（金） 15:00 — a meeting's own date (no time zone: as written). */
export function dateWords(at: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(at)
  if (!m) return ''
  const w = WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]
  return `${+m[2]}/${+m[3]}（${w}）${m[4] ? ` ${m[4]}` : ''}`
}
/** 今日・きのう・あした or M/D. */
export function shortDate(at: string, today: string): string {
  if (!at) return ''
  const ago = daysAgo(at, today)
  if (ago === 0) return '今日'
  if (ago === 1) return 'きのう'
  if (ago === -1) return 'あした'
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`
}
/** The member's day (local), YYYY-MM-DD, and `days` from it. */
export function localDay(now: Date, days = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
