// 「やることにつなぐ…」 (records.md "Linking files later"): main lists the member's
// open tasks and links a company file to the one they chose, with the member's
// session (which stays here). The server decides who may link what; this only
// asks and turns its answer into a plain-Japanese line.

import type { LinkFileResult, OpenTasksResult, TaskChoice } from '../../../shared/task-links'
import { TASK_PEOPLE_FIELDS, TASKS_OFF_TEXT, TASKS_OFFLINE_TEXT, linkedMessage } from '../../../shared/task-links'

export interface TaskLinksDeps {
  baseUrl: () => string
  cookies: () => string[]
  userId: () => string | null
  fetch?: typeof fetch
  timeoutMs?: number
}

const COMPANY = /^[A-Za-z0-9_-]{1,100}$/
const TASK = /^task-[0-9a-z]{6,32}$/
const INVALID = '入力が正しくありません。'

type Answer = { status: number; body: { data?: unknown; error?: unknown; code?: unknown; version?: unknown } | null }

/** A server sentence for the member (Japanese), else a plain fallback. */
function memberText(body: Answer['body'], fallback: string): string {
  const error = body?.error
  return typeof error === 'string' && /[぀-ヿ一-鿿]/.test(error) ? error : fallback
}

function choiceOf(r: unknown): TaskChoice | null {
  const x = r as { id?: unknown; title?: unknown; state?: unknown; version?: unknown; fields?: Record<string, unknown> } | null
  if (!x || typeof x.id !== 'string' || !TASK.test(x.id) || typeof x.title !== 'string' || typeof x.version !== 'number') return null
  const due = x.fields?.due
  return { id: x.id, title: x.title.slice(0, 200), state: typeof x.state === 'string' ? x.state : null, due: typeof due === 'string' ? due : null, version: x.version }
}

export function createTaskLinks(deps: TaskLinksDeps) {
  const doFetch = deps.fetch ?? fetch

  async function call(companyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json().catch(() => null) as Answer['body'] }
    } catch {
      return null
    }
  }

  return {
    /** The member's open tasks: they request it, do it, review it, or it is their turn. */
    async openTasks(companyId: string): Promise<OpenTasksResult> {
      const me = deps.userId()
      if (!COMPANY.test(companyId) || !me) return { success: false, error: INVALID }
      const types = await call(companyId, 'GET', '/records/types')
      if (!types) return { success: false, error: TASKS_OFFLINE_TEXT }
      if (types.status === 404) return { success: false, error: TASKS_OFF_TEXT }
      const task = ((types.body?.data as { types?: Array<{ definition?: { name?: unknown; states?: unknown; final?: unknown } }> } | undefined)?.types ?? [])
        .map(t => t.definition).find(d => d?.name === 'task')
      if (!task || !Array.isArray(task.states)) return { success: false, error: TASKS_OFF_TEXT }
      const final = Array.isArray(task.final) ? task.final as string[] : []
      const open = (task.states as string[]).filter(s => !final.includes(s))
      const answers = await Promise.all(TASK_PEOPLE_FIELDS.map(field =>
        call(companyId, 'POST', '/records/query', { type: 'task', state: open, fields: { [field]: me }, limit: 200 })))
      if (answers.some(a => a === null)) return { success: false, error: TASKS_OFFLINE_TEXT }
      const byId = new Map<string, TaskChoice>()
      for (const a of answers) {
        if (!a || a.status >= 300) return { success: false, error: memberText(a?.body ?? null, 'やることを読み込めませんでした。') }
        for (const r of (a.body?.data as { records?: unknown[] } | undefined)?.records ?? []) {
          const c = choiceOf(r)
          if (c) byId.set(c.id, c)
        }
      }
      return { success: true, tasks: [...byId.values()] }
    },

    /** Link `companyPath` to the task (again once at the server's version when someone changed it meanwhile). */
    async linkFile(companyId: string, taskId: string, companyPath: string, seenVersion: number): Promise<LinkFileResult> {
      if (!COMPANY.test(companyId) || !TASK.test(taskId) || companyPath.length === 0 || companyPath.length > 1000 || !Number.isInteger(seenVersion)) {
        return { success: false, error: INVALID }
      }
      const path = `/records/item/${encodeURIComponent(taskId)}/file-links`
      let r = await call(companyId, 'POST', path, { path: companyPath, expectedVersion: seenVersion })
      if (r && r.status === 409 && r.body?.code === 'VERSION_CONFLICT' && typeof r.body.version === 'number') {
        r = await call(companyId, 'POST', path, { path: companyPath, expectedVersion: r.body.version })
      }
      if (!r) return { success: false, error: TASKS_OFFLINE_TEXT }
      if (r.status >= 300) return { success: false, error: memberText(r.body, `つなげませんでした（サーバーの応答 ${r.status}）。`) }
      const data = r.body?.data as { record?: { title?: unknown }; changed?: unknown } | undefined
      const title = typeof data?.record?.title === 'string' ? data.record.title : 'やること'
      return { success: true, message: linkedMessage(companyPath, title, data?.changed === false) }
    },
  }
}

export type TaskLinks = ReturnType<typeof createTaskLinks>
