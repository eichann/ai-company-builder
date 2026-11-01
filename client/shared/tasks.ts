/**
 * The task list (やることの一覧, stage 2 S7b; `.claude/rules/tasks-ui.md`): what main
 * answers the renderer, and the rules that put each record in its place. Main reads the
 * server with the member's session (the server already left out what the member may
 * not read); this only sorts and words it. Pure: main, the renderer and tests import it.
 */
import { parseTagsValue } from '../../shared/core/record-types'
import type { RecordSummary } from '../../shared/types/records'
import { stateLabel } from './record-views'

/**
 * Where an item stands for the member:
 * - `mine`: it waits for them (「あなたの番」);
 * - `acceptance`: asked of them, waiting for 「引き受ける」 (引き受け待ち);
 * - `ai`: the AI prepares or reads it (「AI の番」);
 * - `others`: someone else's turn, or a reply the member waits for;
 * - `done`: finished or stopped today.
 */
export type TaskTurn = 'mine' | 'acceptance' | 'ai' | 'others' | 'done'

export interface TaskListItem {
  id: string
  type: string
  /** The type's own label (タスク, 承認のお願い, 会議…). */
  typeLabel: string
  /** The interfaces its type implements (`request`…), when any: a plugin's peek lists by them (A6). */
  implements?: string[]
  title: string
  state: string | null
  stateLabel: string | null
  version: number
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (company time), or null. */
  due: string | null
  tags: string[]
  turn: TaskTurn
  /** Whose turn or what it waits for, in words (「田中さんの番」「返事待ち：先方の見積」), when not the member's. */
  waitingFor: string | null
  /** Owner-only (「自分だけ」): only the member sees it. */
  personal: boolean
  /** The member asked it of themselves (requester and assignee): they may finish it from the list. */
  own: boolean
  /** The absent member it waits for, when it is in this list as their delegate (代わりの人). */
  actingFor: string | null
  /** The まとまり (取り組み・案件・企画) it belongs to. */
  bundle: { id: string; title: string } | null
  /** `done` only: when it finished (ISO), as far as the list knows (its last change). */
  finishedAt: string | null
  /** A meeting read with no まとまり: the member says which one (「どのまとまりの会議ですか？」). */
  needsBundle?: true
  /** 「AI の番」 only: the server clock put it there because its wait is over (the PC's wait-over step runs it). */
  waitOver?: true
}

/** A まとまり the member may choose for a meeting (unfinished, readable). */
export interface BundleChoice {
  id: string
  title: string
  /** Its type's own label (案件, 企画, 取り組み…). */
  typeLabel: string
}

export type BundleChoicesResult =
  | { success: true; bundles: BundleChoice[] }
  | { success: false; offline: boolean; error: string }

/** The words of the 「あなたの番」 item for a meeting read without a まとまり. */
export const MEETING_NEEDS_BUNDLE_TEXT = 'どのまとまり（案件など）の会議か選んでください'

export interface TaskListData {
  /** false: records are off for the company (no list at all). */
  available: boolean
  /** The company setting 「一覧を出す部署」: department ids, or null = every department. */
  listDepartmentIds: string[] | null
  items: TaskListItem[]
}

export type TaskListResult =
  | { success: true; data: TaskListData }
  | { success: false; offline: boolean; error: string }

export const TASKS_OFFLINE_TEXT = 'サーバーにつながらないため、やることを表示できません。'

/** A new task from the list's one line: the member's own (owner-only), assigned to them. */
export interface TaskCreateInput {
  title: string
  due?: string | null
  tags?: string[]
}

/** An action the list or the card runs on a record (the server decides who may). */
export interface TaskActInput {
  action: string
  expectedVersion: number
  note?: string
  args?: Record<string, string | number | boolean | string[] | null>
  links?: Record<string, string | string[] | null>
  /** Completing on someone's OK (records.md "Completing on someone's OK"). */
  ok?: { by?: string; note?: string }
}

export type TaskWriteResult =
  | { success: true; recordId: string }
  | { success: false; offline: boolean; code: string | null; error: string }

