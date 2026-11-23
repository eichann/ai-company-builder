/**
 * A fake of the server's plan routes for the runner's tests (agent-browser.md "Plans, executions,
 * permits and locks"): the states and compare-and-sets of server/src/services/browser-plans.ts, as
 * far as one PC's run reaches them — approve (the hash), claim once with `fixed`, cancel, permit once,
 * report (the moves the service allows) — plus faults: an answer lost, `fixed` left out (an older
 * server), a refused permit, a permit that never answers. Not a copy of the service's rules beyond
 * that; the service has its own tests.
 */
import crypto from 'node:crypto'
import { canonicalJson } from '../../shared/core/fixed-content'
import type { BrowserFact, BrowserExecutionState, BrowserPlanState } from '../../shared/core/browser-plans'
import type { BrowserApiAnswer, BrowserPlansApi } from '../electron/features/browser/runner'

export const sha256 = (text: string) => `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`

export interface FakePlanInput {
  planId: string
  companyId: string
  connector: { id: string; version: string; declarationHash: string; checkerHash: string; factsVersion: number }
  operation: string
  account: string
  target: Record<string, string>
  change: Record<string, string>
  facts: Record<string, BrowserFact>
  createdAt: number
}

export interface FakeServerFaults {
  /** The claim answer has no `fixed` (a server before 6b-2a). */
  noFixed?: boolean
  /** Change the claim answer before it is sent (a server or a network that changes it). */
  tamperClaim?: (claim: Record<string, unknown>) => void
  /** The permit: refused, never answered, answered with this value, or after a callback (to move the clocks). */
  permit?: 'refuse' | 'hang' | 'throw' | { value: unknown }
  onPermit?: () => void | Promise<void>
  /** The content the server stores and hashes, spelled otherwise than canonically (a server bug): it still hashes to what was approved. */
  contentText?: (canonical: string) => string
  /** How many report calls are lost before one arrives. */
  lostReports?: number
}

export function fakePlansServer(plan: FakePlanInput, faults: FakeServerFaults = {}) {
  const canonical = canonicalJson({
    format: 1, company: plan.companyId, user: 'user-1', conversation: null, connector: plan.connector, operation: plan.operation,
    account: plan.account, target: plan.target, change: plan.change, facts: plan.facts, explanation: null,
    createdAt: new Date(plan.createdAt).toISOString(), expiresAt: new Date(plan.createdAt + 3600_000).toISOString(),
  })
  const content = faults.contentText ? faults.contentText(canonical) : canonical
  const state = {
    plan: 'draft' as BrowserPlanState,
    execution: null as BrowserExecutionState | null,
    approvedAt: 0,
    calls: [] as string[],
    reports: [] as Array<{ result: string; reason?: string }>,
    secret: crypto.randomBytes(32).toString('hex'),
  }
  const executionId = `bx_${plan.planId.slice(-16)}`
  const ok = (value: unknown): BrowserApiAnswer => ({ kind: 'ok', value })
  const refused = (code: string): BrowserApiAnswer => ({ kind: 'refused', code })
  const final = (s: BrowserExecutionState | null) => s !== null && ['succeeded', 'failed', 'confirmed_done', 'confirmed_not_done', 'void'].includes(s)
  const api: BrowserPlansApi = {
    async approve(companyId, planId, hash) {
      state.calls.push('approve')
      if (companyId !== plan.companyId || planId !== plan.planId) return refused('NOT_FOUND')
      if (state.plan !== 'draft') return refused('BROWSER_PLAN_NOT_DRAFT')
      if (hash !== sha256(content)) return refused('CONTENT_CHANGED')
      state.plan = 'approved'
      state.approvedAt = Date.now()
      return ok({})
    },
    async claim(companyId, planId) {
      state.calls.push('claim')
      if (companyId !== plan.companyId || planId !== plan.planId) return refused('NOT_FOUND')
      if (state.plan !== 'approved') return refused('BROWSER_PLAN_NOT_APPROVED')
      state.plan = 'claimed'
      state.execution = 'claimed'
      const claim: Record<string, unknown> = {
        executionId, secret: state.secret,
        plan: {
          planId: plan.planId, companyId: plan.companyId, connector: { id: plan.connector.id, version: plan.connector.version }, operation: plan.operation,
          account: plan.account, target: plan.target, change: plan.change, before: (plan.facts.state as { value: Record<string, string[]> }).value,
          approvedAt: new Date(state.approvedAt).toISOString(), expiresAt: new Date(plan.createdAt + 3600_000).toISOString(),
        },
        ...(faults.noFixed ? {} : { fixed: { content, contentHash: sha256(content), factsVersion: plan.connector.factsVersion } }),
      }
      faults.tamperClaim?.(claim)
      return ok(claim)
    },
    async cancel(companyId, planId) {
      state.calls.push('cancel')
      if (companyId !== plan.companyId || planId !== plan.planId) return refused('NOT_FOUND')
      if (state.execution === 'claimed') { state.execution = 'void'; state.plan = 'done'; return ok({}) }
      return refused('BROWSER_PLAN_NOT_CANCELLABLE')
    },
    async permit(_companyId, execution, secret, signal) {
      state.calls.push('permit')
      if (execution !== executionId || secret !== state.secret) return refused('NOT_FOUND')
      await faults.onPermit?.()
      if (faults.permit === 'throw') throw new Error('network')
      if (faults.permit === 'hang') return new Promise(resolve => signal.addEventListener('abort', () => resolve({ kind: 'no-answer' })))
      if (state.execution !== 'claimed') return refused(final(state.execution) ? 'BROWSER_EXECUTION_CLOSED' : 'BROWSER_PERMIT_USED')
      if (faults.permit === 'refuse') { state.execution = 'void'; state.plan = 'done'; return refused('BROWSER_AI_STOPPED') }
      state.execution = 'permitted'
      if (faults.permit && typeof faults.permit === 'object') return ok(faults.permit.value)
      return ok({ permittedAt: new Date().toISOString(), validMs: 5000 })
    },
    async report(execution, secret, body) {
      state.calls.push('report')
      if (execution !== executionId || secret !== state.secret) return refused('Unauthorized')
      if ((faults.lostReports ?? 0) > 0) { faults.lostReports = (faults.lostReports ?? 0) - 1; return { kind: 'no-answer' } }
      state.reports.push({ ...body })
      if (state.execution === 'permitted') {
        state.execution = body.result === 'unknown' ? 'unknown' : body.result
        if (body.result !== 'unknown') state.plan = 'done'
        return ok({ state: state.execution, outcome: 'applied' })
      }
      if (state.execution === 'unknown' && body.result === 'succeeded') { state.execution = 'succeeded'; return ok({ state: 'succeeded', outcome: 'applied' }) }
      return refused('BROWSER_REPORT_CONFLICT')
    },
  }
  return { api, state, content, contentHash: sha256(content) }
}
