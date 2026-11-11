// Settings → 「定期の仕事」 (jobs.md "The screens", PR 4): the scheduled jobs the member is responsible for,
// read and changed with the member's **session** (the server decides who may accept, pause, resume).
//   jobs:mine     the member's jobs: what waits for their 「受け取る」, whether they run it
//   jobs:accept   accept the version shown (its fingerprint: the server refuses another); a version that puts its
//                 deliverables into a place outside first asks the member to choose that place (a Drive folder in
//                 Google Picker: `choosePlace`, composed in main.ts — this module never names a connector)
//   jobs:pause    pause a job they run
//   jobs:resume   resume a pause they made

import { JOBS_OFFLINE_TEXT, JOBS_SERVER_TOO_OLD_TEXT, type JobActionResult, type JobsFailure, type MyJob, type MyJobsResult } from '../../../shared/jobs'
import { isJobId, type JobDeliveryPlace } from '../../../../shared/core/jobs'
import type { JobView } from '../../../../shared/types/jobs'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface JobsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
  /**
   * The member chooses the exact place of this connector and kind (their own pick, e.g. a Drive folder in Google
   * Picker): its id, or why not (cancelled, not available). Absent: no place can be chosen in this app.
   */
  choosePlace?: (companyId: string, place: Pick<JobDeliveryPlace, 'connector' | 'kind'>) => Promise<{ ok: true; ref: string } | { ok: false; message: string }>
}

/** A company id that goes into the server URL: no separators, dots or encoded characters. */
const COMPANY_ID = /^[A-Za-z0-9_-]{1,100}$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/
const BAD_INPUT: JobsFailure = { success: false, offline: false, code: 'BAD_REQUEST', error: '入力が正しくありません。' }
const OFFLINE: JobsFailure = { success: false, offline: true, code: null, error: JOBS_OFFLINE_TEXT }
/** At most this many jobs waiting for the member's acceptance are read in detail per look (a handful in practice). */
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

  /**
   * The job as this member sees it, or null when it is not theirs (an owner / admin lists every job). Who
   * they are to it is the server's answer (`you`), never re-derived from a definition, which may be hidden.
   */
  function mine(job: JobView): MyJob | null {
    if (!job.you?.named && !job.you?.controls && !job.you?.mustAccept) return null
    const d = job.deliverTo
    return {
      id: job.id, name: job.approved?.name ?? job.name, state: job.state, waiting: job.waiting, pausedReason: job.pausedReason,
      trigger: job.trigger ?? null, placement: job.placement ?? null, nextSlot: job.nextSlot ?? null, toAccept: null, controls: job.you.controls,
      deliverTo: d ? { label: d.label, chosen: d.chosen, usable: d.usable, name: d.name, expiresAt: d.expiresAt } : null,
    }
  }

  /** The member must choose the deliverable place again: accepted, still theirs to run, but the place no longer usable. */
  const placeLost = (view: JobView) => !view.you?.mustAccept && !!view.you?.controls && view.accepted && !!view.deliverTo && !view.deliverTo.usable

  /** What waits for the member's 「受け取る」: the approved version as the server shows it to them (its definition may be hidden). */
  function toAccept(detail: JobView, why: 'accept' | 'place'): MyJob['toAccept'] {
    const v = detail.versions?.find(x => x.version === detail.approvedVersion)
    return v ? { version: v.version, fingerprint: v.fingerprint, definition: v.definition, why } : null
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
      const list = await call(`${company(companyId)}/jobs`, 'GET')
      if (!ok(list)) return failure('list', list)
      const views = (list.json!.data as { jobs?: unknown }).jobs
      // A server before PR 4 answers no `you`: saying 「ありません」 would be a guess, so say what is missing.
      if (Array.isArray(views) && views.some(j => j && typeof j === 'object' && !('you' in j))) {
        return { success: false, offline: false, code: 'SERVER_TOO_OLD', error: JOBS_SERVER_TOO_OLD_TEXT }
      }
      // The member's own first (an owner / admin's list holds every job), then details only for what waits for them.
      const out = (Array.isArray(views) ? views as JobView[] : [])
        .filter(j => isJobId(j?.id) && j.state !== 'retired')
        .map(j => [j, mine(j)] as const)
        .filter((pair): pair is readonly [JobView, MyJob] => pair[1] !== null)
      let details = 0
      for (const [view, job] of out) {
        const why = view.you?.mustAccept ? 'accept' : placeLost(view) ? 'place' : null
        if (!why || details >= MAX_DETAILS) continue
        details += 1
        const d = await call(`${company(companyId)}/jobs/${view.id}`, 'GET')
        if (!ok(d)) return failure('detail', d)
        job.toAccept = toAccept(d.json!.data as JobView, why)
      }
      return { success: true, jobs: out.map(([, job]) => job) }
    },
    async accept(companyId: unknown, jobId: unknown, version: unknown, fingerprint: unknown): Promise<JobActionResult> {
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return BAD_INPUT
      if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return BAD_INPUT
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId) || !isJobId(jobId)) return BAD_INPUT
      // Whether the version puts into a place outside is the server's answer (never the renderer's): then the member
      // chooses it first (their own pick), and the acceptance carries it.
      const view = await call(`${company(companyId)}/jobs/${jobId}`, 'GET')
      if (!ok(view)) return failure('accept', view)
      const wanted = (view.json!.data as JobView).deliverTo
      let place: JobDeliveryPlace | null = null
      if (wanted) {
        if (!deps.choosePlace) return { success: false, offline: false, code: 'PLACE_NOT_CHOSEN', error: 'このアプリでは置き先を選べません。アプリを新しくしてください。' }
        const chosen = await deps.choosePlace(companyId, { connector: wanted.connector, kind: wanted.kind })
        if (!chosen.ok) return { success: false, offline: false, code: 'PLACE_NOT_CHOSEN', error: chosen.message }
        place = { connector: wanted.connector, kind: wanted.kind, ref: chosen.ref }
      }
      return act('accept', companyId, jobId, id => `/me/jobs/${id}/accept`, { version, fingerprint, ...(place ? { place } : {}) })
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
