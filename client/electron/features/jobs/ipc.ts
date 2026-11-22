// Settings → 「定期の仕事」 (jobs.md "The screens", PR 4): the scheduled jobs the member is responsible for,
// read and changed with the member's **session** (the server decides who may accept, pause, resume).
//   jobs:mine     the member's jobs: what waits for their 「受け取る」, whether they run it
//   jobs:accept   accept the version shown (its fingerprint: the server refuses another); a version that puts its
//                 deliverables into a place outside first asks the member to choose that place (a Drive folder in
//                 Google Picker: `choosePlace`, composed in main.ts — this module never names a connector)
//   jobs:pause    pause a job they run
//   jobs:resume   resume a pause they made
//   jobs:occurrences          the event occurrences this PC's AI ran for them (stage 4b-2, D11: `GET /me/job-occurrences`)
//   jobs:retryOccurrence      「もう一度」 on one of them (the server decides who may and when)
//   jobs:reconcileOccurrence  「後始末」: say whether an outside operation of its run was made (作られていた／作られていなかった)

import {
  APP_JOB_SCHEMAS, JOBS_OFFLINE_TEXT, JOBS_SERVER_TOO_OLD_TEXT, appReadsJobDefinition,
  type JobActionResult, type JobsFailure, type MyJob, type MyJobOccurrence, type MyJobOccurrencesResult, type MyJobsResult, type WatchChoicesResult,
} from '../../../shared/jobs'
import {
  JOB_ACCEPT_HEADER, JOB_ACCEPT_SEPARATE, JOB_OCCURRENCE_STATES, JOB_RETRY_BLOCKS, JOB_SCHEMAS_HEADER, isJobId, isOccurrenceId,
  type JobDeliveryPlace, type JobOccurrenceState, type JobRetryBlock,
} from '../../../../shared/core/jobs'
import { RECORD_ID_RE } from '../../../../shared/core/records'
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
/** The open states of a やること an event job may watch next (the server checks the record again). */
const WATCH_STATES = ['todo', 'in_progress', 'review', 'waiting', 'awaiting_acceptance', 'declined']
/** How many of them are offered at once (searched by name). */
const WATCH_CHOICES = 50

type Answer = { status: number; json: Record<string, unknown> | null }

/** An outside operation's key as the server's run core makes it (ids only: it goes into the reconcile's path). */
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,100}$/
const SHORT_KIND = /^[A-Za-z0-9._:-]{1,40}$/
/** At most this many occurrences are shown (the server answers ≤ 100). */
const MAX_OCCURRENCES = 100

/**
 * One occurrence of `GET /me/job-occurrences`, checked (stage 4b-2): ids and codes of the server's own vocabulary only; a
 * field of the wrong shape leaves that occurrence out, never guessed. Nothing is derived — the buttons follow `retry` and
 * `unknownOperations` exactly as the server answered them (it leaves them out where the member's rights do not reach).
 */
export function parseMyJobOccurrence(v: unknown): MyJobOccurrence | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!isOccurrenceId(o.id) || !isJobId(o.jobId) || typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 200) return null
  if (typeof o.dueSlot !== 'string' || o.dueSlot.length > 40) return null
  if (!(JOB_OCCURRENCE_STATES as readonly unknown[]).includes(o.state)) return null
  if (o.outcomeCode !== null && (typeof o.outcomeCode !== 'string' || !/^[A-Z_]{1,60}$/.test(o.outcomeCode))) return null
  let retry: MyJobOccurrence['retry'] = null
  if (o.retry !== undefined) {
    const r = (typeof o.retry === 'object' && o.retry !== null ? o.retry : {}) as Record<string, unknown>
    if (r.allowed === true) retry = { allowed: true }
    else if (r.allowed === false && (JOB_RETRY_BLOCKS as readonly unknown[]).includes(r.why)) retry = { allowed: false, why: r.why as JobRetryBlock }
    else return null
  }
  const list = (x: unknown) => (x === undefined ? [] : Array.isArray(x) && x.length <= 50 ? x as unknown[] : null)
  const unknownRaw = list(o.unknownOperations)
  const madeRaw = list(o.madeBefore)
  if (!unknownRaw || !madeRaw) return null
  const unknownOperations: MyJobOccurrence['unknownOperations'] = []
  for (const u of unknownRaw) {
    const x = (typeof u === 'object' && u !== null ? u : {}) as Record<string, unknown>
    if (typeof x.key !== 'string' || !OPERATION_KEY.test(x.key) || typeof x.kind !== 'string' || !SHORT_KIND.test(x.kind)) return null
    unknownOperations.push({ key: x.key, kind: x.kind })
  }
  const madeBefore: MyJobOccurrence['madeBefore'] = []
  for (const m of madeRaw) {
    const x = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>
    if (typeof x.kind !== 'string' || !SHORT_KIND.test(x.kind) || typeof x.count !== 'number' || !Number.isInteger(x.count) || x.count < 0) return null
    madeBefore.push({ kind: x.kind, count: x.count })
  }
  return {
    id: o.id, jobId: o.jobId, name: o.name, dueSlot: o.dueSlot, state: o.state as JobOccurrenceState,
    outcomeCode: (o.outcomeCode as string | null) ?? null, retry, unknownOperations, madeBefore,
  }
}

