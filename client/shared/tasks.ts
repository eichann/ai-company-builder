/**
 * The task list (やることの一覧, stage 2 S7b; `.claude/rules/tasks-ui.md`): what main
 * answers the renderer, and the rules that put each record in its place. Main reads the
 * server with the member's session (the server already left out what the member may
 * not read); this only sorts and words it. Pure: main, the renderer and tests import it.
 */
import { addBusinessDays, addDays, businessDaysBetween, isBusinessDay, nextBusinessDay } from '../../shared/core/business-days'
import { argDefaultOf } from '../../shared/core/core-types'
import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../shared/core/calendar'
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
  /**
   * A task the member asked of someone else, not finished (requested_by = them, assignee another):
   * its row shows 「人に頼んだもの」, not the task's icon, which read as a ticked box (owner 2026-11-02).
   */
  askedOfOthers?: true
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

/** `tasks:bundleKinds`: what each department makes as its 束ねるもの, and the names (records.md "Bundle kinds"). */
export type BundleKindsAnswer =
  | { success: true; kinds: BundleKindsResult }
  | { success: false; offline: boolean; error: string }

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

/**
 * The words of the question 「どの〇〇の会議ですか？」 for a meeting read without a bundle, in the
 * kind's own name (`word`: the department's kind — 「案件」, 「プロジェクト」); the umbrella word
 * 「まとまり」 never shows (owner 2026-11-02, records.md "Bundle kinds").
 */
export function meetingBundleWords(word: string) {
  return {
    question: `どの${word}の会議ですか？`,
    ask: `どの${word}の会議か選んでください`,
    choose: `${word}を選ぶ`,
    none: `${word}はない`,
    noneLong: `${word}はない（社内の会議など）`,
    declined: `${word}はない、と決めた会議です。あとからでも選べます。`,
    group: (n: number) => `${word}を選ぶ会議 ${n}件`,
  }
}
/**
 * The 「あなたの番」 item's words as main places it (it knows no department); the screens say it
 * again in the department's kind (`meetingBundleWords(word).ask`).
 */
export const MEETING_NEEDS_BUNDLE_TEXT = meetingBundleWords('案件・プロジェクト').ask
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
/**
 * 「新しい〇〇にする」: a new 案件・プロジェクト of the department's kind (`type` from `tasks:bundleKinds`),
 * the member as its 責任者, in `folder` (the department's readers see it), with the 相手 when known.
 */
export interface BundleCreateInput {
  type: string
  title: string
  folder?: string | null
  counterpart?: string | null
}

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
  /** The company's today (`YYYY-MM-DD`) and own holidays: a wait given back counts business days. */
  today?: string
  holidays?: string[]
}

/** Business days of 返事待ち's default 見込み (the core's `ARG_DEFAULTS`). */
const WAIT_DEFAULT_BUSINESS_DAYS = argDefaultOf('task', 'wait', 'wait_until')?.businessDays ?? 3

const nameOf = (people: Record<string, string>, id: unknown): string =>
  typeof id === 'string' && id ? (people[id] ?? 'メンバー') : 'メンバー'

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** A 見込み in short: `2026-11-06` → 11/6, `2026-11-06T15:00` → 11/6 15:00. */
export function waitUntilText(until: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?$/.exec(until)
  return m ? `${Number(m[1])}/${Number(m[2])}${m[3] ? ` ${m[3]}` : ''}` : until
}

/** One chip of 「いつごろ来そうか」: its words and the 見込み it sets (`YYYY-MM-DD`). */
export interface WaitChoice {
  key: 'tomorrow' | 'three' | 'next-week'
  label: string
  until: string
}

/**
 * The chips of 「いつごろ来そうか」 (task version 12) from the company's `today`: ［明日］ (the next
 * business day — 「次の営業日」 when that is not tomorrow), ［3日後］ (3 business days: also what
 * the server sets when nothing is chosen, `ARG_DEFAULTS`), ［来週］ (the same weekday next week,
 * or the business day after it). ［日を選ぶ］ is the screen's own date field.
 */
export function waitChoices(today: string, holidays: Iterable<string> = []): WaitChoice[] {
  const own = [...holidays]
  const next = nextBusinessDay(today, own)
  const week = addDays(today, 7)
  return [
    { key: 'tomorrow', label: next === addDays(today, 1) ? '明日' : '次の営業日', until: next },
    { key: 'three', label: '3日後', until: addBusinessDays(today, WAIT_DEFAULT_BUSINESS_DAYS, own) },
    { key: 'next-week', label: '来週', until: isBusinessDay(week, own) ? week : nextBusinessDay(week, own) },
  ]
}

/** The 見込み when nothing is chosen (the server's own default: 3 business days after today). */
export function defaultWaitUntil(today: string, holidays: Iterable<string> = []): string {
  return addBusinessDays(today, WAIT_DEFAULT_BUSINESS_DAYS, holidays)
}

/** 「返事待ち：先方からの返事（11/6 ごろまで）」 (task version 12: the 見込み while it waits). */
export function waitingLine(on: string | null, until: string | null): string {
  return `返事待ち${on ? `：${on}` : ''}${until ? `（${waitUntilText(until)} ごろまで）` : ''}`
}

/**
 * 「先方からの返事が来ていません（3日）」: a task the clock gave back (`waitCameBack`). The days are
 * business days since it began to wait, up to `today` (company date; the company's holidays
 * skipped); left out when not known or none yet.
 */
