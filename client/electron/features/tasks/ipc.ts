// The task list (やることの一覧, stage 2 S7b, .claude/rules/tasks-ui.md), with the member's
// session (it stays here):
//   tasks:list    what waits for the member, the AI, others, and today's done — sorted by
//                 client/shared/tasks.ts from the server's answers (nothing filtered here)
//   tasks:archived  the folded 「アーカイブ」: archived tasks, newest first, 20 at a time (two queries merged)
//   tasks:create  the list's one line: a task of the member's own (owner-only)
//   tasks:act     an action on a record (引き受ける, 完了…): the server's engine decides who may
//   tasks:card    one task's card (what the AI prepared, actions, 経緯, its runs waiting for a person);
//                 opening it tells the server (POST …/opened), as the record card does
//   tasks:bundles the unfinished まとまり the member reads, for 「どのまとまりの会議ですか？」 (the choice
//                 itself is minutes:linkBundle)
//   tasks:proposals  the AI's proposals (案) from one meeting, proposed and put away, for
//                 「議事録を確認する」 (足す / 要らない / 案に戻す go through tasks:act)
//   tasks:linkFile / tasks:unlinkFile   a company file or folder linked to a task, or the link
//                 taken away (records.md "Linking files later": the server checks the member reads
//                 both, and refuses a private folder's file for a task outside it)
//   tasks:share   「部署に出す」: the member's owner-only task shown to a department folder's readers
//                 (records.md "Owner-only records"; the server checks the owner and the folder)
//   tasks:suggestTags  tags in use that fit a title: a Haiku model through the company's key, else
//                 the app's own matching (tag-suggest.ts; only the title and the tags are sent)
//   tasks:undo    「取り消す」 right after the member's own action (POST …/undo; the server allows
//                 only the entry's actor and refuses when something changed since)
//   tasks:linkRecord / tasks:unlinkRecord   a link between two records set or taken off later
//                 (POST …/record-links[/remove]; a `one` link such as bundle is replaced; the server
//                 refuses an origin link, a record the member cannot read, or one of another type)
//   tasks:dropLink  something dropped on a record (a record, a file, a folder): the link its type
//                 allows (client/shared/link-drop.ts), made at the versions read now, or the choices
//   tasks:retryRun / tasks:reconcile   a run held for a person: 「もう一度」, or what the member
//                 found in the outside system about an operation whose result was unknown
// The server answers only what the member may read; main adds nothing to it.

import { isCalendarDate } from '../../../../shared/core/business-days'
import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'
import { MESSAGE_TYPE } from '../../../../shared/core/core-types'
import { fileLinkPath, RECORD_ID_RE } from '../../../../shared/core/records'
import { isDateValue, normalizeTagsValue } from '../../../../shared/core/record-types'
import type { BundleKindsResult, RecordDetail, RecordQueryResult, RecordSummary, RecordTypeView } from '../../../../shared/types/records'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import type { TypeDefinition } from '../../../../shared/core/record-types'
import type { AiRunView } from '../../../../shared/types/ai-runs'
import type { MyWorkSwitches } from '../../../../shared/types/work-switches'
import type { ViewersAnswer } from '../../../../shared/types/viewers'
import type { MeetingBundleQuestions } from '../../../../shared/types/minutes'
import { taskCardOf, type TaskCardResult } from '../../../shared/task-card'
import { linkedPaths } from '../../../shared/record-views'
import { dropLinkPlan, type DroppedThing, type DropLinkResult } from '../../../shared/link-drop'
import { OPERATION_KEY_RE } from '../../../../shared/core/ai-runs'
import {
  ARCHIVE_PAGE, ARCHIVE_SHOWN_DAYS, archivedTasks, archivePage, classifyTasks, isArchiveCursor, OPEN_TASK_STATES, proposalMay, TASKS_OFFLINE_TEXT,
  type ArchivedTasksResult, type BundleChoicesResult, type BundleCreateInput, type BundleKindsAnswer, type TaskActInput, type TaskCreateInput, type TaskListResult, type TaskProposalsResult, type TaskWriteResult,
} from '../../../shared/tasks'
import type { IpcRegistrar } from '../../ipc/registrar'
import { createTagSuggester, type TagSuggestDeps } from './tag-suggest'

