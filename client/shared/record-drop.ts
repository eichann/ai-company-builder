/**
 * A record dropped on a consultation's input (owner 2026-11-03 #5, chat-ui-and-history.md "A record
 * dropped on the input"): the AI gets a compact summary of it ONCE, with the member's next message —
 * title, kind, state, whose turn, due, and what it links to (files, its まとまり, 相手, other records,
 * this PC's consultations about it) — read with the member's own record token, so a record or a link
 * the member cannot read never reaches it. Later turns are not given it again: the AI is told to use
 * records_get / records_history when it needs more. Pure: main, the renderer and tests use it.
 */
import type { TypeDefinition } from '../../shared/core/record-types'
import type { RecordDetail } from '../../shared/types/records'
import { cardFields } from './record-views'
import { TOPIC_RECORD_RE } from './task-consult'
import { stateWord, thingName } from './thing-words'

/** A dropped record as the member's message keeps it (its bubble says it went to the AI). */
export interface DroppedRecordRef { id: string; title: string; word: string }

/** At most this many records go with one message. */
export const MAX_DROPPED_RECORDS = 5

/** A stored / sent list as it comes back (anything malformed is dropped). */
export function readDroppedRecords(value: unknown): DroppedRecordRef[] {
  if (!Array.isArray(value)) return []
  const out: DroppedRecordRef[] = []
  for (const v of value.slice(0, MAX_DROPPED_RECORDS)) {
    const r = v as Partial<DroppedRecordRef> | null
    if (r && typeof r.id === 'string' && TOPIC_RECORD_RE.test(r.id) && typeof r.title === 'string' && typeof r.word === 'string' && !out.some(o => o.id === r.id)) {
      out.push({ id: r.id, title: r.title.slice(0, 200), word: r.word.slice(0, 20) })
    }
  }
  return out
}

/** The records a member's message took to the AI (its UIMessage metadata). */
export function droppedRecordsOf(message: { metadata?: unknown }): DroppedRecordRef[] {
  const m = message.metadata
  return m && typeof m === 'object' ? readDroppedRecords((m as { droppedRecords?: unknown }).droppedRecords) : []
}

/** The ids a chat request may carry (`droppedRecordIds`): record ids only, once each, at most five. */
export function droppedRecordIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && TOPIC_RECORD_RE.test(id)))].slice(0, MAX_DROPPED_RECORDS)
}

const MAX_FILES = 10
const MAX_RECORDS = 8
const MAX_CONSULTATIONS = 5
const MAX_SUMMARY = 400

