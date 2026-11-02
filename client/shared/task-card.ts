/**
 * The task card (やることのカード, stage 2 S7c; `.claude/rules/tasks-ui.md` "The card"): what main
 * answers for one task, built from the server's answers by `taskCardOf`. What the member can do
 * is offered from the type definition and the member's place in the record (assignee, requester,
 * OK-giver); the server's engine still decides every action. Pure.
 */
import { actionWho, parseTagsValue, type TypeDefinition } from '../../shared/core/record-types'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import type { AiRunView } from '../../shared/types/ai-runs'
import type { RecordDetail, RecordSummary } from '../../shared/types/records'
import { recordActionChoices } from './record-actions'
import {
  cardFields, historyLines, summaryView,
  type RecordCardField, type RecordCardHistoryLine, type RecordCardLink, type RecordViewSummary,
} from './record-views'

export interface TaskCardArg {
  name: string
  label: string
  kind: string
}

export interface TaskCardAction {
  action: string
  title: string
  noteRequired: boolean
  args: TaskCardArg[]
  /** The member may do it only by saying whose OK it was (the assignee completing). */
  needsOk: boolean
  /** Not possible from the current state yet: 着手 first, then this (完了 from 未着手). */
  startFirst: boolean
}

/** An execution run of this record that waits for a person (records.md "Execution runs"). */
export interface TaskCardRun {
  runId: string
  /** The run's state in words (AI_RUN_STATE_LABELS). */
  label: string
  /** 「もう一度」 gives it back to the AI (not while an outside result is unknown). */
  canRetry: boolean
  /** Outside operations whose result is unknown: the member looks in the outside system and says. */
  unknown: Array<{ key: string; kind: string }>
}

/** Where a task came from (言葉の決まり 7.): the meeting or the 連絡 it was made of. */
export interface TaskCardOrigin {
  kind: 'meeting' | 'interaction'
  recordId: string
  title: string
  /** `YYYY-MM-DD…` of the meeting or the 連絡, when known. */
  at: string | null
  /** The AI made it (from a meeting's minutes, a mail…). */
  byAi: boolean
  /** The person who made it, when a person did (or confirmed the AI's suggestion). */
  addedBy: string | null
  /** The words it rests on (the note the AI wrote when it made it). */
  basis: string | null
}

export interface TaskCardData {
  record: RecordViewSummary & { state: string | null; version: number }
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, or null. */
  due: string | null
  tags: string[]
  /** 目的: why it is done. */
  purpose: string | null
  fields: RecordCardField[]
  /** The member's place in it. */
  roles: { assignee: boolean; requester: boolean; okGiver: boolean; reviewer: boolean }
  /** People by name (null = nobody, or not a member any more). */
  names: { assignee: string | null; requester: string | null; reviewer: string | null }
  /** The checker's member id (「終わったので見てもらう」 hands it to them). */
  reviewerId: string | null
  /** 終わったら (task version 9): 知らせるだけ or 確かめてから; null before version 9 or unset. */
  whenDone: 'notify' | 'check' | null
  /** The task's 案件 / プロジェクト (its `bundle` link), shown at its head rather than in 「つながっているもの」. */
  bundle: RecordViewSummary | null
  origin: TaskCardOrigin | null
  actions: TaskCardAction[]
  /** The member may set its tags (タグを付ける: requester or assignee, not finished); tag suggestions add through it. */
  canSetTags: boolean
  /** 「佐藤さんが田中さんの了承を得たとして完了にしました」 while the task stands on that OK. */
  okLine: string | null
  /** What the AI checked and made (its preparation). */
  prepSummary: string | null
  /** The drafts and approval requests the AI made (「AI が用意したもの」), newest first. */
  prepared: RecordViewSummary[]
  files: Array<{ path: string; broken?: boolean }>
  links: RecordCardLink[]
  history: RecordCardHistoryLine[]
  runs: TaskCardRun[]
  /** Members by name (for 「誰の OK か」 and person arguments), the member excluded. */
  people: Array<{ id: string; name: string }>
}

export type TaskCardResult =
  | { success: true; card: TaskCardData }
  | { success: false; offline: boolean; notFound?: boolean; error: string }

/** Actions that are the AI's own or need a chooser the card does not have. */
const NOT_ON_CARD = new Set(['finish_prep', 'hand_over', 'set_bundle', 'set_tags', 'set_wait_until'])
const FIELDS_SHOWN_ELSEWHERE = new Set(['title', 'due', 'tags', 'prep_summary', 'ok_by', 'ok_note', 'accepted_by', 'purpose'])

const nameOf = (people: Record<string, string>, id: unknown) => (typeof id === 'string' && id ? people[id] ?? 'メンバー' : 'メンバー')
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The statement of an OK in members' words (never "approved": an OK is not an approval). */
export function okWords(actor: string, okBy: string | null, okNote: string | null): string {
  const whose = okBy ? `${okBy}さんの了承を得たとして` : '了承を得たとして'
  return `${actor}さんが${whose}完了にしました${okNote ? `（${okNote}）` : ''}`
}

export interface TaskCardSources {
  me: string
  detail: RecordDetail
  def: TypeDefinition | undefined
  defs: Map<string, TypeDefinition>
  entries: LedgerEntry[]
  people: Record<string, string>
  runs: AiRunView[]
}