export interface TasksDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  now?: () => number
  timeoutMs?: number
  /** Tag suggestions through the company's key; absent → the app's own matching only. */
  tagSuggest?: TagSuggestDeps
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const ACTION = /^[a-z][a-z0-9_]{0,39}$/
const MEMBER = /^[A-Za-z0-9_-]{1,100}$/
/** Run ids and operation keys go into the URL: no separators, and never `.` / `..` alone. */
const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/
const opKey = (key: unknown): key is string => typeof key === 'string' && OPERATION_KEY_RE.test(key) && !/^\.+$/.test(key)
const BAD_INPUT = { success: false as const, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
/** At most this many records get their まとまり looked up per read (the rest show without it). */
const BUNDLE_LOOKUPS = 150

/** The company's own holidays from `GET /task-settings` (dates only; unreadable → none: weekends and public holidays still count). */
function holidaysOf(answer: Answer): string[] {
  const list = answer?.status === 200 ? (answer.json?.data as { settings?: { companyHolidays?: unknown } } | undefined)?.settings?.companyHolidays : null
  return Array.isArray(list) ? list.map(h => (h as { date?: unknown })?.date).filter((d): d is string => isCalendarDate(d)).slice(0, 400) : []
}

type Answer = { status: number; json: { data?: unknown; error?: unknown; code?: unknown } | null } | null

export function createTasksApi(deps: TasksDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  const now = deps.now ?? Date.now
  /** `<company>:<record>@<version>` → its まとまり: a record's links change only with its version. */
  const bundleCache = new Map<string, { id: string; title: string } | null>()
  /** The signed-in member's id per session (cookies), from /api/me. */
  let me: { cookies: string; id: string } | null = null

  async function request(url: string, method: 'GET' | 'POST', body?: unknown): Promise<Answer> {
    const cookies = deps.cookies()
    if (cookies.length === 0) return null
    try {
      const res = await doFetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: await res.json().catch(() => null) as NonNullable<Answer>['json'] }
    } catch {
      return null
    }
  }
  const base = () => deps.baseUrl().replace(/\/+$/, '')
  const call = (companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> =>
    base() ? request(`${base()}/api/companies/${encodeURIComponent(companyId)}${path}`, method, body) : Promise.resolve(null)

  async function myId(): Promise<string | null> {
    const cookies = deps.cookies().join('; ')
    if (me && me.cookies === cookies) return me.id
    if (!base()) return null
    const a = await request(`${base()}/api/me`, 'GET')
    const id = (a?.json?.data as { id?: unknown } | undefined)?.id
    if (a?.status !== 200 || typeof id !== 'string') return null
    me = { cookies, id }
    return id
  }

  const records = (a: Answer): RecordSummary[] | null =>
    a?.status === 200 ? ((a.json?.data as RecordQueryResult | undefined)?.records ?? []) : null

  async function people(companyId: string): Promise<Record<string, string>> {
    const a = await call(companyId, 'GET', '/members')
    const out: Record<string, string> = {}
    for (const m of (a?.status === 200 && Array.isArray(a.json?.data) ? a.json.data : []) as Array<{ userId?: unknown; name?: unknown; email?: unknown }>) {
      if (typeof m.userId !== 'string') continue
      const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : typeof m.email === 'string' ? m.email.split('@')[0] : ''
      if (name) out[m.userId] = name
    }
    return out
  }

  /** Each record's まとまり (its outgoing `bundle` link), looked up once per record version. */
  async function bundles(companyId: string, list: RecordSummary[]): Promise<Record<string, { id: string; title: string }>> {
    const out: Record<string, { id: string; title: string }> = {}
    const todo = list.filter(r => r.type === 'task' || r.type === 'meeting').slice(0, BUNDLE_LOOKUPS)
    let next = 0
    async function worker() {
      while (next < todo.length) {
        const r = todo[next++]
        const key = `${companyId}:${r.id}@${r.version}`
        if (!bundleCache.has(key)) {
          const a = await call(companyId, 'GET', `/records/item/${encodeURIComponent(r.id)}`)
          if (a?.status !== 200) continue // not cached: asked again next time
          const link = (a.json?.data as RecordDetail).links.find(l => l.name === 'bundle' && l.direction === 'out' && l.record)
          bundleCache.set(key, link?.record ? { id: link.record.id, title: link.record.title || '（名前なし）' } : null)
        }
        const b = bundleCache.get(key)
        if (b) out[r.id] = b
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
    return out
  }

  function failure(what: string, a: Answer): { success: false; offline: boolean; code: string | null; error: string } {
    const code = typeof a?.json?.code === 'string' ? a.json.code : null
    log.warn(`[tasks] ${what}: ${a ? `answered ${a.status}${code ? ` ${code}` : ''}` : 'the server could not be reached'}`)
    if (!a || a.status >= 500) return { success: false, offline: !a, code, error: TASKS_OFFLINE_TEXT }
    // The engine's refusals are written for members (「ほかの人が先に変えました…」).
    return { success: false, offline: false, code, error: typeof a.json?.error === 'string' ? a.json.error : 'できませんでした。' }
  }

  async function typeDefs(companyId: string): Promise<Map<string, TypeDefinition>> {
    const a = await call(companyId, 'GET', '/records/types')
    const list = a?.status === 200 ? (a.json?.data as { types?: RecordTypeView[] }).types ?? [] : []
    return new Map(list.map(t => [t.definition.name, t.definition]))
  }

  return {
    async card(companyId: string, recordId: string): Promise<TaskCardResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return { success: false, offline: false, error: '入力が正しくありません。' }
      const id = encodeURIComponent(recordId)
      const [me, item, history, defs, names, runs, switches, viewers, settings] = await Promise.all([
        myId(), call(companyId, 'GET', `/records/item/${id}`), call(companyId, 'GET', `/records/item/${id}/history`),
        typeDefs(companyId), people(companyId), call(companyId, 'GET', '/ai-runs'), call(companyId, 'GET', '/me/work-switches'),
        call(companyId, 'POST', '/viewers', { records: [recordId] }),
        // The company's holidays: 返事待ち's chips and 「返事が来ていません（n日）」 count business days.
        call(companyId, 'GET', '/task-settings'),
      ])
      if (item?.status === 404) return { success: false, offline: false, notFound: true, error: '見つかりません。消されたか、見られないものです。' }
      if (item?.status !== 200 || !me) {
        const f = failure('card', item)
        return { success: false, offline: f.offline, error: f.error }
      }
      // Not awaited: the card never waits for it (records.md "Whose turn it was").
      void call(companyId, 'POST', `/records/item/${id}/opened`, {})
      const detail = item.json?.data as RecordDetail
      const entries = history?.status === 200 ? (history.json?.data as { entries?: LedgerEntry[] }).entries ?? [] : []
      const runList = runs?.status === 200 ? (runs.json?.data as { runs?: AiRunView[] }).runs ?? [] : []
      // チームの進め方 is the company's (off by default, also when it cannot be read): how the card looks, not who may.
      const teamMode = switches?.status === 200 && (switches.json?.data as MyWorkSwitches | undefined)?.teamMode?.on === true
      // 「議事録を確認する」 shows its meeting's summary and decisions: the meeting as the member reads it.
      const meetingId = detail.record.fields.task_kind === 'minutes_review'
        ? detail.links.find(l => l.direction === 'out' && l.name === 'meeting' && l.record)?.record?.id : undefined
      const meetingAnswer = meetingId ? await call(companyId, 'GET', `/records/item/${encodeURIComponent(meetingId)}`) : null
      const meeting = meetingAnswer?.status === 200 ? meetingAnswer.json?.data as RecordDetail : undefined
      // 見られる人: only the server's answer for this task (one left out shows nothing).
      const seen = viewers?.status === 200 ? (viewers.json?.data as ViewersAnswer | undefined)?.records?.[recordId] : undefined
      // 「〇人はこのファイルを開けません」: a count per linked path (never who), when the server says.
      const paths = linkedPaths(detail.links)
      const gaps = paths.length > 0 ? await call(companyId, 'POST', '/viewers', { linked: { record: recordId, paths } }) : null
      const cannotOpen = gaps?.status === 200 ? (gaps.json?.data as { cannotOpen?: unknown } | undefined)?.cannotOpen : undefined
      const card = taskCardOf({ me, detail, def: defs.get(detail.record.type), defs, entries, people: names, runs: runList, teamMode, holidays: holidaysOf(settings), cannotOpen, ...(meeting ? { meeting } : {}) })
      return { success: true, card: seen && typeof seen.text === 'string' ? { ...card, viewers: seen } : card }
    },

    async bundles(companyId: string): Promise<BundleChoicesResult> {
      if (!COMPANY.test(companyId)) return { success: false, offline: false, error: '入力が正しくありません。' }
      const [a, defs] = await Promise.all([call(companyId, 'POST', '/records/query', { implements: 'bundle', limit: 200 }), typeDefs(companyId)])
      const list = records(a)
      if (!list) {
        const f = failure('bundles', a)
        return { success: false, offline: f.offline, error: f.error }
      }
      return {
        success: true,
        bundles: list
          .filter(r => !(defs.get(r.type)?.final ?? []).includes(r.state ?? ''))
          .map(r => ({ id: r.id, title: r.title || '（名前なし）', typeLabel: defs.get(r.type)?.label ?? r.type })),
      }
    },

    async proposals(companyId: string, meetingId: string): Promise<TaskProposalsResult> {
      if (!COMPANY.test(companyId) || typeof meetingId !== 'string' || !RECORD_ID_RE.test(meetingId)) return { success: false, offline: false, error: '入力が正しくありません。' }
      const [a, names, defs, id, meeting] = await Promise.all([
        call(companyId, 'POST', '/records/query', { type: 'task', state: ['proposed', 'dismissed'], link: { name: 'meeting', id: meetingId }, limit: 200 }),
        people(companyId), typeDefs(companyId), myId(),
        call(companyId, 'GET', `/records/item/${encodeURIComponent(meetingId)}`),
      ])
      const list = records(a)
      if (!list) {
        const f = failure('proposals', a)
        return { success: false, offline: f.offline, error: f.error }
      }
      const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
      const shown = list.filter(r => r.state === 'proposed' || r.state === 'dismissed')
      const titleOf = new Map(shown.map(r => [r.id, r.title || '（名前なし）']))
      // The list came through the meeting (the server answers it only to its readers): `link:meeting` holds.
      const def = defs.get('task')
      const readerId = meeting?.status === 200 ? str((meeting.json?.data as RecordDetail | undefined)?.record?.fields?.assignee) : null
      return {
        success: true,
        readerId, readerName: readerId ? names[readerId] ?? null : null,
        proposals: shown.map(r => {
          const assignee = str(r.fields.assignee)
          const addedBy = str(r.fields.requested_by)
          // 「似ている案があります」 while the earlier one is still listed and nobody said 「別のもの」.
          const similar = str(r.fields.similar_to)
          const similarTo = similar && !str(r.fields.apart_by) && r.state === 'proposed' && titleOf.has(similar) ? { id: similar, title: titleOf.get(similar) as string } : null
          return {
            id: r.id, title: r.title || '（名前なし）', state: r.state as 'proposed' | 'dismissed', version: r.version,
            assignee, assigneeName: assignee ? names[assignee] ?? null : null, due: str(r.fields.due),
            basis: str(r.fields.basis), addedBy, addedByName: addedBy ? names[addedBy] ?? null : null, similarTo,
            may: proposalMay(def, r.fields, id, true),
          }
        }),
      }
    },

    /** What each department makes as its 束ねるもの and their names (`GET /records/bundle-kinds`). */
    async bundleKinds(companyId: string): Promise<BundleKindsAnswer> {
      if (!COMPANY.test(companyId)) return { success: false, offline: false, error: '入力が正しくありません。' }
      const a = await call(companyId, 'GET', '/records/bundle-kinds')
      const kinds = a?.status === 200 ? (a.json?.data as BundleKindsResult | undefined) : undefined
      if (kinds && kinds.core && Array.isArray(kinds.departments) && Array.isArray(kinds.kinds)) return { success: true, kinds }
      const f = failure('bundle-kinds', a)
      return { success: false, offline: f.offline, error: f.error }
    },

    async linkFile(companyId: string, recordId: string, companyPath: string, expectedVersion: number, remove: boolean): Promise<TaskWriteResult> {
      const path = typeof companyPath === 'string' ? fileLinkPath(companyPath.normalize('NFC')) : null
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !path || !Number.isInteger(expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/file-links${remove ? '/remove' : ''}`, { path, expectedVersion })
      return a?.status === 200 ? { success: true, recordId } : failure(remove ? 'unlink file' : 'link file', a)
    },

    async share(companyId: string, recordId: string, folder: string, expectedVersion: number): Promise<TaskWriteResult> {
      const path = typeof folder === 'string' ? fileLinkPath(folder.normalize('NFC')) : null
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !path || !Number.isInteger(expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/share`, { folder: path, expectedVersion })
      return a?.status === 200 ? { success: true, recordId } : failure('share', a)
    },

    /** ［〇〇の人に見せる］: `toBundle` — the server takes the place of the 案件 the task links to. */
    async shareToBundle(companyId: string, recordId: string, expectedVersion: number): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !Number.isInteger(expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/share`, { toBundle: true, expectedVersion })
      return a?.status === 200 ? { success: true, recordId } : failure('share to bundle', a)
    },

    async undo(companyId: string, recordId: string, version: number, expectedVersion: number): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      if (!Number.isInteger(version) || version < 2 || !Number.isInteger(expectedVersion) || expectedVersion < version) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/undo`, { version, expectedVersion })
      return a?.status === 200 || a?.status === 201 ? { success: true, recordId } : failure('undo', a)
    },

    async linkRecord(companyId: string, recordId: string, input: { link: string; target: string; expectedVersion: number; narrow?: boolean }, remove: boolean): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      if (!input || typeof input.link !== 'string' || !ACTION.test(input.link) || typeof input.target !== 'string' || !RECORD_ID_RE.test(input.target) || !Number.isInteger(input.expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/record-links${remove ? '/remove' : ''}`,
        // `narrow` only on the member's yes to 「〇〇と同じ人たちだけに見えるようにしますか？」.
        { link: input.link, target: input.target, expectedVersion: input.expectedVersion, ...(!remove && input.narrow === true ? { narrow: true } : {}) })
      if (a?.status !== 200 && a?.status !== 201) return failure(remove ? 'unlink record' : 'link record', a)
      const entry = (a.json?.data as { entry?: { version?: unknown } | null } | undefined)?.entry
      return { success: true, recordId, ...(typeof entry?.version === 'number' ? { entryVersion: entry.version } : {}) }
    },

    /**
     * Something dropped on a record (its 「つながっているもの」 or its list row): which link it becomes
     * comes from the two types (`dropLinkPlan`); several → the member picks (`link` sent again).
     * Each record is read now, so the link is made at the version the server has.
     */
    async dropLink(companyId: string, targetId: string, dropped: DroppedThing, link?: string): Promise<DropLinkResult> {
      const bad = { success: false as const, offline: false, error: '入力が正しくありません。' }
      if (!COMPANY.test(companyId) || typeof targetId !== 'string' || !RECORD_ID_RE.test(targetId)) return bad
      if (link !== undefined && (typeof link !== 'string' || !ACTION.test(link))) return bad
      const path = dropped?.kind === 'path' && typeof dropped.path === 'string' ? fileLinkPath(dropped.path.normalize('NFC')) : null
      const otherId = dropped?.kind === 'record' && typeof dropped.id === 'string' && RECORD_ID_RE.test(dropped.id) ? dropped.id : null
      if (!path && !otherId) return bad
      if (otherId === targetId) return { success: false, offline: false, error: '同じものどうしはつなげません。' }
      const [defs, targetAnswer, otherAnswer] = await Promise.all([
        typeDefs(companyId),
        call(companyId, 'GET', `/records/item/${encodeURIComponent(targetId)}`),
        otherId ? call(companyId, 'GET', `/records/item/${encodeURIComponent(otherId)}`) : Promise.resolve(null),
      ])
      const read = (a: Answer, what: string) => {
        if (a?.status === 200) return (a.json?.data as RecordDetail).record
        const f = failure(`drop link: ${what}`, a)
        return { success: false as const, offline: f.offline, error: a?.status === 404 ? '見つかりません。消されたか、見られないものです。' : f.error }
      }
      const target = read(targetAnswer, 'target')
      if ('success' in target) return target
      const other = otherId ? read(otherAnswer, 'dropped') : null
      if (other && 'success' in other) return other
      const plan = dropLinkPlan({ type: target.type, def: defs.get(target.type) }, other ? { type: other.type, def: defs.get(other.type) } : 'file')
      if ('refused' in plan) return { success: false, offline: false, error: plan.refused }
      const name = other ? other.title || '（名前なし）' : (path as string).split('/').pop() ?? (path as string)
      const pick = link !== undefined ? plan.choices.find(c => c.link === link) : plan.choices.length === 1 ? plan.choices[0] : undefined
      if (!pick) {
        if (link !== undefined) return bad
        return { success: true, choose: plan.choices, question: `「${name}」を、どのつながりにしますか？` }
      }
      const source = pick.source === 'target' ? target : other!
      const a = path
        ? await call(companyId, 'POST', `/records/item/${encodeURIComponent(targetId)}/file-links`, { path, link: pick.link, expectedVersion: target.version })
        : await call(companyId, 'POST', `/records/item/${encodeURIComponent(source.id)}/record-links`,
          { link: pick.link, target: pick.source === 'target' ? other!.id : target.id, expectedVersion: source.version })
      if (a?.status !== 200 && a?.status !== 201) {
        const f = failure('drop link', a)
        return { success: false, offline: f.offline, error: f.error }
      }
      const data = a.json?.data as { entry?: { version?: unknown } | null; changed?: unknown } | undefined
      if (data?.changed === false) return { success: true, done: { text: `「${name}」はもうつながっています`, undo: null } }
      const version = data?.entry?.version
      return { success: true, done: { text: `「${name}」をつなぎました`, undo: typeof version === 'number' ? { recordId: source.id, version } : null } }
    },

    async retryRun(companyId: string, runId: string): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof runId !== 'string' || !RUN_ID.test(runId)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/ai-runs/${encodeURIComponent(runId)}/retry`, {})
      return a?.status === 200 ? { success: true, recordId: '' } : failure('retry run', a)
    },

    async reconcile(companyId: string, runId: string, key: string, done: boolean): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof runId !== 'string' || !RUN_ID.test(runId) || !opKey(key) || typeof done !== 'boolean') return BAD_INPUT
      const a = await call(companyId, 'POST', `/ai-runs/${encodeURIComponent(runId)}/operations/${encodeURIComponent(key)}/reconcile`, { done })
      return a?.status === 200 ? { success: true, recordId: '' } : failure('reconcile', a)
    },

    async list(companyId: string): Promise<TaskListResult> {
      if (!COMPANY.test(companyId)) return { success: false, offline: false, error: '入力が正しくありません。' }
      const id = await myId()
      if (!id) return { success: false, offline: true, error: TASKS_OFFLINE_TEXT }
      const since = new Date(dayWindow(now(), DEFAULT_COMPANY_TIME_ZONE).from).toISOString()
      const [myTurn, aiTurn, asked, doneMine, doneAsked, types, names, settings, questions, kinds, settled] = await Promise.all([
        call(companyId, 'GET', '/records/my-turn'),
        call(companyId, 'GET', '/records/ai-turn'),
        call(companyId, 'POST', '/records/query', { type: 'task', state: [...OPEN_TASK_STATES], fields: { requested_by: id }, limit: 200 }),
        call(companyId, 'POST', '/records/query', { type: 'task', finishedSince: since, fields: { assignee: id }, limit: 100 }),
        call(companyId, 'POST', '/records/query', { type: 'task', finishedSince: since, fields: { requested_by: id }, limit: 100 }),
        call(companyId, 'GET', '/records/types'),
        people(companyId),
        call(companyId, 'GET', '/task-settings'),
        // 「どのまとまりの会議ですか？」: the server decides which meetings ask (minutes.md).
        call(companyId, 'GET', '/me/minutes/bundle-questions'),
        // What each department makes as its 束ねるもの and their names (records.md "Bundle kinds").
        call(companyId, 'GET', '/records/bundle-kinds'),
        // 来た連絡 the member closed with 「済んだ」 today (interaction 6's settled_by: never what the AI judged).
        call(companyId, 'POST', '/records/query', { type: MESSAGE_TYPE, finishedSince: since, fields: { settled_by: id }, limit: 100 }),
      ])
      if (myTurn?.status === 404 && myTurn.json?.code === 'RECORDS_DISABLED') {
        return { success: true, data: { available: false, listDepartmentIds: null, items: [] } }
      }
      const lists = [myTurn, aiTurn, asked, doneMine, doneAsked].map(records)
      if (lists.some(l => l === null)) {
        const bad = [myTurn, aiTurn, asked, doneMine, doneAsked].find(a => a?.status !== 200) ?? null
        const f = failure('list', bad)
        return { success: false, offline: f.offline, error: f.error }
      }
      const [mine, ai, askedList, done1, done2] = lists as RecordSummary[][]
      const typeLabels: Record<string, string> = {}
      const typeImplements: Record<string, string[]> = {}
      for (const t of (types?.status === 200 ? (types.json?.data as { types?: RecordTypeView[] }).types ?? [] : [])) {
        typeLabels[t.definition.name] = t.definition.label
        if (t.definition.implements?.length) typeImplements[t.definition.name] = t.definition.implements
      }
      const ids = (settings?.status === 200 ? (settings.json?.data as { settings?: { taskListDepartmentIds?: unknown } }).settings?.taskListDepartmentIds : null)
      const holidays = holidaysOf(settings)
      // An older server (no settled_by yet) refuses the query: nothing settled, the list itself still shows.
      const doneToday = [...done1, ...done2, ...(records(settled) ?? [])]
      // An older server without the route, or no answer: nothing asks (the list itself still shows).
      const bundleQuestions = questions?.status === 200 ? (questions.json?.data as MeetingBundleQuestions | undefined)?.questions ?? [] : []
      const linked = await bundles(companyId, [...mine, ...ai, ...askedList, ...doneToday])
      // An older server without the route: the types' own labels name them (as before).
      const bundleKinds = kinds?.status === 200 ? (kinds.json?.data as BundleKindsResult | undefined) ?? null : null
      return {
        success: true,
        data: {
          available: true,
          listDepartmentIds: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null,
          me: id,
          ...(bundleKinds ? { bundleKinds } : {}),
          members: Object.entries(names).map(([memberId, name]) => ({ id: memberId, name })),
          items: classifyTasks({
            me: id,
          ...(bundleKinds ? { bundleKinds } : {}), myTurn: mine, aiTurn: ai, asked: askedList, doneToday, typeLabels, typeImplements, people: names, bundles: linked,
            ...(bundleKinds ? { bundleKindNames: Object.fromEntries(bundleKinds.kinds.map(k => [k.type, k.name])) } : {}),
            bundleQuestions,
            today: dayWindow(now(), DEFAULT_COMPANY_TIME_ZONE).date, holidays,
          }),
        },
      }
    },

    /**
     * The folded 「アーカイブ」 at the bottom of the list: archived tasks assigned to the member or asked
     * by them within `ARCHIVE_SHOWN_DAYS` (the server's `finishedSince`: when it entered the archive),
     * newest first, `ARCHIVE_PAGE` at a time from `cursor` (`archivePage`). The server
     * answers only what the member reads (someone's own task to its owner alone).
     */
    async archived(companyId: string, cursor: unknown): Promise<ArchivedTasksResult> {
      if (!COMPANY.test(companyId) || !isArchiveCursor(cursor)) return { success: false, offline: false, error: '入力が正しくありません。' }
      const id = await myId()
      if (!id) return { success: false, offline: true, error: TASKS_OFFLINE_TEXT }
      // Only what was archived within ARCHIVE_SHOWN_DAYS (entered 「アーカイブ」 since then): older ones stay in 探す.
      const since = new Date(now() - ARCHIVE_SHOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()
      const query = (field: 'assignee' | 'requested_by', offset: number) =>
        call(companyId, 'POST', '/records/query', { type: 'task', state: ['cancelled'], fields: { [field]: id }, finishedSince: since, limit: ARCHIVE_PAGE, offset })
      const [assigned, asked] = await Promise.all([query('assignee', cursor.assignee), query('requested_by', cursor.requester)])
      const page = (a: Answer) => (a?.status === 200 ? a.json?.data as RecordQueryResult | undefined : undefined)
      const a = page(assigned)
      const r = page(asked)
      if (!a || !r) {
        const f = failure('archived', !a ? assigned : asked)
        return { success: false, offline: f.offline, error: f.error }
      }
      const { records: shown, next } = archivePage(a, r, cursor)
      return { success: true, items: archivedTasks(shown), next }
    },

    async createBundle(companyId: string, input: BundleCreateInput): Promise<TaskWriteResult> {
      const title = typeof input?.title === 'string' ? input.title.normalize('NFC').trim() : ''
      if (!COMPANY.test(companyId) || !title || title.length > 200 || typeof input.type !== 'string' || !ACTION.test(input.type)) return BAD_INPUT
      if (input.counterpart != null && (typeof input.counterpart !== 'string' || !RECORD_ID_RE.test(input.counterpart))) return BAD_INPUT
      const folder = input.folder == null || input.folder === '' ? null : typeof input.folder === 'string' ? fileLinkPath(input.folder) : null
      if (input.folder != null && input.folder !== '' && !folder) return BAD_INPUT
      const me = await myId()
      if (!me) return { success: false, offline: true, code: null, error: TASKS_OFFLINE_TEXT }
      // The 責任者 is not filled in by the server: the member who makes it.
      const a = await call(companyId, 'POST', '/records/item', {
        type: input.type, title, fields: { owner: me }, ...(folder ? { folder } : {}),
        ...(input.counterpart ? { links: { counterpart: input.counterpart } } : {}),
      })
      const record = (a?.json?.data as { record?: { id?: unknown } } | undefined)?.record
      if ((a?.status === 201 || a?.status === 200) && typeof record?.id === 'string') return { success: true, recordId: record.id }
      return failure('create bundle', a)
    },

    async create(companyId: string, input: TaskCreateInput): Promise<TaskWriteResult> {
      const title = typeof input?.title === 'string' ? input.title.normalize('NFC').trim() : ''
      if (!COMPANY.test(companyId) || !title || title.length > 200) return BAD_INPUT
      if (input.due != null && (typeof input.due !== 'string' || !isDateValue(input.due))) return BAD_INPUT
      const tags = input.tags && input.tags.length > 0 ? normalizeTagsValue(input.tags) : null
      if (tags !== null && typeof tags !== 'string') return BAD_INPUT
      if (input.assignee != null && (typeof input.assignee !== 'string' || !MEMBER.test(input.assignee))) return BAD_INPUT
      if (input.whenDone != null && input.whenDone !== 'notify' && input.whenDone !== 'check') return BAD_INPUT
      if (input.bundleId != null && (typeof input.bundleId !== 'string' || !RECORD_ID_RE.test(input.bundleId))) return BAD_INPUT
      const folder = input.folder == null || input.folder === '' ? null : typeof input.folder === 'string' ? fileLinkPath(input.folder) : null
      if (input.folder != null && input.folder !== '' && !folder) return BAD_INPUT
      const id = await myId()
      if (!id) return { success: false, offline: true, code: null, error: TASKS_OFFLINE_TEXT }
      // Asked of someone else: shared with the folder's readers, never owner-only (they could not read it).
      const asking = !!input.assignee && input.assignee !== id
      const fields: Record<string, unknown> = { assignee: asking ? input.assignee : id }
      if (input.due) fields.due = input.due
      if (tags) fields.tags = JSON.parse(tags) as string[]
      if (asking) {
        fields.when_done = input.whenDone ?? 'notify'
        if (input.whenDone === 'check') fields.reviewer = id
      }
      const body = {
        type: 'task', title, fields,
        // For a 案件・プロジェクト the server gives it that 案件's 見える範囲 (records.md "A task and its
        // 案件・プロジェクト"): no folder of the screen's then.
        ...(asking ? (folder && !input.bundleId ? { folder } : {}) : { personal: true }),
        ...(input.bundleId ? { links: { bundle: input.bundleId } } : {}),
      }
      const a = await call(companyId, 'POST', '/records/item', body)
      const record = (a?.json?.data as { record?: { id?: unknown } } | undefined)?.record
      if (a?.status === 201 && typeof record?.id === 'string') return { success: true, recordId: record.id }
      return failure('create', a)
    },

    async act(companyId: string, recordId: string, input: TaskActInput): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      if (!input || typeof input.action !== 'string' || !ACTION.test(input.action) || !Number.isInteger(input.expectedVersion)) return BAD_INPUT
      if (input.ok && input.ok.by !== undefined && !MEMBER.test(input.ok.by)) return BAD_INPUT
      const body = {
        expectedVersion: input.expectedVersion,
        ...(input.note ? { note: input.note } : {}),
        ...(input.args ? { args: input.args } : {}),
        ...(input.links ? { links: input.links } : {}),
        ...(input.ok ? { ok: input.ok } : {}),
      }
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/actions/${input.action}`, body)
      if (a?.status === 200) return { success: true, recordId }
      return failure(`act ${input.action}`, a)
    },
  }
}

export function registerTasksIpc(ipc: IpcRegistrar, deps: TasksDeps): void {
  const api = createTasksApi(deps)
  const tags = createTagSuggester(deps.tagSuggest ?? { brokerEnv: async () => ({}) })
  ipc.handle('tasks:suggestTags', (_event, companyId, title, inUse) => tags.suggest(typeof companyId === 'string' ? companyId : '', title, inUse))
  ipc.handle('tasks:list', (_event, companyId) => api.list(typeof companyId === 'string' ? companyId : ''))
  ipc.handle('tasks:archived', (_event, companyId, cursor) => api.archived(typeof companyId === 'string' ? companyId : '', cursor))
  ipc.handle('tasks:create', (_event, companyId, input) => api.create(typeof companyId === 'string' ? companyId : '', input))
  ipc.handle('tasks:act', (_event, companyId, recordId, input) => api.act(typeof companyId === 'string' ? companyId : '', recordId, input))
  ipc.handle('tasks:card', (_event, companyId, recordId) => api.card(typeof companyId === 'string' ? companyId : '', recordId))
  ipc.handle('tasks:bundles', (_event, companyId) => api.bundles(typeof companyId === 'string' ? companyId : ''))
  ipc.handle('tasks:proposals', (_event, companyId, meetingId) => api.proposals(typeof companyId === 'string' ? companyId : '', meetingId))
  ipc.handle('tasks:bundleKinds', (_event, companyId) => api.bundleKinds(typeof companyId === 'string' ? companyId : ''))
  ipc.handle('tasks:linkFile', (_event, companyId, recordId, companyPath, expectedVersion) =>
    api.linkFile(typeof companyId === 'string' ? companyId : '', recordId, companyPath, expectedVersion, false))
  ipc.handle('tasks:unlinkFile', (_event, companyId, recordId, companyPath, expectedVersion) =>
    api.linkFile(typeof companyId === 'string' ? companyId : '', recordId, companyPath, expectedVersion, true))
  ipc.handle('tasks:share', (_event, companyId, recordId, folder, expectedVersion) =>
    api.share(typeof companyId === 'string' ? companyId : '', recordId, folder, expectedVersion))
  ipc.handle('tasks:shareToBundle', (_event, companyId, recordId, expectedVersion) =>
    api.shareToBundle(typeof companyId === 'string' ? companyId : '', recordId, expectedVersion))
  ipc.handle('tasks:retryRun', (_event, companyId, runId) => api.retryRun(typeof companyId === 'string' ? companyId : '', runId))
  ipc.handle('tasks:createBundle', (_event, companyId, input) => api.createBundle(typeof companyId === 'string' ? companyId : '', input))
  ipc.handle('tasks:linkRecord', (_event, companyId, recordId, input) => api.linkRecord(typeof companyId === 'string' ? companyId : '', recordId, input, false))
  ipc.handle('tasks:unlinkRecord', (_event, companyId, recordId, input) => api.linkRecord(typeof companyId === 'string' ? companyId : '', recordId, input, true))
  ipc.handle('tasks:dropLink', (_event, companyId, targetId, dropped, link) => api.dropLink(typeof companyId === 'string' ? companyId : '', targetId, dropped, link))
  ipc.handle('tasks:undo', (_event, companyId, recordId, version, expectedVersion) => api.undo(typeof companyId === 'string' ? companyId : '', recordId, version, expectedVersion))
  ipc.handle('tasks:reconcile', (_event, companyId, runId, key, done) => api.reconcile(typeof companyId === 'string' ? companyId : '', runId, key, done))
}
