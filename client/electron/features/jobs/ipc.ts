// Settings → 「定期の仕事」 (jobs.md "The screens", PR 4): the scheduled jobs the member is responsible for,
// read and changed with the member's **session** (the server decides who may accept, pause, resume).
//   jobs:mine     the member's jobs: what waits for their 「受け取る」, whether they run it
//   jobs:accept   accept the version shown (its fingerprint: the server refuses another)
//   jobs:pause    pause a job they run
//   jobs:resume   resume a pause they made

import { JOBS_OFFLINE_TEXT, type JobActionResult, type JobsFailure, type MyJob, type MyJobsResult } from '../../../shared/jobs'
import { isJobId } from '../../../../shared/core/jobs'
import type { JobView } from '../../../../shared/types/jobs'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface JobsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

/** A company id that goes into the server URL: no separators, dots or encoded characters. */
const COMPANY_ID = /^[A-Za-z0-9_-]{1,100}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const BAD_INPUT: JobsFailure = { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
const OFFLINE: JobsFailure = { success: false, offline: true, code: null, error: JOBS_OFFLINE_TEXT }
/** At most this many jobs are read in detail per look (a member is responsible for a handful). */
const MAX_DETAILS = 50

type Answer = { status: number; json: Record<string, unknown> | null }

export function createJobsApi(deps: JobsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        headers: { Cookie: cookies.join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
    } catch {
      return null
    }
  }

  function failure(what: string, r: Answer | null): JobsFailure {
    if (!r) {
      log.warn(`[jobs] ${what}: the server could not be reached`)
      return OFFLINE
    }
    const code = typeof r.json?.code === 'string' ? r.json.code : null
    log.warn(`[jobs] ${what}: answered ${r.status}${code ? ` ${code}` : ''}`)
    return {
      success: false, offline: r.status >= 500, code,
      error: typeof r.json?.error === 'string' && r.status < 500 ? r.json.error : `サーバーでエラーが起きました（HTTP ${r.status}）。`,
    }
  }

  const ok = (r: Answer | null): r is Answer => !!r && r.status >= 200 && r.status < 300 && !!r.json?.data && typeof r.json.data === 'object'
  const company = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`

  /** The job as this member sees it, or null when it is not theirs (an owner / admin lists every job). */
  function mine(detail: JobView, me: string): MyJob | null {
    const approved = detail.versions?.find(v => v.version === detail.approvedVersion) ?? null
    const runsIt = approved?.definition?.actingUser === me
    if (!runsIt && detail.actingUserId !== me) return null
    const waitsForMe = runsIt && approved !== null && !detail.accepted && detail.state !== 'retired'
    return {
      id: detail.id, name: detail.name, state: detail.state, waiting: detail.waiting, pausedReason: detail.pausedReason,
      trigger: detail.trigger ?? null, nextSlot: detail.nextSlot ?? null,
      toAccept: waitsForMe ? { version: approved.version, fingerprint: approved.fingerprint, definition: approved.definition } : null,
      controls: runsIt,
    }
  }

  async function act(what: string, companyId: unknown, jobId: unknown, path: (id: string) => string, body?: unknown): Promise<JobActionResult> {
    if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId) || !isJobId(jobId)) return BAD_INPUT
    const r = await call(`${company(companyId)}${path(jobId)}`, 'POST', body)
    if (!ok(r)) return failure(what, r)
    return { success: true }
  }

  return {
    async mine(companyId: unknown): Promise<MyJobsResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId)) return BAD_INPUT
      const [me, list] = await Promise.all([call('/me', 'GET'), call(`${company(companyId)}/jobs`, 'GET')])
      const meId = me && me.status === 200 && typeof (me.json?.data as { id?: unknown } | undefined)?.id === 'string' ? (me.json!.data as { id: string }).id : null
      if (!meId) return failure('me', me)
      if (!ok(list)) return failure('list', list)
      const views = (list.json!.data as { jobs?: unknown }).jobs
      const candidates = (Array.isArray(views) ? views as JobView[] : [])
        .filter(j => isJobId(j?.id) && j.state !== 'retired')
        .slice(0, MAX_DETAILS)
      const out: MyJob[] = []
      for (const j of candidates) {
        const d = await call(`${company(companyId)}/jobs/${j.id}`, 'GET')
        if (!ok(d)) continue
        const job = mine(d.json!.data as JobView, meId)
        if (job) out.push(job)
      }
      return { success: true, jobs: out }
    },
    accept(companyId: unknown, jobId: unknown, version: unknown, fingerprint: unknown): Promise<JobActionResult> {
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return Promise.resolve(BAD_INPUT)
      if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return Promise.resolve(BAD_INPUT)
      return act('accept', companyId, jobId, id => `/me/jobs/${id}/accept`, { version, fingerprint })
    },
    pause: (companyId: unknown, jobId: unknown) => act('pause', companyId, jobId, id => `/jobs/${id}/pause`),
    resume: (companyId: unknown, jobId: unknown) => act('resume', companyId, jobId, id => `/jobs/${id}/resume`),
  }
}

export function registerJobsIpc(ipc: IpcRegistrar, deps: JobsDeps) {
  const api = createJobsApi(deps)
  ipc.handle('jobs:mine', (_event, companyId) => api.mine(companyId))
  ipc.handle('jobs:accept', (_event, companyId, jobId, version, fingerprint) => api.accept(companyId, jobId, version, fingerprint))
  ipc.handle('jobs:pause', (_event, companyId, jobId) => api.pause(companyId, jobId))
  ipc.handle('jobs:resume', (_event, companyId, jobId) => api.resume(companyId, jobId))
}