type Types = ReadonlyMap<string, TypeDefinition>
const thingOf = (r: { type: string; state: string | null }, types: Types) => {
  const def = types.get(r.type)
  return thingName({ type: r.type, typeLabel: def?.label, implements: def?.implements, state: r.state })
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Whose turn a task is, in members' words (null for other kinds, or a finished one). */
function turnLine(r: RecordDetail['record'], def: TypeDefinition | undefined, people: Record<string, string>): string | null {
  if (r.type !== 'task' || !r.state || def?.final.includes(r.state)) return null
  const name = (id: unknown) => (typeof id === 'string' && people[id] ? `${people[id]}さん` : '担当の人')
  if (r.state === 'preparing') return 'AI が用意している'
  if (r.state === 'awaiting_acceptance') return `${name(r.fields.assignee)}が引き受けるのを待っている`
  if (r.state === 'waiting') return `返事待ち${str(r.fields.waiting_on) ? `（${str(r.fields.waiting_on)}）` : ''}`
  return `${name(str(r.fields.next_actor) ?? r.fields.assignee)}の番`
}

/**
 * One record's summary (`GET /records/item/:id` as the AI's token reads it, with `people`), plus the
 * titles of this PC's consultations about it. Lines in members' words; ids only where a tool needs one.
 */
export function droppedRecordSummary(detail: RecordDetail & { people?: Record<string, string> }, types: Types, consultations: readonly string[] = []): string {
  const r = detail.record
  const def = types.get(r.type)
  const people = detail.people ?? {}
  const lines = [`■ ${thingOf(r, types)}『${r.title || '（名前なし）'}』（${r.id}）`]
  const state = stateWord(r.state, r.type)
  if (state) lines.push(`- 状態：${state}${r.personal ? '（本人だけのもの）' : ''}`)
  const turn = turnLine(r, def, people)
  if (turn) lines.push(`- 番：${turn}`)
  const fields = cardFields(r, def, people)
  if (fields.length) lines.push(`- 欄：${fields.slice(0, 12).map(f => `${f.label} ${f.value.length > 80 ? `${f.value.slice(0, 80)}…` : f.value}`).join('／')}`)
  if (r.summary.trim()) lines.push(`- 要約：${r.summary.trim().length > MAX_SUMMARY ? `${r.summary.trim().slice(0, MAX_SUMMARY)}…` : r.summary.trim()}`)
  const files = detail.links.filter(l => l.path)
  if (files.length) {
    const shown = files.slice(0, MAX_FILES).map(l => `${l.path}${l.folder ? '（フォルダ）' : ''}${l.broken ? '（つながりが切れています）' : ''}`)
    lines.push(`- つながったファイル：${shown.join('、')}${files.length > MAX_FILES ? ` ほか${files.length - MAX_FILES}件` : ''}`)
  }
  const recs = detail.links.filter(l => l.record)
  const bundle = recs.find(l => l.direction === 'out' && l.name === 'bundle')
  if (bundle?.record) lines.push(`- まとまり：${thingOf(bundle.record, types)}『${bundle.record.title}』（${bundle.record.id}）`)
  const counterparts = recs.filter(l => l !== bundle && (l.name === 'counterpart' || types.get(l.record!.type)?.implements.includes('counterpart')))
  if (counterparts.length) lines.push(`- 相手：${counterparts.slice(0, MAX_RECORDS).map(l => `『${l.record!.title}』（${l.record!.id}）`).join('、')}`)
  const others = recs.filter(l => l !== bundle && !counterparts.includes(l))
  if (others.length) {
    const shown = others.slice(0, MAX_RECORDS).map(l => {
      const linkLabel = l.direction === 'out' ? def?.links[l.name]?.label : null
      return `${linkLabel ? `${linkLabel}：` : ''}${thingOf(l.record!, types)}『${l.record!.title}』（${l.record!.id}${stateWord(l.record!.state, l.record!.type) ? `・${stateWord(l.record!.state, l.record!.type)}` : ''}）`
    })
    lines.push(`- つながっている記録：${shown.join('、')}${others.length > MAX_RECORDS ? ` ほか${others.length - MAX_RECORDS}件` : ''}`)
  }
  if (consultations.length) lines.push(`- このパソコンでの、これについての相談：${consultations.slice(0, MAX_CONSULTATIONS).map(t => `「${t}」`).join('、')}${consultations.length > MAX_CONSULTATIONS ? ` ほか${consultations.length - MAX_CONSULTATIONS}件` : ''}`)
  return lines.join('\n')
}

/** Read once, at drop: what the AI is told with the member's message (null when nothing was readable). */
export function droppedRecordsContext(summaries: ReadonlyArray<string | null>): string | null {
  const read = summaries.filter((s): s is string => !!s)
  if (read.length === 0) return null
  return [
    '【メンバーが落とした記録（このとき1回だけ読んだ要約）】',
    'メンバーがこの記録を相談の入力欄に落としました。下はその時点の要約です（メンバーが見られるものだけ）。この要約で答えられることは、道具を呼ばずにそのまま答えてください。',
    'この要約は二度と渡されません。あとで、もっと詳しく（つながったファイルの中身・経緯・最新の状態）が要るときは、records_get / records_history（ファイルはふだんの読み方）で必要な深さまで読んでください。メンバーへの返事では id を見せないでください。',
    ...read,
    'The member dropped these records on the input; above is a summary read once, now (only what they may read). Answer from it without calling tools when it is enough; it will not be given again — later, use records_get / records_history when you need more depth.',
  ].join('\n')
}

/** What the AI is told each turn in a consultation about a record that is not a やること (a task's own line is taskTopicInstructions). */
export function recordTopicInstructions(recordId: string): string {
  return `\n\n【この相談の主題】この相談は記録 ${recordId} についての相談です。中身や最新の状態が要るときは records_get で読んでください。 / This consultation is about record ${recordId}; read it with records_get when you need it.`
}

/** The messages with `text` put first in the latest user message (only that one; the others as they were). */
export function withTextBeforeLatestUserMessage<M extends { role: string; content: unknown }>(messages: readonly M[], text: string): M[] {
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue
    const content = out[i].content
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
    out[i] = { ...out[i], content: [{ type: 'text', text }, ...parts] }
    break
  }
  return out
}