export function createJobsApi(deps: JobsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(path: string, method: 'GET' | 'POST', body?: unknown, root = ''): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '') + root
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        // The definition shapes this app shows (jobs.md "Shapes this build does not know"): since stage 4a, event jobs too;
        // what this app shows (`APP_JOB_SCHEMAS`, stage 4b-0.5), never what the shared parser reads.
        // Its 受け取る is always a press of its own, never an approval's (`JOB_ACCEPT_HEADER`; read on acceptance only).
        headers: {
          Cookie: cookies.join('; '), [JOB_SCHEMAS_HEADER]: APP_JOB_SCHEMAS.join(','), [JOB_ACCEPT_HEADER]: JOB_ACCEPT_SEPARATE,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
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
      chainStopped: job.chainStopped && typeof job.chainStopped.why === 'string' ? { why: job.chainStopped.why } : null,
      approvedVersion: typeof job.approvedVersion === 'number' ? job.approvedVersion : null,
    }
  }

  /** The member must choose the deliverable place again: accepted, still theirs to run, but the place no longer usable. */
  const placeLost = (view: JobView) => !view.you?.mustAccept && !!view.you?.controls && view.accepted && !!view.deliverTo && !view.deliverTo.usable

  /** What waits for the member's 「受け取る」: the approved version as the server shows it to them (its definition may be hidden). */
  function toAccept(detail: JobView, why: 'accept' | 'place'): MyJob['toAccept'] {
    const v = detail.versions?.find(x => x.version === detail.approvedVersion)
    // A shape this app does not show (a server that ignored the header) is shown as one it cannot show (stage 4b-0.5).
    return v ? { version: v.version, fingerprint: v.fingerprint, definition: appReadsJobDefinition(v.definition), why } : null
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
    /** The member's own open やること they may watch next (by name), as the server's reader lets them see. */
    async watchChoices(companyId: unknown, text: unknown): Promise<WatchChoicesResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId) || typeof text !== 'string' || text.length > 100) return BAD_INPUT
      const me = await call('/me', 'GET')
      const id = (me?.json?.data as { id?: unknown } | undefined)?.id
      if (!ok(me) || typeof id !== 'string') return failure('me', me)
      const q = await call(`${company(companyId)}/records/query`, 'POST', {
        type: 'task', state: WATCH_STATES, fields: { assignee: id }, limit: WATCH_CHOICES, ...(text.trim() ? { text: text.trim() } : {}),
      })
      if (!ok(q)) return failure('watch choices', q)
      const data = q.json!.data as { total?: unknown; records?: unknown }
      const records = Array.isArray(data.records) ? data.records as Array<{ id?: unknown; title?: unknown }> : []
      return {
        success: true, total: typeof data.total === 'number' ? data.total : records.length,
        choices: records.filter(r => typeof r.id === 'string' && RECORD_ID_RE.test(r.id) && typeof r.title === 'string').map(r => ({ id: r.id as string, title: r.title as string })),
      }
    },
    /** Watch this やること next (the server checks the member, the version and the record). */
    async rewatch(companyId: unknown, jobId: unknown, version: unknown, recordId: unknown): Promise<JobActionResult> {
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return BAD_INPUT
      if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return BAD_INPUT
      return act('rewatch', companyId, jobId, id => `/me/jobs/${id}/watch`, { version, recordId })
    },
    /**
     * The event occurrences this PC's AI ran for the member (stage 4b-2, D11): as the server answers them. A server
     * before 4b-1 (404) has none to show — said as not supported, never as an error.
     */
    async occurrences(companyId: unknown): Promise<MyJobOccurrencesResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId)) return BAD_INPUT
      const r = await call(`${company(companyId)}/me/job-occurrences`, 'GET')
      if (r && r.status === 404) return { success: true, supported: false, occurrences: [] }
      if (!ok(r)) return failure('occurrences', r)
      const list = (r.json!.data as { occurrences?: unknown }).occurrences
      const occurrences = (Array.isArray(list) ? list : []).slice(0, MAX_OCCURRENCES).map(parseMyJobOccurrence).filter((o): o is MyJobOccurrence => o !== null)
      return { success: true, supported: true, occurrences }
    },
    /** 「もう一度」 on an occurrence (the server checks who and when; its refusal's words are shown as they are). */
    async retryOccurrence(companyId: unknown, jobId: unknown, occurrenceId: unknown): Promise<JobActionResult> {
      if (!isOccurrenceId(occurrenceId)) return BAD_INPUT
      return act('retry occurrence', companyId, jobId, id => `/jobs/${id}/occurrences/${occurrenceId}/retry`)
    },
    /** 「後始末」: whether the run's outside operation was made. Reconciling never starts the occurrence again (the server's rule). */
    async reconcileOccurrence(companyId: unknown, jobId: unknown, occurrenceId: unknown, key: unknown, done: unknown): Promise<JobActionResult> {
      if (!isOccurrenceId(occurrenceId) || typeof key !== 'string' || !OPERATION_KEY.test(key) || typeof done !== 'boolean') return BAD_INPUT
      return act('reconcile occurrence', companyId, jobId, id => `/jobs/${id}/occurrences/${occurrenceId}/operations/${encodeURIComponent(key)}/reconcile`, { done })
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
  ipc.handle('jobs:watchChoices', (_event, companyId, text) => api.watchChoices(companyId, text))
  ipc.handle('jobs:rewatch', (_event, companyId, jobId, version, recordId) => api.rewatch(companyId, jobId, version, recordId))
  ipc.handle('jobs:occurrences', (_event, companyId) => api.occurrences(companyId))
  ipc.handle('jobs:retryOccurrence', (_event, companyId, jobId, occurrenceId) => api.retryOccurrence(companyId, jobId, occurrenceId))
  ipc.handle('jobs:reconcileOccurrence', (_event, companyId, jobId, occurrenceId, key, done) => api.reconcileOccurrence(companyId, jobId, occurrenceId, key, done))
}