/** What the server answered, in the shapes the list sorts. */
export interface TaskSources {
  me: string
  myTurn: RecordSummary[]
  aiTurn: RecordSummary[]
  /** Unfinished tasks the member asked of someone (requested_by = them). */
  asked: RecordSummary[]
  /** Records that reached a final state today, the member's or asked by them. */
  doneToday: RecordSummary[]
  /** Meetings of the member read lately whose まとまり nobody chose (none when the company has none). */
  meetingsWithoutBundle?: RecordSummary[]
  typeLabels: Record<string, string>
  /** Type name → the interfaces it implements, for the types that do. */
  typeImplements?: Record<string, string[]>
  /** Member id → display name. */
  people: Record<string, string>
  /** Record id → its まとまり, when it has one. */
  bundles: Record<string, { id: string; title: string }>
}

const nameOf = (people: Record<string, string>, id: unknown): string =>
  typeof id === 'string' && id ? (people[id] ?? 'メンバー') : 'メンバー'

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Who or what an item waits for, in members' words (null when it is the member's own). */
function waitingWords(r: RecordSummary, me: string, people: Record<string, string>): string | null {
  const assignee = r.fields.assignee
  if (r.state === 'awaiting_acceptance') return `${nameOf(people, assignee)}さんに頼んだ・引き受け待ち`
  if (r.state === 'waiting') {
    const on = text(r.fields.waiting_on)
    return on ? `返事待ち：${on}` : '返事待ち'
  }
  if (r.state === 'preparing') return assignee === me ? 'AI が用意しています' : `AI が用意しています（担当 ${nameOf(people, assignee)}さん）`
  const next = typeof r.fields.next_actor === 'string' && r.fields.next_actor ? r.fields.next_actor : assignee
  if (next === me) return null
  return `${nameOf(people, next)}さんの番`
}

/**
 * Puts each record where it belongs for the member, once (the first place wins:
 * 引き受け待ち and the member's turn before 「AI の番」 before what others hold
 * before today's done). A task waiting for a reply is the member's to follow up,
 * but it is shown with what it waits for (返事待ち), not as something to do now.
 */
export function classifyTasks(src: TaskSources): TaskListItem[] {
  const seen = new Set<string>()
  const out: TaskListItem[] = []
  const add = (r: RecordSummary, turn: TaskTurn, waitingFor: string | null, finishedAt: string | null = null, needsBundle = false) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({
      id: r.id, type: r.type, typeLabel: src.typeLabels[r.type] ?? r.type,
      ...(src.typeImplements?.[r.type] ? { implements: src.typeImplements[r.type] } : {}),
      title: r.title || '（名前なし）', state: r.state, stateLabel: stateLabel(r.state), version: r.version,
      due: typeof r.fields.due === 'string' && r.fields.due ? r.fields.due : null,
      tags: parseTagsValue(r.fields.tags),
      turn, waitingFor, personal: r.personal === true,
      own: r.type === 'task' && r.fields.assignee === src.me && (r.fields.requested_by ?? src.me) === src.me,
      actingFor: r.actingFor ? nameOf(src.people, r.actingFor) : null,
      bundle: src.bundles[r.id] ?? null,
      finishedAt,
      ...(needsBundle ? { needsBundle: true as const } : {}),
      ...(turn === 'ai' && r.waitOver ? { waitOver: true as const } : {}),
    })
  }
  for (const r of src.myTurn) {
    if (r.state === 'awaiting_acceptance') add(r, 'acceptance', null)
    else if (r.state === 'waiting') add(r, 'others', waitingWords(r, src.me, src.people))
    else if (r.state === 'declined') add(r, 'mine', `${nameOf(src.people, r.fields.assignee)}さんが受けられないと返しました`)
    else add(r, 'mine', null)
  }
  for (const r of src.meetingsWithoutBundle ?? []) add(r, 'mine', MEETING_NEEDS_BUNDLE_TEXT, null, true)
  for (const r of src.aiTurn) add(r, 'ai', null)
  for (const r of src.asked) add(r, 'others', waitingWords(r, src.me, src.people))
  for (const r of src.doneToday) add(r, 'done', null, r.updatedAt)
  return out
}

/** The states a task can wait in (not final), for the query of what the member asked. */
export const OPEN_TASK_STATES = ['todo', 'in_progress', 'review', 'waiting', 'preparing', 'declined', 'awaiting_acceptance'] as const
