// The task list (やることの一覧, stage 2 S7b, .claude/rules/tasks-ui.md), with the member's
// session (it stays here):
//   tasks:list    what waits for the member, the AI, others, and today's done — sorted by
//                 client/shared/tasks.ts from the server's answers (nothing filtered here)
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
//   tasks:retryRun / tasks:reconcile   a run held for a person: 「もう一度」, or what the member
//                 found in the outside system about an operation whose result was unknown
// The server answers only what the member may read; main adds nothing to it.

import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'
import { fileLinkPath, RECORD_ID_RE } from '../../../../shared/core/records'
import { isDateValue, normalizeTagsValue } from '../../../../shared/core/record-types'
import type { BundleKindsResult, RecordDetail, RecordQueryResult, RecordSummary, RecordTypeView } from '../../../../shared/types/records'
import type { LedgerEntry } from '../../../../shared/core/record-ledger'
import type { TypeDefinition } from '../../../../shared/core/record-types'
import type { AiRunView } from '../../../../shared/types/ai-runs'
import type { MyWorkSwitches } from '../../../../shared/types/work-switches'
import type { MeetingBundleQuestions } from '../../../../shared/types/minutes'
import { taskCardOf, type TaskCardResult } from '../../../shared/task-card'
import { OPERATION_KEY_RE } from '../../../../shared/core/ai-runs'
import {
  classifyTasks, OPEN_TASK_STATES, TASKS_OFFLINE_TEXT,
  type BundleChoicesResult, type TaskActInput, type TaskCreateInput, type TaskListResult, type TaskProposalsResult, type TaskWriteResult,
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
      const [me, item, history, defs, names, runs, switches] = await Promise.all([
        myId(), call(companyId, 'GET', `/records/item/${id}`), call(companyId, 'GET', `/records/item/${id}/history`),
        typeDefs(companyId), people(companyId), call(companyId, 'GET', '/ai-runs'), call(companyId, 'GET', '/me/work-switches'),
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
      return { success: true, card: taskCardOf({ me, detail, def: defs.get(detail.record.type), defs, entries, people: names, runs: runList, teamMode }) }
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
      const [a, names] = await Promise.all([
        call(companyId, 'POST', '/records/query', { type: 'task', state: ['proposed', 'dismissed'], link: { name: 'meeting', id: meetingId }, limit: 200 }),
        people(companyId),
      ])
      const list = records(a)
      if (!list) {
        const f = failure('proposals', a)
        return { success: false, offline: f.offline, error: f.error }
      }
      const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
      return {
        success: true,
        proposals: list.filter(r => r.state === 'proposed' || r.state === 'dismissed').map(r => {
          const assignee = str(r.fields.assignee)
          return {
            id: r.id, title: r.title || '（名前なし）', state: r.state as 'proposed' | 'dismissed', version: r.version,
            assignee, assigneeName: assignee ? names[assignee] ?? null : null, due: str(r.fields.due),
          }
        }),
      }
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

    async undo(companyId: string, recordId: string, version: number, expectedVersion: number): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      if (!Number.isInteger(version) || version < 2 || !Number.isInteger(expectedVersion) || expectedVersion < version) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/undo`, { version, expectedVersion })
      return a?.status === 200 || a?.status === 201 ? { success: true, recordId } : failure('undo', a)
    },

    async linkRecord(companyId: string, recordId: string, input: { link: string; target: string; expectedVersion: number }, remove: boolean): Promise<TaskWriteResult> {
      if (!COMPANY.test(companyId) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      if (!input || typeof input.link !== 'string' || !ACTION.test(input.link) || typeof input.target !== 'string' || !RECORD_ID_RE.test(input.target) || !Number.isInteger(input.expectedVersion)) return BAD_INPUT
      const a = await call(companyId, 'POST', `/records/item/${encodeURIComponent(recordId)}/record-links${remove ? '/remove' : ''}`,
        { link: input.link, target: input.target, expectedVersion: input.expectedVersion })
      if (a?.status !== 200 && a?.status !== 201) return failure(remove ? 'unlink record' : 'link record', a)
      const entry = (a.json?.data as { entry?: { version?: unknown } | null } | undefined)?.entry
      return { success: true, recordId, ...(typeof entry?.version === 'number' ? { entryVersion: entry.version } : {}) }
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
      const [myTurn, aiTurn, asked, doneMine, doneAsked, types, names, settings, questions, kinds] = await Promise.all([
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
      const doneToday = [...done1, ...done2]
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
          }),
        },
      }
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
        ...(asking ? (folder ? { folder } : {}) : { personal: true }),
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
  ipc.handle('tasks:create', (_event, companyId, input) => api.create(typeof companyId === 'string' ? companyId : '', input))
  ipc.handle('tasks:act', (_event, companyId, recordId, input) => api.act(typeof companyId === 'string' ? companyId : '', recordId, input))
  ipc.handle('tasks:card', (_event, companyId, recordId) => api.card(typeof companyId === 'string' ? companyId : '', recordId))
  ipc.handle('tasks:bundles', (_event, companyId) => api.bundles(typeof companyId === 'string' ? companyId : ''))
  ipc.handle('tasks:proposals', (_event, companyId, meetingId) => api.proposals(typeof companyId === 'string' ? companyId : '', meetingId))
  ipc.handle('tasks:linkFile', (_event, companyId, recordId, companyPath, expectedVersion) =>
    api.linkFile(typeof companyId === 'string' ? companyId : '', recordId, companyPath, expectedVersion, false))
  ipc.handle('tasks:unlinkFile', (_event, companyId, recordId, companyPath, expectedVersion) =>
    api.linkFile(typeof companyId === 'string' ? companyId : '', recordId, companyPath, expectedVersion, true))
  ipc.handle('tasks:share', (_event, companyId, recordId, folder, expectedVersion) =>
    api.share(typeof companyId === 'string' ? companyId : '', recordId, folder, expectedVersion))
  ipc.handle('tasks:retryRun', (_event, companyId, runId) => api.retryRun(typeof companyId === 'string' ? companyId : '', runId))
  ipc.handle('tasks:linkRecord', (_event, companyId, recordId, input) => api.linkRecord(typeof companyId === 'string' ? companyId : '', recordId, input, false))
  ipc.handle('tasks:unlinkRecord', (_event, companyId, recordId, input) => api.linkRecord(typeof companyId === 'string' ? companyId : '', recordId, input, true))
  ipc.handle('tasks:undo', (_event, companyId, recordId, version, expectedVersion) => api.undo(typeof companyId === 'string' ? companyId : '', recordId, version, expectedVersion))
  ipc.handle('tasks:reconcile', (_event, companyId, runId, key, done) => api.reconcile(typeof companyId === 'string' ? companyId : '', runId, key, done))
}