export function taskCardOf(src: TaskCardSources): TaskCardData {
  const { me, def, people } = src
  const r = src.detail.record
  const holds = (field: string) => r.fields[field] === me
  const roles = { assignee: holds('assignee'), requester: holds('requested_by'), okGiver: holds('ok_by'), reviewer: holds('reviewer') }
  const personName = (field: string) => { const id = str(r.fields[field]); return id ? people[id] ?? null : null }
  const names = { assignee: personName('assignee'), requester: personName('requested_by'), reviewer: personName('reviewer') }
  const whenDone = r.fields.when_done === 'check' ? 'check' as const : r.fields.when_done === 'notify' ? 'notify' as const : null
  const personMay = (who: string[]) => who.includes('anyone') || who.some(w => def?.fields[w]?.kind === 'person' && holds(w))
  const offer = (state: string | null, startFirst: boolean): TaskCardAction[] => (def ? recordActionChoices(def, state) : [])
    .filter(c => !NOT_ON_CARD.has(c.action) && c.links.length === 0)
    .flatMap(c => {
      const a = def!.actions[c.action]
      if (a.who.length === 1 && a.who[0] === 'ai') return []
      // `who_unless`: a task to be checked first (終わったら：確かめてから) is not the assignee's to complete.
      const direct = personMay(actionWho(a, r.fields))
      const viaOk = !direct && c.okFrom.some(f => holds(f))
      if (!direct && !viaOk) return []
      return [{
        action: c.action, title: c.title, noteRequired: c.noteRequired, needsOk: viaOk, startFirst,
        args: c.args.map(name => ({ name, label: def!.fields[name]?.label ?? name, kind: a.args[name] })),
      }]
    })
  const actions = offer(r.state, false)
  // 完了 from 未着手 / 返事待ち: the type completes only what was started, so 着手 goes first.
  const start = actions.find(a => a.action === 'start')
  if (start && !actions.some(a => a.action === 'complete')) {
    const complete = offer(def?.actions.start?.to ?? null, true).find(a => a.action === 'complete')
    if (complete) actions.push(complete)
  }

  const setTags = def?.actions.set_tags
  const canSetTags = !!setTags && personMay(setTags.who) && !(def?.final ?? []).includes(r.state ?? '')

  const okBy = str(r.fields.ok_by)
  const okNote = str(r.fields.ok_note)
  const completedEntry = [...src.entries].reverse().find(e => e.action === 'complete')
  const okLine = r.state === 'done' && (okBy || okNote)
    ? okWords(completedEntry ? nameOf(people, completedEntry.actorId) : 'メンバー', okBy ? nameOf(people, okBy) : null, okNote)
    : null

  const lines = historyLines(src.entries, def, people)
  const history = [...src.entries].sort((a, b) => b.version - a.version).map((e, i) => {
    const by = e.changes.find(c => c.field === 'ok_by')?.after
    const note = e.changes.find(c => c.field === 'ok_note')?.after
    if (e.action !== 'complete' || (!str(by) && !str(note))) return lines[i]
    return { ...lines[i], text: okWords(nameOf(people, e.actorId), str(by) ? nameOf(people, by) : null, str(note)) }
  })

  const links: RecordCardLink[] = []
  const prepared: RecordViewSummary[] = []
  let bundle: RecordViewSummary | null = null
  let originLink: { kind: 'meeting' | 'interaction'; record: RecordSummary } | null = null
  const files: Array<{ path: string; broken?: boolean }> = []
  for (const l of src.detail.links) {
    if (l.path !== undefined) {
      if (l.direction === 'out') files.push({ path: l.path, ...(l.broken !== undefined ? { broken: l.broken } : {}) })
      continue
    }
    if (!l.record) continue
    const view = summaryView(l.record, src.defs.get(l.record.type))
    if (l.direction === 'out' && l.name === 'prepared') { prepared.push(view); continue }
    if (l.direction === 'out' && l.name === 'bundle') { bundle = view; continue }
    if (l.direction === 'out' && (l.name === 'meeting' || l.name === 'interaction')) originLink ??= { kind: l.name, record: l.record }
    const label = l.direction === 'out' ? def?.links[l.name]?.label ?? l.name : src.defs.get(l.record.type)?.label ?? l.name
    links.push({ label, record: view })
  }
  prepared.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const runs: TaskCardRun[] = src.runs.filter(x => x.recordId === r.id && x.needsPerson).map(x => {
    const unknown = x.operations.filter(o => o.state === 'unknown').map(o => ({ key: o.key, kind: o.kind }))
    return { runId: x.id, label: x.label, canRetry: unknown.length === 0, unknown }
  })

  const created = src.entries.find(e => e.version === 1) ?? null
  const origin: TaskCardOrigin | null = originLink ? {
    kind: originLink.kind, recordId: originLink.record.id, title: originLink.record.title || '（名前なし）',
    at: str(originLink.record.fields.meeting_at) ?? str(originLink.record.fields.occurred_at),
    byAi: created?.actorKind === 'ai' || created?.proposedBy === 'ai',
    addedBy: created && created.actorKind === 'human' ? nameOf(people, created.actorId) : null,
    basis: created && created.actorKind === 'ai' ? str(created.note) : null,
  } : null

  return {
    record: { ...summaryView(r, def), state: r.state, version: r.version },
    due: str(r.fields.due),
    tags: parseTagsValue(r.fields.tags),
    purpose: str(r.fields.purpose),
    fields: cardFields({ ...r, fields: Object.fromEntries(Object.entries(r.fields).filter(([k]) => !FIELDS_SHOWN_ELSEWHERE.has(k))) }, def, people),
    roles, names, reviewerId: str(r.fields.reviewer), whenDone, bundle, origin, actions, canSetTags, okLine,
    prepSummary: str(r.fields.prep_summary),
    prepared, files, links, history, runs,
    people: Object.entries(people).filter(([id]) => id !== me).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
  }
}
