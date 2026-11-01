// The task list (やることの一覧, stage 2 S7b, .claude/rules/tasks-ui.md), with the member's
// session (it stays here):
//   tasks:list    what waits for the member, the AI, others, and today's done — sorted by
//                 client/shared/tasks.ts from the server's answers (nothing filtered here)
//   tasks:create  the list's one line: a task of the member's own (owner-only)
//   tasks:act     an action on a record (引き受ける, 完了…): the server's engine decides who may
// The server answers only what the member may read; main adds nothing to it.

import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../../../shared/core/calendar'
import { RECORD_ID_RE } from '../../../../shared/core/records'
import { isDateValue, normalizeTagsValue } from '../../../../shared/core/record-types'
import type { RecordDetail, RecordQueryResult, RecordSummary, RecordTypeView } from '../../../../shared/types/records'
import {
  classifyTasks, OPEN_TASK_STATES, TASKS_OFFLINE_TEXT,
  type TaskActInput, type TaskCreateInput, type TaskListResult, type TaskWriteResult,
} from '../../../shared/tasks'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface TasksDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  now?: () => number
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const ACTION = /^[a-z][a-z0-9_]{0,39}$/
const MEMBER = /^[A-Za-z0-9_-]{1,100}$/
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
    const todo = list.filter(r => r.type === 'task').slice(0, BUNDLE_LOOKUPS)
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

  return {
    async list(companyId: string): Promise<TaskListResult> {
      if (!COMPANY.test(companyId)) return { success: false, offline: false, error: '入力が正しくありません。' }
      const id = await myId()
      if (!id) return { success: false, offline: true, error: TASKS_OFFLINE_TEXT }
      const since = new Date(dayWindow(now(), DEFAULT_COMPANY_TIME_ZONE).from).toISOString()
      const [myTurn, aiTurn, asked, doneMine, doneAsked, types, names, settings] = await Promise.all([
        call(companyId, 'GET', '/records/my-turn'),
        call(companyId, 'GET', '/records/ai-turn'),
        call(companyId, 'POST', '/records/query', { type: 'task', state: [...OPEN_TASK_STATES], fields: { requested_by: id }, limit: 200 }),
        call(companyId, 'POST', '/records/query', { type: 'task', finishedSince: since, fields: { assignee: id }, limit: 100 }),
        call(companyId, 'POST', '/records/query', { type: 'task', finishedSince: since, fields: { requested_by: id }, limit: 100 }),
        call(companyId, 'GET', '/records/types'),
        people(companyId),
        call(companyId, 'GET', '/task-settings'),
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
      for (const t of (types?.status === 200 ? (types.json?.data as { types?: RecordTypeView[] }).types ?? [] : [])) typeLabels[t.definition.name] = t.definition.label
      const ids = (settings?.status === 200 ? (settings.json?.data as { settings?: { taskListDepartmentIds?: unknown } }).settings?.taskListDepartmentIds : null)
      const doneToday = [...done1, ...done2]
      const all = [...mine, ...ai, ...askedList, ...doneToday]
      return {
        success: true,
        data: {
          available: true,
          listDepartmentIds: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null,
          items: classifyTasks({ me: id, myTurn: mine, aiTurn: ai, asked: askedList, doneToday, typeLabels, people: names, bundles: await bundles(companyId, all) }),
        },
      }
    },

    async create(companyId: string, input: TaskCreateInput): Promise<TaskWriteResult> {
      const title = typeof input?.title === 'string' ? input.title.normalize('NFC').trim() : ''
      if (!COMPANY.test(companyId) || !title || title.length > 200) return BAD_INPUT
      if (input.due != null && (typeof input.due !== 'string' || !isDateValue(input.due))) return BAD_INPUT
      const tags = input.tags && input.tags.length > 0 ? normalizeTagsValue(input.tags) : null
      if (tags !== null && typeof tags !== 'string') return BAD_INPUT
      const id = await myId()
      if (!id) return { success: false, offline: true, code: null, error: TASKS_OFFLINE_TEXT }
      const fields: Record<string, unknown> = { assignee: id }
      if (input.due) fields.due = input.due
      if (tags) fields.tags = JSON.parse(tags) as string[]
      const a = await call(companyId, 'POST', '/records/item', { type: 'task', title, personal: true, fields })
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
  ipc.handle('tasks:list', (_event, companyId) => api.list(typeof companyId === 'string' ? companyId : ''))
  ipc.handle('tasks:create', (_event, companyId, input) => api.create(typeof companyId === 'string' ? companyId : '', input))
  ipc.handle('tasks:act', (_event, companyId, recordId, input) => api.act(typeof companyId === 'string' ? companyId : '', recordId, input))
}
