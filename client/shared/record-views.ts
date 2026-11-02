// What the app shows of records (milestone 5 U8, records.md "The app's views"): search
// hits, the one read-only card a record opens in, and the records linked to a file.
// Main builds these from the server's answers (the server already left out what the
// member may not read); the renderer only draws them. Pure: types and wording.
import type { TypeDefinition } from '../../shared/core/record-types'
import { parseTagsValue } from '../../shared/core/record-types'
import { BUNDLE_PART_ENDED_ACTION, OUTSIDE_TIME_ACTION, WAIT_OVER_ACTION } from '../../shared/core/core-types'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import type { RecordFieldValue, RecordSummary } from '../../shared/types/records'
import type { RecordDetailView } from './record-details'
import type { ViewersLabel } from '../../shared/types/viewers'
import { stateWord, thingKindOf, thingName, type ThingKind } from './thing-words'

/** The four kinds people see (design §7-2), plus anything else a company defined. */
export type RecordKind = 'bundle' | 'task' | 'decision' | 'interaction' | 'other'

export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  bundle: 'まとまり', task: 'やること', decision: '決めたこと', interaction: 'やりとり', other: 'そのほか',
}
export const RECORD_KIND_ORDER: RecordKind[] = ['bundle', 'task', 'decision', 'interaction', 'other']

export const RECORD_VIEWS_OFFLINE_TEXT = 'サーバーにつながらないため、表示できません。つながってから開き直してください。'

export interface RecordViewSummary {
  id: string
  type: string
  /** The kind's plain name (やること, 会議の記録, 案件…: `thingName`), shown small. */
  typeLabel: string
  kind: RecordKind
  title: string
  summary: string
  stateLabel: string | null
  updatedAt: string
  /** Owner-only (「自分だけ」): only the member reading it sees it. */
  personal?: true
  /** A decision marked 例外（この件だけ）: never a precedent for another case. */
  exception?: true
  /** How it is shown (its icon, `ThingIcon`); `typeLabel` is its name. */
  thing: ThingKind
  /** A request (やること, 承認のお願い…) that is over: its row is drawn faint. */
  finished?: true
}

/** `available: false`: records are off for this company (nothing to show, no error). */
export type RecordListResult =
  | { success: true; available: boolean; total: number; records: RecordViewSummary[] }
  | { success: false; offline: boolean; error: string }

export interface RecordCardField { label: string; value: string }
export interface RecordCardHistoryLine {
  at: string
  text: string
  ai: boolean
  /** The record's version after it, and who did it (「阿部さんが先に変えました」). */
  version?: number
  who?: string
}
export interface RecordCardLink {
  /** The link's label in the record's type (or the other side's inverse name). */
  label: string
  record?: RecordViewSummary
  /** A file of the company folder (company path). */
  path?: string
  broken?: boolean
  /**
   * A link between records that can be taken off by hand (not where it came from, not a service's):
   * the record holding it (`id`, its `version` now) and the link's name there. Absent = no 「…」.
   */
  removable?: RemovableLink
  /** The record's own 案件・プロジェクト (its `bundle` link): shown at its head, not on the right. */
  bundle?: true
}

/** What `recordLinks:remove` needs to take one link off (and `tasks:undo` to put it back). */
export interface RemovableLink { source: string; sourceVersion: number; link: string; target: string }

/** The record-to-record link of `l` that may be removed, seen from record `self`. */
export function removableOf(self: Pick<RecordSummary, 'id' | 'version'>, l: { name: string; direction: 'in' | 'out'; record?: Pick<RecordSummary, 'id' | 'version'>; fixed?: true }): RemovableLink | undefined {
  if (!l.record || l.fixed) return undefined
  return l.direction === 'out'
    ? { source: self.id, sourceVersion: self.version, link: l.name, target: l.record.id }
    : { source: l.record.id, sourceVersion: l.record.version, link: l.name, target: self.id }
}
export interface RecordCardView {
  record: RecordViewSummary
  /** The record's version now (what a link change sends as `expectedVersion`). */
  version?: number
  /** A meeting's, a 来た連絡's or a bundle's own parts (`record-details.ts`); absent for other kinds. */
  detail?: RecordDetailView
  /** 見られる人 (who can see it, `POST …/viewers`); absent when the server did not say. */
  viewers?: ViewersLabel
  /** The AI on this record (plan I.4): working on it now, or what it last did after the last person's change. */
  ai?: { working: boolean; done: { at: string; text: string } | null }
  fields: RecordCardField[]
  history: RecordCardHistoryLine[]
  links: RecordCardLink[]
}
export type RecordCardResult =
  | { success: true; card: RecordCardView }
  | { success: false; offline: boolean; notFound?: boolean; error: string }

/**
 * The kind a type is shown as: the core types by name, any type implementing `bundle`
 * (a 案件, a 企画, a 取り組み) as a 「まとまり」 — the core never names a business type.
 */
