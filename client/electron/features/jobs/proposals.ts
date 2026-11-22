// Member proposals of a time job (jobs.md "Member proposals" "The app (PR C)"): the chat card and 「定期の仕事」 read and act
// with the member's **session** — never the AI's record token, and no chat-server route or AI tool reaches these handlers:
// the submit is the member's own press on the card (the renderer's IPC), as the approval card's 「承認」 is.
//   jobProposals:candidate  the candidate the card shows (`GET /me/job-candidates/:id`), and its proposal once submitted
//   jobProposals:submit     「これで管理者に出す」 with the candidate's id and the fingerprint the card shows
//   jobProposals:mine       the member's proposals (`GET /me/job-proposals`)
//   jobProposals:withdraw   「取り下げる」 while it waits
//   jobProposals:discard    「やめる」: the candidate not submitted yet is discarded on the server (owner decision 2026-11-22)

import {
  JOB_PROPOSALS_OFFLINE_TEXT, isJobFingerprint, jobProposalRefusalText, readProposalView, readShownCandidate,
  type JobCandidateDiscardResult, type JobCandidateResult, type JobProposalResult, type JobProposalsFailure, type MyJobProposalsResult,
} from '../../../shared/job-proposals'
import { APP_JOB_SCHEMAS } from '../../../shared/jobs'
import { JOB_SCHEMAS_HEADER } from '../../../../shared/core/jobs'
import { isJobCandidateId, isJobProposalId } from '../../../../shared/core/job-proposals'
import type { JobProposalView } from '../../../../shared/types/job-proposals'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface JobProposalsDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  timeoutMs?: number
}

const COMPANY_ID = /^[A-Za-z0-9_-]{1,100}$/
const BAD_INPUT: JobProposalsFailure = { success: false, offline: false, code: 'BAD_REQUEST', error: jobProposalRefusalText('BAD_REQUEST') }
const OFFLINE: JobProposalsFailure = { success: false, offline: true, code: null, error: JOB_PROPOSALS_OFFLINE_TEXT }
/** At most this many proposals are shown (the server lists a bounded number too). */
const MAX_PROPOSALS = 100

type Answer = { status: number; json: Record<string, unknown> | null }

export function createJobProposalsApi(deps: JobProposalsDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function call(companyId: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<Answer | null> {
    const base = deps.baseUrl().replace(/\/+$/, '')
    const cookies = deps.cookies()
    if (!base || cookies.length === 0) return null
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        headers: { Cookie: cookies.join('; '), [JOB_SCHEMAS_HEADER]: APP_JOB_SCHEMAS.join(','), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
    } catch {
      return null
    }
  }

  /** A refusal in the app's fixed words (never the server's text, a place or a fingerprint). */
  function failure(what: string, r: Answer | null): JobProposalsFailure {
    if (!r) {
      log.warn(`[job-proposals] ${what}: the server could not be reached`)
      return OFFLINE
    }
    const code = typeof r.json?.code === 'string' && /^[A-Z_]{1,60}$/.test(r.json.code) ? r.json.code : null
    log.warn(`[job-proposals] ${what}: answered ${r.status}${code ? ` ${code}` : ''}`)
    if (r.status >= 500) return { success: false, offline: true, code, error: `サーバーでエラーが起きました（HTTP ${r.status}）。` }
    return { success: false, offline: false, code, error: jobProposalRefusalText(code) }
  }

  const ok = (r: Answer | null): r is Answer => !!r && r.status >= 200 && r.status < 300 && !!r.json?.data && typeof r.json.data === 'object'

  async function mine(companyId: unknown): Promise<MyJobProposalsResult> {
    if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId)) return BAD_INPUT
    const r = await call(companyId, '/me/job-proposals', 'GET')
    // A server before member proposals: none can exist there (said as nothing, never as an error).
    if (r && r.status === 404) return { success: true, supported: false, proposals: [] }
    if (!ok(r)) return failure('mine', r)
    const list = (r.json!.data as { proposals?: unknown }).proposals
    const proposals = (Array.isArray(list) ? list : []).slice(0, MAX_PROPOSALS).map(readProposalView).filter((p): p is JobProposalView => p !== null)
    return { success: true, supported: true, proposals }
  }

  return {
    async candidate(companyId: unknown, candidateId: unknown): Promise<JobCandidateResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId) || !isJobCandidateId(candidateId)) return BAD_INPUT
      const r = await call(companyId, `/me/job-candidates/${candidateId}`, 'GET')
      // Discarded by the member (「やめる」): said as such until its 24 hours (then gone, as any).
      if (r?.status === 410 && r.json?.code === 'JOB_CANDIDATE_DISCARDED') return { success: true, candidate: null, proposal: null, discarded: true }
      if (r?.status !== 404) {
        if (!ok(r)) return failure('candidate', r)
        const data = r.json!.data as { proposal?: unknown }
        return { success: true, candidate: readShownCandidate(data, candidateId), proposal: data.proposal ? readProposalView(data.proposal) : null }
      }
      // Gone (24 hours) or withheld — the same 404. Once submitted, its proposal still says what became of it.
      const listed = await mine(companyId)
      if (!listed.success) return listed
      return { success: true, candidate: null, proposal: listed.proposals.find(p => p.candidateId === candidateId) ?? null }
    },
    async submit(companyId: unknown, candidateId: unknown, fingerprint: unknown): Promise<JobProposalResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId) || !isJobCandidateId(candidateId) || !isJobFingerprint(fingerprint)) return BAD_INPUT
      const r = await call(companyId, `/me/job-candidates/${candidateId}/submit`, 'POST', { fingerprint })
      const proposal = ok(r) ? readProposalView((r.json!.data as { proposal?: unknown }).proposal) : null
      return proposal ? { success: true, proposal } : failure('submit', r)
    },
    mine,
    /** 「やめる」 (the member's press on the card). A server before it (404 naming no job code) discarded nothing: `supported: false`. */
    async discard(companyId: unknown, candidateId: unknown): Promise<JobCandidateDiscardResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId) || !isJobCandidateId(candidateId)) return BAD_INPUT
      const r = await call(companyId, `/me/job-candidates/${candidateId}/discard`, 'POST')
      if (r && r.status === 404 && typeof r.json?.code !== 'string') return { success: true, supported: false }
      if (ok(r)) return { success: true, supported: true }
      return failure('discard', r)
    },
    async withdraw(companyId: unknown, proposalId: unknown): Promise<JobProposalResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId) || !isJobProposalId(proposalId)) return BAD_INPUT
      const r = await call(companyId, `/me/job-proposals/${proposalId}/withdraw`, 'POST')
      const proposal = ok(r) ? readProposalView((r.json!.data as { proposal?: unknown }).proposal) : null
      return proposal ? { success: true, proposal } : failure('withdraw', r)
    },
  }
}

export function registerJobProposalsIpc(ipc: IpcRegistrar, deps: JobProposalsDeps) {
  const api = createJobProposalsApi(deps)
  ipc.handle('jobProposals:candidate', (_event, companyId, candidateId) => api.candidate(companyId, candidateId))
  ipc.handle('jobProposals:submit', (_event, companyId, candidateId, fingerprint) => api.submit(companyId, candidateId, fingerprint))
  ipc.handle('jobProposals:mine', (_event, companyId) => api.mine(companyId))
  ipc.handle('jobProposals:withdraw', (_event, companyId, proposalId) => api.withdraw(companyId, proposalId))
  ipc.handle('jobProposals:discard', (_event, companyId, candidateId) => api.discard(companyId, candidateId))
}
