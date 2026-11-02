/**
 * The task list (やることの一覧, stage 2 S7b; `.claude/rules/tasks-ui.md`): what main
 * answers the renderer, and the rules that put each record in its place. Main reads the
 * server with the member's session (the server already left out what the member may
 * not read); this only sorts and words it. Pure: main, the renderer and tests import it.
 */
import { parseTagsValue } from '../../shared/core/record-types'
import type { BundleKindsResult, RecordSummary } from '../../shared/types/records'
import type { MeetingBundleQuestion } from '../../shared/types/minutes'
import { stateLabel } from './record-views'
import { thingName } from './thing-words'

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
  /** The kind's plain name (やること, 承認のお願い, 会議の記録…: `thingName`). */
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
  /** What it belongs to (a 案件, a 番組, a プロジェクト) and that kind's name, for its small chip. */
  bundle: { id: string; title: string; typeLabel?: string } | null
  /** `done` only: when it finished (ISO), as far as the list knows (its last change). */
  finishedAt: string | null
  /** A meeting read with no まとまり: the member says which one (「どのまとまりの会議ですか？」). */
  needsBundle?: true
  /**
   * With `needsBundle`: meetings of the same 相手 or series share the key, and the list shows two
   * or more of them as one row 「まとまりを選ぶ会議 n件」 (the server groups them).
   */
  bundleGroup?: { key: string; label: string }
  /**
   * With `needsBundle`: the 相手's one open まとまり (the server's suggestion) — 「『…』の会議ですか？」
   * with はい (the same link as choosing by hand), ちがう／選ぶ and まとまりはない. Never linked before はい.
   */
  suggestedBundle?: { id: string; title: string }
  /** 「AI の番」 only: the server clock put it there because its wait is over (the PC's wait-over step runs it). */
  waitOver?: true
  /**
   * What the row's ☑ does (task v9, 言葉の決まり 5.): `complete` from any state but 準備中;
   * `request_review` (「終わったので見てもらう」) when the member was asked and 確かめてから; `reopen`
   * (「やり直す」) on a finished one the member asked or checked. Absent: no ☑ (the card decides).
   * The server still decides each press.
   */
  check?: { action: 'complete' } | { action: 'request_review'; reviewer: string } | { action: 'reopen' }
}

const COMPLETE_FROM = new Set(['todo', 'in_progress', 'review', 'waiting', 'awaiting_acceptance', 'declined'])
const ASK_TO_CHECK_FROM = new Set(['todo', 'in_progress', 'waiting', 'awaiting_acceptance'])

