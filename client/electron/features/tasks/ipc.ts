// The task list (やることの一覧, stage 2 S7b, .claude/rules/tasks-ui.md), with the member's
// session (it stays here):
//   tasks:list    what waits for the member, the AI, others, and today's done — sorted by
//                 client/shared/tasks.ts from the server's answers (nothing filtered here)
//   tasks:archived  the folded 「アーカイブ」: archived tasks, newest first, 20 at a time (two queries merged)
//   tasks:create  the list's one line: a task of the member's own (owner-only); from a meeting's card
//                 (`meetingId`) one of the meeting's, with the server's 「似ているやることがあります」 (`similar`)
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
//                 (records.md "Owner-only records"; the server checks the owner and the folder), with
//                 the server's 「似ているやることがあります」 (`similar`) for a task from a meeting
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
import { featuresFrom } from '../../../../shared/core/features'
import { drivePreselectIds } from '../../../../shared/core/google-drive'
import { driveLinkTarget, fileLinkPath, RECORD_ID_RE } from '../../../../shared/core/records'
import { isDateValue, normalizeTagsValue } from '../../../../shared/core/record-types'
import type { BundleKindsResult, RecordDetail, RecordQueryResult, RecordSummary, RecordTypeView } from '../../../../shared/types/records'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import type { TypeDefinition } from '../../../../shared/core/record-types'
import type { AiRunView } from '../../../../shared/types/ai-runs'
import type { MyWorkSwitches } from '../../../../shared/types/work-switches'
import type { ViewersAnswer } from '../../../../shared/types/viewers'
import type { MeetingBundleQuestions } from '../../../../shared/types/minutes'
import { taskCardOf, type TaskCardResult } from '../../../shared/task-card'
import { linkedPaths, makePrivateOfferOf, type MakePrivatePlanResult } from '../../../shared/record-views'
import { dropLinkPlan, type DroppedThing, type DropLinkResult } from '../../../shared/link-drop'
import { OPERATION_KEY_RE } from '../../../../shared/core/ai-runs'
import {
  type TaskDriveChoice, type TaskDriveLinkResult, type TypedFileTarget, ARCHIVE_PAGE, TASK_DRIVE_CHOICES_MAX, ARCHIVE_SHOWN_DAYS, archivedTasks, archivePage, classifyTasks, isArchiveCursor, OPEN_TASK_STATES, proposalMay, similarOf, TASKS_OFFLINE_TEXT,
  type ArchivedTasksResult, type SimilarItem, type BundleChoicesResult, type BundleCreateInput, type BundleKindsAnswer, type TaskActInput, type TaskCreateInput, type TaskListResult, type TaskProposalsResult, type TaskWriteResult,
} from '../../../shared/tasks'
import type { IpcRegistrar } from '../../ipc/registrar'
import { createTagSuggester, type TagSuggestDeps } from './tag-suggest'

/** Only a working-folder path or a well-formed Drive id ever reaches the server. */
function typedTarget(t: unknown): TypedFileTarget | null {
  const v = t as { kind?: unknown; path?: unknown; fileId?: unknown } | null
  if (v?.kind === 'local' && typeof v.path === 'string') {
    const path = fileLinkPath(v.path.normalize('NFC'))
    return path ? { kind: 'local', path } : null
  }
  if (v?.kind === 'drive' && driveLinkTarget(v.fileId)) return { kind: 'drive', fileId: v.fileId as string }
  return null
}

/** A list of Drive files as main takes it: Drive ids, names as text, at most the Picker's number. */
function driveChoicesOf(v: unknown): TaskDriveChoice[] | null {
  if (!Array.isArray(v) || v.length > TASK_DRIVE_CHOICES_MAX) return null
  const out: TaskDriveChoice[] = []
  for (const f of v as Array<{ id?: unknown; name?: unknown; source?: unknown } | null>) {
    if (!f || !driveLinkTarget(f.id) || typeof f.name !== 'string' || f.name.length > 300) return null
    out.push({ id: f.id as string, name: f.name, source: f.source === 'put' ? 'put' : 'picked' })
  }
  return out
}

export interface TasksDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  now?: () => number
  timeoutMs?: number
  /** Tag suggestions through the company's key; absent → the app's own matching only. */
  tagSuggest?: TagSuggestDeps
  /**
   * Google Picker for 「Google Drive のファイルをつなぐ」 (the Google connection's flow, composed in
   * main.ts): the files the member picked, kept by the server as their picks. Absent → not offered.
   * `fileIds`: Drive ids (already checked) the Picker shows first. `signal`: the card's ［やめる］ (the ticket is closed).
   * `notUsable`: picked files the server did not keep, in one sentence (how many, why). `ended`: nothing chosen —
   * cancelled or timed out (anything else is a failure with its message).
   */
  pickDriveFiles?: (companyId: string, fileIds: string[], signal?: AbortSignal) => Promise<
    | { ok: true; files: Array<{ id: string; name: string }>; notUsable?: string }
    | { ok: false; ended: 'cancelled' | 'timed-out' | null; message: string }>
  /**
   * The member's own Drive files to offer before the Picker (the Google connection's, composed in
   * main.ts): their live picks and the files their AI put, names included (their own). Absent → none.
   */
  driveChoices?: (companyId: string) => Promise<TaskDriveChoice[]>
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