export function cameBackLine(on: string | null, waitedSince: string | null, today: string, holidays: Iterable<string> = []): string {
  const since = waitedSince && !Number.isNaN(Date.parse(waitedSince)) ? dayWindow(Date.parse(waitedSince), DEFAULT_COMPANY_TIME_ZONE).date : null
  const days = since ? businessDaysBetween(since, today, holidays) : 0
  return `${on ?? '返事'}が来ていません${days > 0 ? `（${days}日）` : ''}`
}

/** Who or what an item waits for, in members' words (null when it is the member's own). */
function waitingWords(r: RecordSummary, me: string, people: Record<string, string>): string | null {
  const assignee = r.fields.assignee
  if (r.state === 'awaiting_acceptance') return `${nameOf(people, assignee)}さんに頼んだ・引き受け待ち`
  if (r.state === 'waiting') return waitingLine(text(r.fields.waiting_on), text(r.fields.wait_until))
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
      ...(r.type === 'task' && turn !== 'done' && r.fields.requested_by === src.me && typeof r.fields.assignee === 'string' && r.fields.assignee !== src.me ? { askedOfOthers: true as const } : {}),
      // ☑ on the member's own rows (and a check waiting for them), never on what they asked of someone else.
      ...((turn !== 'ai' && (turn !== 'others' || r.fields.assignee === src.me)) && checkOf(r, src.me) ? { check: checkOf(r, src.me) } : {}),
    })
  }
  for (const r of src.myTurn) {
    if (r.state === 'awaiting_acceptance') add(r, 'acceptance', null)
    else if (r.state === 'waiting') add(r, 'others', waitingWords(r, src.me, src.people))
    else if (r.state === 'declined') add(r, 'mine', `${nameOf(src.people, r.fields.assignee)}さんが受けられないと返しました`)
    else if (r.waitCameBack && src.today) add(r, 'mine', cameBackLine(text(r.fields.waiting_on), r.waitCameBack.waitedSince, src.today, src.holidays ?? []))
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
  // An AI proposal put away (「要らない」, `dismissed`) was never done, and an archived task (アーカイブ,
  // `cancelled`) left the list: neither is in 今日終わったこと (the archive is at the bottom).
  for (const r of src.doneToday) if (r.state !== 'dismissed' && r.state !== 'cancelled') add(r, 'done', null, r.updatedAt)
  return out
}

/** The states a task can wait in (not final), for the query of what the member asked. */
export const OPEN_TASK_STATES = ['todo', 'in_progress', 'review', 'waiting', 'preparing', 'declined', 'awaiting_acceptance'] as const

// --- The archive (アーカイブ, owner decision 2026-11-03) -------------------------------------

/** How many archived tasks one press shows (the first opening, then each 「さらに読み込む」). */
export const ARCHIVE_PAGE = 20

/**
 * Where the next page starts in each of the two queries main merges: archived tasks assigned to
 * the member and those they asked (`requested_by`). Both come in the server's order (most
 * recently changed first), so the merge is by `updatedAt`.
 */
export interface ArchiveCursor { assignee: number; requester: number }

/** One archived task in the folded 「アーカイブ」 section (it opens its card, where ［戻す］ is). */
export interface ArchivedTask {
  id: string
  title: string
  /** When it was archived as far as the list knows (its last change, ISO). */
  archivedAt: string
  personal: boolean
}

export type ArchivedTasksResult =
  | { success: true; items: ArchivedTask[]; next: ArchiveCursor | null }
  | { success: false; offline: boolean; error: string }

export function isArchiveCursor(c: unknown): c is ArchiveCursor {
  const o = c as ArchiveCursor | null
  return typeof o === 'object' && o !== null && [o.assignee, o.requester].every(n => Number.isInteger(n) && n >= 0 && n <= 10_000)
}

/** The server's order: most recently changed first, then the id (`adapters/sqlite/records.ts`). */
const newerFirst = (a: RecordSummary, b: RecordSummary) =>
  (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.updatedAt > b.updatedAt ? -1 : 1)

/**
 * One page of the archive from the two queries (each asked for `size` from its cursor): taken in
 * the server's order, a task in both counted once (one's own task is in both), never past the end
 * of a window whose query has more (what follows it is not known yet). Each query's cursor moves
 * by what was taken from it; `next` is null once both are read to the end.
 */
export function archivePage(
  assigned: { records: RecordSummary[]; total: number },
  asked: { records: RecordSummary[]; total: number },
  cursor: ArchiveCursor,
  size = ARCHIVE_PAGE,
): { records: RecordSummary[]; next: ArchiveCursor | null } {
  let i = 0
  let j = 0
  const out: RecordSummary[] = []
  const taken = new Set<string>()
  const moreA = cursor.assignee + assigned.records.length < assigned.total
  const moreR = cursor.requester + asked.records.length < asked.total
  while (out.length < size) {
    const a = assigned.records[i]
    const r = asked.records[j]
    // A window read to its end whose query has more: stop; the next page asks again from there.
    if ((!a && moreA) || (!r && moreR) || (!a && !r)) break
    const pick = !r || (a && newerFirst(a, r) <= 0) ? a! : r
    if (a?.id === pick.id) i++
    if (r?.id === pick.id) j++
    if (!taken.has(pick.id)) { taken.add(pick.id); out.push(pick) }
  }
  const next = { assignee: cursor.assignee + i, requester: cursor.requester + j }
  return { records: out, next: next.assignee < assigned.total || next.requester < asked.total ? next : null }
}

/** The archive's rows (only archived tasks: a record answered in another state is left out). */
export function archivedTasks(records: RecordSummary[]): ArchivedTask[] {
  return records.filter(r => r.type === 'task' && r.state === 'cancelled').map(r => ({
    id: r.id, title: r.title || '（名前なし）', archivedAt: r.updatedAt, personal: r.personal === true,
  }))
}