/** The ☑ of a task row for the member (task v9 `complete` / `request_review` / `reopen`, who_unless). */
export function checkOf(r: RecordSummary, me: string): TaskListItem['check'] {
  if (r.type !== 'task' || !r.state) return undefined
  const f = r.fields
  const assignee = f.assignee === me
  const asker = (f.requested_by ?? me) === me
  const checker = f.reviewer === me
  if (r.state === 'done') return asker || checker ? { action: 'reopen' } : undefined
  const reviewer = typeof f.reviewer === 'string' && f.reviewer ? f.reviewer : typeof f.requested_by === 'string' ? f.requested_by : null
  // 確かめてから: the one asked shows it to the checker instead (who_unless: { assignee: { when_done: check } }).
  if (assignee && !asker && !checker && f.when_done === 'check') {
    return ASK_TO_CHECK_FROM.has(r.state) && reviewer ? { action: 'request_review', reviewer } : undefined
  }
  return COMPLETE_FROM.has(r.state) && (assignee || asker || checker) ? { action: 'complete' } : undefined
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

/**
 * One of the AI's proposals (案) from a meeting (records.md "Task version 11"), as 「議事録を確認する」
 * lists them: `proposed` waits for 「足す」 (action `adopt`) or 「要らない」 (`dismiss`); `dismissed`
 * is put away (「案に戻す」 `propose_again`). Each through `tasks:act` at `version`.
 */
export interface TaskProposal {
  id: string
  title: string
  state: 'proposed' | 'dismissed'
  version: number
  /** Who it would be for (member id) and their name. */
  assignee: string | null
  assigneeName: string | null
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, or null. */
  due: string | null
}

export type TaskProposalsResult =
  | { success: true; proposals: TaskProposal[] }
  | { success: false; offline: boolean; error: string }

/** The words of the 「あなたの番」 item for a meeting read without a まとまり. */
export const MEETING_NEEDS_BUNDLE_TEXT = 'どのまとまり（案件など）の会議か選んでください'
/** The words when the server suggests one まとまり. */
export const meetingSuggestedBundleText = (title: string) => `『${title}』の会議ですか？`

export interface TaskListData {
  /** false: records are off for the company (no list at all). */
  available: boolean
  /** The company setting 「一覧を出す部署」: department ids, or null = every department. */
  listDepartmentIds: string[] | null
  items: TaskListItem[]
  /**
   * What each department makes as its 束ねるもの and the names (`GET /records/bundle-kinds`): the one
   * line's ［〇〇］ for the department on screen, 「〇〇ごと」 with none in the list. Absent: an older server.
   */
  bundleKinds?: BundleKindsResult
  /** The member's own id and the company's members (the one line's 「担当」 picker); absent from an older main. */
  me?: string
  members?: Array<{ id: string; name: string }>
}

export type TaskListResult =
  | { success: true; data: TaskListData }
  | { success: false; offline: boolean; error: string }

export const TASKS_OFFLINE_TEXT = 'サーバーにつながらないため、やることを表示できません。'

/**
 * A new task from the list's one line: the member's own (owner-only), assigned to them — or, with
 * an `assignee` other than the member, asked of that person (「頼む」, task v9): shown to the readers
 * of `folder` (the department on screen; none = the whole company), with 「終わったら」.
 */
export interface TaskCreateInput {
  title: string
  due?: string | null
  tags?: string[]
  /** A member id; the member themselves or absent = their own task. */
  assignee?: string | null
  /** 「終わったら」 when asking: 知らせるだけ (default) or 確かめてから (the member checks). */
  whenDone?: 'notify' | 'check'
  /** The department folder whose readers see an asked task (a company path). */
  folder?: string | null
  /** What it belongs to (a 案件, a プロジェクト): a record id. */
  bundleId?: string | null
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

/** A record link set or taken off later (`tasks:linkRecord` / `tasks:unlinkRecord`): the link's name on the record and the other record. */
export interface RecordLinkInput {
  link: string
  target: string
  expectedVersion: number
}

export type TaskWriteResult =
  /** `entryVersion`: the ledger entry the change made (取り消す undoes it); absent when nothing changed or not known. */
  | { success: true; recordId: string; entryVersion?: number }
  | { success: false; offline: boolean; code: string | null; error: string }

/** A record's bundle with its kind's name (a record id starts with its type: `deal-…`). */
function bundleOf(src: TaskSources, recordId: string): TaskListItem['bundle'] {
  const b = src.bundles[recordId]
  if (!b) return null
  const type = b.id.slice(0, b.id.indexOf('-'))
  const label = src.bundleKindNames?.[type] ?? src.typeLabels[type]
  return label ? { ...b, typeLabel: label } : b
}

/** What the server answered, in the shapes the list sorts. */
export interface TaskSources {
  me: string
  myTurn: RecordSummary[]
  aiTurn: RecordSummary[]
  /** Unfinished tasks the member asked of someone (requested_by = them). */
  asked: RecordSummary[]
  /** Records that reached a final state today, the member's or asked by them. */
  doneToday: RecordSummary[]
  /**
   * 「どのまとまりの会議ですか？」 as the server decides them (`GET /me/minutes/bundle-questions`:
   * the member's meetings with someone from outside, read within the company's days, no まとまり,
   * the question not closed). The app adds none and leaves none out.
   */
  bundleQuestions?: MeetingBundleQuestion[]
  typeLabels: Record<string, string>
  /** Type name → the interfaces it implements, for the types that do. */
  typeImplements?: Record<string, string[]>
  /** Member id → display name. */
  people: Record<string, string>
  /** A bundle type → its name as the company calls it (a plugin's own label, the core's 「プロジェクト」 or the company's name). */
  bundleKindNames?: Record<string, string>
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
  const add = (r: RecordSummary, turn: TaskTurn, waitingFor: string | null, finishedAt: string | null = null, bundleGroup: TaskListItem['bundleGroup'] | null = null, suggested: TaskListItem['suggestedBundle'] | null = null) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({
      id: r.id, type: r.type, typeLabel: thingName({ type: r.type, typeLabel: src.typeLabels[r.type], implements: src.typeImplements?.[r.type], state: r.state }),
      ...(src.typeImplements?.[r.type] ? { implements: src.typeImplements[r.type] } : {}),
      title: r.title || '（名前なし）', state: r.state, stateLabel: stateLabel(r.state, r.type), version: r.version,
      due: typeof r.fields.due === 'string' && r.fields.due ? r.fields.due : null,
      tags: parseTagsValue(r.fields.tags),
      turn, waitingFor, personal: r.personal === true,
      own: r.type === 'task' && r.fields.assignee === src.me && (r.fields.requested_by ?? src.me) === src.me,
      actingFor: r.actingFor ? nameOf(src.people, r.actingFor) : null,
      bundle: bundleOf(src, r.id),
      finishedAt,
      ...(bundleGroup ? { needsBundle: true as const, bundleGroup } : {}),
      ...(bundleGroup && suggested ? { suggestedBundle: suggested } : {}),
      ...(turn === 'ai' && r.waitOver ? { waitOver: true as const } : {}),
      // ☑ on the member's own rows (and a check waiting for them), never on what they asked of someone else.
      ...((turn !== 'ai' && (turn !== 'others' || r.fields.assignee === src.me)) && checkOf(r, src.me) ? { check: checkOf(r, src.me) } : {}),
    })
  }
  for (const r of src.myTurn) {
    if (r.state === 'awaiting_acceptance') add(r, 'acceptance', null)
    else if (r.state === 'waiting') add(r, 'others', waitingWords(r, src.me, src.people))
    else if (r.state === 'declined') add(r, 'mine', `${nameOf(src.people, r.fields.assignee)}さんが受けられないと返しました`)
    else add(r, 'mine', null)
  }
  for (const q of src.bundleQuestions ?? []) {
    const r: RecordSummary = {
      id: q.recordId, type: 'meeting', typeVersion: null, title: q.title, summary: '', path: null, state: 'read', version: q.version,
      fields: q.meetingAt ? { meeting_at: q.meetingAt } : {}, updatedAt: q.readAt,
    }
    const suggested = q.suggested ? { id: q.suggested.id, title: q.suggested.title || '（名前なし）' } : null
    add(r, 'mine', suggested ? meetingSuggestedBundleText(suggested.title) : MEETING_NEEDS_BUNDLE_TEXT, null, q.group, suggested)
  }
  for (const r of src.aiTurn) add(r, 'ai', null)
  for (const r of src.asked) add(r, 'others', waitingWords(r, src.me, src.people))
  // An AI proposal put away (「要らない」, `dismissed`) was never done: it stays out of 今日終わったこと.
  for (const r of src.doneToday) if (r.state !== 'dismissed') add(r, 'done', null, r.updatedAt)
  return out
}

/** The states a task can wait in (not final), for the query of what the member asked. */
export const OPEN_TASK_STATES = ['todo', 'in_progress', 'review', 'waiting', 'preparing', 'declined', 'awaiting_acceptance'] as const