/** 「似ているやることがあります」: the server's `similar` (checked) added to a success, when it named one. */
function withSimilar<T extends { success: true }>(result: T, answer: Answer): T & { similar?: SimilarItem } {
  const similar = similarOf(answer?.json?.data)
  return similar ? { ...result, similar } : result
}

export function createTasksApi(deps: TasksDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console
  const now = deps.now ?? Date.now
  /** `<company>:<record>@<version>` → its まとまり: a record's links change only with its version. */
  const bundleCache = new Map<string, { id: string; title: string } | null>()
  /** The signed-in member's id per session (cookies), from /api/me. */
  let me: { cookies: string; id: string } | null = null
  /** Google's chooser open for 「Google Drive のファイルをつなぐ」, per company: what the card's ［やめる］ stops. */
  const picking = new Map<string, AbortController>()

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

    /**
     * A file of the member's PC or a Drive file taken off a task (a company without the shared
     * folder; records.md "Drive and PC file links"). Main sends only a working-folder
     * path (`fileLinkPath`) or a Drive id.
     */
    async unlinkTarget(companyId: string, recordId: string, target: TypedFileTarget, expectedVersion: number): Promise<TaskWriteResult> {
      const t = typedTarget(target)
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !t || !Number.isInteger(expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/file-links/remove`, { target: t, expectedVersion })
      if (a?.status !== 200) return failure('unlink typed file', a)
      const entry = (a.json?.data as { entry?: { version?: unknown } | null } | undefined)?.entry
      return { success: true, recordId, ...(typeof entry?.version === 'number' ? { entryVersion: entry.version } : {}) }
    },

    /**
     * 「Google Drive のファイルをつなぐ」: the member picks files in Google Picker (the Google
     * connection's own flow, `pickDriveFiles`), then each is linked to the task at the version the
     * previous link moved it to. The server checks each pick with the member's own permission.
     * `fileIds` (a pasted / dropped Drive link): only Drive ids go on to the Picker, to show first;
     * nothing is linked that the member did not pick there.
     */
    async linkDriveFiles(companyId: string, recordId: string, expectedVersion: number, options?: unknown): Promise<TaskDriveLinkResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !Number.isInteger(expectedVersion)) return BAD_INPUT
      // `{ chosen }`: files the member ticked in the app's own list (their picks and puts) — no Picker; the
      // server checks each again. `{ fileIds }` (or the bare array an unreleased build sent): a pasted link's
      // files the Picker shows first.
      const o: { fileIds?: unknown; chosen?: unknown } = Array.isArray(options) ? { fileIds: options } : options && typeof options === 'object' ? options : {}
      let listed = o.chosen === undefined ? null : driveChoicesOf(o.chosen)
      if (o.chosen !== undefined && !listed) return BAD_INPUT
      const pasted = drivePreselectIds(o.fileIds)
      // A pasted link to a file that is already the member's own (a live pick or what their AI put): linked straight
      // away, no Picker (owner FB 2026-11-14). The server checks each again (`linkable`).
      if (!listed && pasted.length > 0 && deps.driveChoices) {
        let own: TaskDriveChoice[] = []
        try { own = driveChoicesOf(await deps.driveChoices(companyId)) ?? [] } catch { /* unknown: the Picker */ }
        const known = pasted.map(id => own.find(f => f.id === id))
        if (known.every(f => f !== undefined)) listed = known as TaskDriveChoice[]
      }
      if (!listed && !deps.pickDriveFiles) return { success: false, offline: false, error: 'この画面からは Google Drive を使えません。' }
      let picked: Awaited<ReturnType<NonNullable<TasksDeps['pickDriveFiles']>>>
      if (listed) picked = { ok: true, files: listed }
      else {
        // One chooser per company at a time; the card's ［やめる］ aborts it (`cancelDrivePick`).
        picking.get(companyId)?.abort()
        const stop = new AbortController()
        picking.set(companyId, stop)
        try {
          picked = await deps.pickDriveFiles!(companyId, pasted, stop.signal)
        } finally {
          if (picking.get(companyId) === stop) picking.delete(companyId)
        }
      }
      if (!picked.ok) return picked.ended ? { success: true, recordId, linked: [], ended: picked.ended } : { success: false, offline: false, error: picked.message }
      const notUsable = picked.notUsable ? { notUsable: picked.notUsable } : {}
      let at = expectedVersion
      const linked: string[] = []
      for (const f of picked.files) {
        if (!driveLinkTarget(f.id)) continue
        const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/file-links`, { target: { kind: 'drive', fileId: f.id }, expectedVersion: at })
        if (a?.status !== 200) {
          const f2 = failure('link drive file', a)
          return linked.length > 0 ? { success: true, recordId, linked, error: f2.error, ...notUsable } : f2
        }
        const data = a.json?.data as { entry?: { version?: unknown } | null } | undefined
        if (typeof data?.entry?.version === 'number') at = data.entry.version
        linked.push(f.name)
      }
      return { success: true, recordId, linked, ...notUsable }
    },

    /** The card's ［やめる］ while Google's chooser is open: stops waiting and closes the pick ticket (nothing is linked). */
    cancelDrivePick(companyId: string): { stopped: boolean } {
      const stop = COMPANY.test(companyId) ? picking.get(companyId) : undefined
      if (!stop) return { stopped: false }
      stop.abort()
      picking.delete(companyId)
      return { stopped: true }
    },

    /** The member's own Drive files offered before the Picker (empty when none or unknown: the Picker then opens). */
    async driveChoices(companyId: string): Promise<TaskDriveChoice[]> {
      if (!COMPANY.test(companyId) || !deps.driveChoices) return []
      try { return driveChoicesOf(await deps.driveChoices(companyId)) ?? [] } catch { return [] }
    },

    async share(companyId: string, recordId: string, folder: string, expectedVersion: number): Promise<TaskWriteResult> {
      const path = typeof folder === 'string' ? fileLinkPath(folder.normalize('NFC')) : null
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !path || !Number.isInteger(expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/share`, { folder: path, expectedVersion })
      return a?.status === 200 ? withSimilar({ success: true, recordId }, a) : failure('share', a)
    },

    /** ［〇〇の人に見せる］: `toBundle` — the server takes the place of the 案件 the task links to. */
    async shareToBundle(companyId: string, recordId: string, expectedVersion: number): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !Number.isInteger(expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/share`, { toBundle: true, expectedVersion })
      return a?.status === 200 ? withSimilar({ success: true, recordId }, a) : failure('share to bundle', a)
    },

    /**
     * 「非公開にする」 (records.md "Making a 案件・プロジェクト private"): the 案件 into `folder`, the private folder the
     * renderer has just made for it. Main sends only a company path; the server decides the rest.
     */
    async makeBundlePrivate(companyId: string, recordId: string, folder: string, expectedVersion: number): Promise<TaskWriteResult> {
      const path = typeof folder === 'string' ? fileLinkPath(folder.normalize('NFC')) : null
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId) || !path || !Number.isInteger(expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/make-private`, { folder: path, expectedVersion })
      if (a?.status === 200) return { success: true, recordId }
      // A code only with the server's own refusal (4xx): the app takes back what it did only then.
      const f = failure('make bundle private', a)
      return a && a.status >= 400 && a.status < 500 ? f : { ...f, code: null }
    },

    /** The server's plan for 「非公開にする」, asked again right before anything is made; a malformed answer is a failure. */
    async makeBundlePrivatePlan(companyId: string, recordId: string): Promise<MakePrivatePlanResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      const [a, names] = await Promise.all([call(companyId, 'GET', `/records/item/${encodeURIComponent(recordId)}/make-private`), people(companyId)])
      if (a?.status !== 200) { const f = failure('make bundle private plan', a); return { success: false, offline: f.offline, error: f.error } }
      const offer = makePrivateOfferOf(a.json?.data, names)
      return offer ? { success: true, offer } : { success: false, offline: false, error: 'できませんでした。' }
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
      // A file of the member's own working folder (a company without the shared folder): theirs alone.
      const local = dropped?.kind === 'path' && dropped.local === true
      const a = path
        ? await call(companyId, 'POST', `/records/item/${encodeURIComponent(targetId)}/file-links`,
          local ? { target: { kind: 'local', path }, link: pick.link, expectedVersion: target.version } : { path, link: pick.link, expectedVersion: target.version })
        : await call(companyId, 'POST', `/records/item/${encodeURIComponent(source.id)}/record-links`,
          { link: pick.link, target: pick.source === 'target' ? other!.id : target.id, expectedVersion: source.version })
      if (a?.status !== 200 && a?.status !== 201) {
        const f = failure('drop link', a)
        return { success: false, offline: f.offline, error: f.error }
      }
      const data = a.json?.data as { entry?: { version?: unknown } | null; changed?: unknown } | undefined
      if (data?.changed === false) return { success: true, done: { text: `「${name}」はもうつながっています`, undo: null } }
      const version = data?.entry?.version
      const said = local ? `「${name}」をつなぎました（あなただけに見えます）` : `「${name}」をつなぎました`
      return { success: true, done: { text: said, undo: typeof version === 'number' ? { recordId: source.id, version } : null } }
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
      // 「使う機能」 rides on the types answer; an older server sends none = everything on.
      const features = featuresFrom(types?.status === 200 ? (types.json?.data as { features?: unknown } | undefined)?.features : null)
      // 決めたこと waiting for the member's ［そうです］ (the small list 「確かめること」), only while 決めたこと is on.
      const toConfirm = features.decisions
        ? records(await call(companyId, 'POST', '/records/query', { type: 'decision', state: ['unconfirmed'], fields: { owner: id }, limit: 50 })) ?? []
        : []
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
          features,
          decisionsToConfirm: toConfirm.map(r => ({ id: r.id, title: r.title || '（名前なし）' })),
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
      if (input.meetingId != null && (typeof input.meetingId !== 'string' || !RECORD_ID_RE.test(input.meetingId))) return BAD_INPUT
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
      const meetingId = input.meetingId ?? null
      const links = { ...(input.bundleId ? { bundle: input.bundleId } : {}), ...(meetingId ? { meeting: meetingId } : {}) }
      const body = {
        type: 'task', title, fields,
        // For a 案件・プロジェクト the server gives it that 案件's 見える範囲 (records.md "A task and its
        // 案件・プロジェクト"), and from a meeting the meeting's (its people): no folder of the screen's then,
        // and never owner-only from a meeting (its people work on it together).
        ...(meetingId ? {} : asking ? (folder && !input.bundleId ? { folder } : {}) : { personal: true }),
        ...(Object.keys(links).length > 0 ? { links } : {}),
      }
      const a = await call(companyId, 'POST', '/records/item', body)
      const record = (a?.json?.data as { record?: { id?: unknown; state?: unknown } } | undefined)?.record
      if (a?.status === 201 && typeof record?.id === 'string') {
        return withSimilar({ success: true, recordId: record.id, ...(typeof record.state === 'string' ? { state: record.state } : {}) }, a)
      }
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
  ipc.handle('tasks:unlinkTarget', (_event, companyId, recordId, target, expectedVersion) =>
    api.unlinkTarget(typeof companyId === 'string' ? companyId : '', recordId, target, expectedVersion))
  ipc.handle('tasks:linkDriveFiles', (_event, companyId, recordId, expectedVersion, options) =>
    api.linkDriveFiles(typeof companyId === 'string' ? companyId : '', recordId, expectedVersion, options))
  ipc.handle('tasks:driveChoices', (_event, companyId) => api.driveChoices(typeof companyId === 'string' ? companyId : ''))
  ipc.handle('tasks:cancelDrivePick', (_event, companyId) => api.cancelDrivePick(typeof companyId === 'string' ? companyId : ''))
  ipc.handle('tasks:share', (_event, companyId, recordId, folder, expectedVersion) =>
    api.share(typeof companyId === 'string' ? companyId : '', recordId, folder, expectedVersion))
  ipc.handle('tasks:shareToBundle', (_event, companyId, recordId, expectedVersion) =>
    api.shareToBundle(typeof companyId === 'string' ? companyId : '', recordId, expectedVersion))
  ipc.handle('tasks:makeBundlePrivate', (_event, companyId, recordId, folder, expectedVersion) =>
    api.makeBundlePrivate(typeof companyId === 'string' ? companyId : '', recordId, folder, expectedVersion))
  ipc.handle('tasks:makeBundlePrivatePlan', (_event, companyId, recordId) =>
    api.makeBundlePrivatePlan(typeof companyId === 'string' ? companyId : '', recordId))
  ipc.handle('tasks:retryRun', (_event, companyId, runId) => api.retryRun(typeof companyId === 'string' ? companyId : '', runId))
  ipc.handle('tasks:createBundle', (_event, companyId, input) => api.createBundle(typeof companyId === 'string' ? companyId : '', input))
  ipc.handle('tasks:linkRecord', (_event, companyId, recordId, input) => api.linkRecord(typeof companyId === 'string' ? companyId : '', recordId, input, false))
  ipc.handle('tasks:unlinkRecord', (_event, companyId, recordId, input) => api.linkRecord(typeof companyId === 'string' ? companyId : '', recordId, input, true))
  ipc.handle('tasks:dropLink', (_event, companyId, targetId, dropped, link) => api.dropLink(typeof companyId === 'string' ? companyId : '', targetId, dropped, link))
  ipc.handle('tasks:undo', (_event, companyId, recordId, version, expectedVersion) => api.undo(typeof companyId === 'string' ? companyId : '', recordId, version, expectedVersion))
  ipc.handle('tasks:reconcile', (_event, companyId, runId, key, done) => api.reconcile(typeof companyId === 'string' ? companyId : '', runId, key, done))
}