export function recordKindOf(type: string, def?: Pick<TypeDefinition, 'implements'>): RecordKind {
  if (type === 'task' || type === 'approval') return 'task'
  if (type === 'decision') return 'decision'
  if (type === 'interaction' || type === 'meeting' || type === 'outbound_message') return 'interaction'
  if (def?.implements.includes('bundle')) return 'bundle'
  return 'other'
}

/** States in members' words, per type (`thing-words.ts`); a state no table knows as it is. */
export const stateLabel = (state: string | null, type?: string): string | null => stateWord(state, type)

/** Fields kept for the machinery (hashes, outside ids, pointers): never on the card. */
const HIDDEN_FIELDS = new Set(['source_ref', 'source_key', 'payload_hash', 'payload_version', 'result_operation_id', 'provider_message_id', 'doc_version', 'next_actor', 'attendees', 'approver_rule', 'approver_role', 'operation'])

export function summaryView(r: RecordSummary, def: TypeDefinition | undefined): RecordViewSummary {
  return {
    id: r.id, type: r.type, typeLabel: thingName({ type: r.type, typeLabel: def?.label, implements: def?.implements, state: r.state }), kind: recordKindOf(r.type, def),
    title: r.title || '（名前なし）', summary: r.summary, stateLabel: stateLabel(r.state, r.type), updatedAt: r.updatedAt,
    ...(r.personal ? { personal: true as const } : {}),
    ...(r.exceptionNotice ? { exception: true as const } : {}),
    thing: thingKindOf({ type: r.type, implements: def?.implements, state: r.state }),
    ...(def?.implements.includes('request') && r.state !== null && def.final.includes(r.state) ? { finished: true as const } : {}),
  }
}

const BOOL: Record<string, string> = { true: 'はい', false: 'いいえ' }

/** A field's value in members' words: people by name, choices by their label, tags joined. */
export function fieldText(def: TypeDefinition['fields'][string] | undefined, value: RecordFieldValue, people: Record<string, string>): string | null {
  if (value === null || value === '') return null
  if (!def) return String(value)
  switch (def.kind) {
    case 'person': return typeof value === 'string' ? (people[value] ?? 'メンバー') : null
    case 'choice': return typeof value === 'string' ? (def.optionLabels?.[value] ?? value) : String(value)
    case 'boolean': return BOOL[String(value)] ?? String(value)
    case 'tags': { const tags = parseTagsValue(value); return tags.length > 0 ? tags.join('・') : null }
    case 'date': case 'datetime': return String(value).replace('T', ' ').slice(0, 16)
    default: return String(value)
  }
}

export function cardFields(r: RecordSummary, def: TypeDefinition | undefined, people: Record<string, string>): RecordCardField[] {
  const out: RecordCardField[] = []
  const names = def ? Object.keys(def.fields) : Object.keys(r.fields)
  for (const name of names) {
    if (HIDDEN_FIELDS.has(name) || !(name in r.fields)) continue
    const text = fieldText(def?.fields[name], r.fields[name], people)
    if (text !== null) out.push({ label: def?.fields[name]?.label ?? name, value: text })
  }
  return out
}

const ENGINE_ACTIONS: Record<string, string> = {
  create: '作りました', undo: '取り消しました', link_file: 'ファイルをつなぎました', unlink_file: 'ファイルを外しました',
  // The server clock (notifications.md "The server clock").
  [WAIT_OVER_ACTION]: '見込みの日時が過ぎたので、追いかけの番にしました',
  // The startup carry-over of a meeting's outside time (records.md "Outside time").
  [OUTSIDE_TIME_ACTION]: '外で起きた日時を共通の欄に写しました',
  // Meeting version 4 (minutes.md "A まとまり chosen later"): the まとまり's part is no more.
  [BUNDLE_PART_ENDED_ACTION]: 'まとまりの分を終わりにして「読んだ」に戻しました',
  // Version 3's actions, still in older meetings' 経緯.
  start_bundle_work: 'まとまりの分を始めました', finish_bundle_work: 'まとまりの分を終えました', fail_bundle_work: 'まとまりの分をできませんでした',
  retry_bundle_work: 'まとまりの分をやり直しにしました', skip_bundle_work: 'まとまりの分をしないことにしました',
}

/** One line of 経緯 per ledger entry, newest first. */
export function historyLines(entries: LedgerEntry[], def: TypeDefinition | undefined, people: Record<string, string>): RecordCardHistoryLine[] {
  return [...entries].sort((a, b) => b.version - a.version).map(e => {
    const what = def?.actions[e.action]?.label ?? ENGINE_ACTIONS[e.action] ?? e.action
    const who = e.actorKind === 'ai' ? 'AI' : e.actorKind === 'external' ? (e.actorSource ?? '外のサービス') : (people[e.actorId] ?? 'メンバー')
    return { at: e.at, text: `${who}：${what}${e.note ? `（${e.note}）` : ''}`, ai: e.actorKind === 'ai', version: e.version, who }
  })
}
