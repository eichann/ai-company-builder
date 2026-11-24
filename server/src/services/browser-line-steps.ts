/**
 * Executions of a plan with several writes (generalization PR 4; agent-browser.md "Executions with several writes" — the
 * state table is the contract, `model/browser-plan/StepsLife.tla` its checked model; each function names its row). One
 * execution per plan, claimed once; **a permit per write**, write k only after write k−1 was reported done; a report
 * names its write; `unknown` ends the run for good (the writes after it `skipped` at once) and only the person's confirm
 * or a late sure "done" settles it; `partial` holds no unknown write.
 *
 * **Unreachable in this build**: a plan of writes is made only from an approved line that writes; the one such line
 * (`step_template_add`, generalization PR 6) is `pending`, and `browser-lines.ts` refuses every plan of writes and every
 * inspection of a line that writes (`BROWSER_LINE_WRITES_NOT_YET`). The table is built now (owner decision on #813) so that this build is the
 * **rollback floor** of the first build that writes: it knows every row such a build leaves (deployment.md).
 *
 * Every function runs in the caller's transaction (synchronous), on the company's handle; time-outs are judged on every
 * touch (`settle`), never by a timer.
 */
import { BROWSER_PLAN_TIMES, browserObjectLockKey } from '../../shared/core/browser-plans'
import type {
  BrowserLineExecutionState, BrowserLinePermit, BrowserLineReportAnswer, BrowserWriteResult, BrowserWriteState,
} from '../../shared/types/browser-lines'
import type { Clock, IdGenerator, MonotonicClock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { BrowserLineExecutionRow, BrowserLinePlanRow, BrowserLineRepository, BrowserStepRow } from '../ports/browser-lines'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

/** One write of a plan as its fixed content holds it. */
export interface BrowserLineWrite {
  kind: 'create' | 'change'
  /** The map's thing it writes (a create: the thing it makes). */
  thing: string
  /** The thing's id field (the created object's lock key and the permit's binding use it). */
  idField: string
  /** A change of what write `created` made: the permit names the id the server recorded for it. */
  on?: { created: number }
}

/** The part of a write plan's fixed content the steps read. */
export interface BrowserLineWritesContent {
  writes: BrowserLineWrite[]
  /** Every lock key taken at the claim (each existing object, each "create in this parent" reservation). */
  locks: string[]
  host: string
  account: string
  site: string
  company: string
}

export const BROWSER_LINE_TIMES = {
  ...BROWSER_PLAN_TIMES,
  /** The plan's limit from its first permit (memo §4-2): later permits stop, a gap ends `partial`. Never shortens a write's window. */
  runLimit: 2 * 60_000,
} as const

export const BROWSER_LINE_FINAL: readonly BrowserLineExecutionState[] = ['succeeded', 'partial', 'failed', 'void', 'confirmed_done', 'confirmed_not_done']
export const isFinalLineExecution = (s: BrowserLineExecutionState) => BROWSER_LINE_FINAL.includes(s)
const OPEN_STEP: readonly BrowserWriteState[] = ['permitted', 'unknown']

export const BROWSER_STEP_WORDS = {
  notYet: 'ひとつ前の書き込みの結果がまだ届いていません。届いてからもう一度',
  afterUnknown: '前の書き込みが届いたか分からないので、続きは送りません',
  closed: 'この実行は、もう送れません',
  stepUsed: 'この書き込みの送る許可は、もう出ています',
  notInOrder: 'この書き込みは、順番がまだです',
  badReport: '報告の形が正しくありません',
  notPermitted: 'この書き込みには送る許可が出ていません（送られていません）',
  reportConflict: '前の報告と食い違う報告です（記録しました）',
  tooEarly: 'まだ送られるかもしれません。少し待ってから確かめてください',
  clockBackwards: 'サーバーの時刻が戻っています。時刻が正しくなってから確かめてください',
  alreadySettled: 'この書き込みの結果は、もう決まっています',
  mayHaveSent: '送られた可能性があるので、やめられません。済んだかどうかを確かめてください',
  targetBusy: '同じ対象で、実行中か確かめ待ちのものがあります。それが済むまで待ってください',
  frozen: 'この計画は、このサーバーでは扱えない形です',
} as const
const W = BROWSER_STEP_WORDS

export interface BrowserLineStepsDeps {
  companyData: CompanyDataSource
  clock: Clock
  monotonic: MonotonicClock
  ids: IdGenerator
}

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string) => Date.parse(s)

export function createBrowserLineSteps(deps: BrowserLineStepsDeps) {
  const { companyData, clock, monotonic, ids } = deps
  const repo = (companyId: string): BrowserLineRepository => companyData.forCompany(companyId).browserLines

  /** Permit + 5 s + 30 s on both clocks, from **this write's** permit (BrokenStepsWindowFromFirstPermit → R5). */
  function pastWindow(step: BrowserStepRow, now: number): boolean {
    if (!step.permittedAt) return false
    const window = BROWSER_LINE_TIMES.permit + BROWSER_LINE_TIMES.grace
    if (now < ms(step.permittedAt) + window) return false
    const mono = Math.floor(monotonic.monoMs())
    const sameStart = step.permittedBoot === monotonic.bootId && step.permittedMonoMs !== null
    return (sameStart ? mono - (step.permittedMonoMs as number) : mono) >= window
  }

  /** The writes after `index` that were never tried become `skipped`. */
  function skipAfter(companyId: string, exec: BrowserLineExecutionRow, index: number, now: number): void {
    for (const s of repo(companyId).steps(exec.id)) {
      if (s.index > index && s.state === 'pending') repo(companyId).setStepState(exec.id, s.index, 'pending', 'skipped', { settledAt: iso(now) })
    }
  }

  /** A final state: every lock this execution holds goes, the plan is done. */
  function finish(companyId: string, exec: BrowserLineExecutionRow, to: BrowserLineExecutionState, change: { voidReason?: string; confirmedBy?: string }, now: number): boolean {
    const r = repo(companyId)
    if (!r.setExecutionState(exec.id, exec.state, to, { ...change, settledAt: iso(now) })) return false
    r.releaseLocksOf(exec.id)
    r.setPlanState(exec.planId, 'claimed', 'done', { closedAt: iso(now) })
    return true
  }

  /**
   * Time-outs, on every touch: `VoidClaimed` (2 minutes without a permit, or the plan's hour), `ServerSettlesUnknown`
   * (that write's own window passed on both clocks: unknown, the rest skipped), `ServerEndsGap` (running, nothing open,
   * the next write pending and the run's limit past: partial, the rest skipped).
   */
  function settle(companyId: string, exec: BrowserLineExecutionRow, plan: BrowserLinePlanRow, now: number): BrowserLineExecutionRow {
    const r = repo(companyId)
    if (exec.state === 'claimed') {
      if (now >= ms(exec.claimedAt) + BROWSER_LINE_TIMES.claimWithoutPermit || now >= ms(plan.expiresAt)) finish(companyId, exec, 'void', { voidReason: 'expired' }, now)
    } else if (exec.state === 'running') {
      const steps = r.steps(exec.id)
      const open = steps.find(s => s.state === 'permitted')
      if (open && pastWindow(open, now)) {
        if (r.setStepState(exec.id, open.index, 'permitted', 'unknown', { settledAt: iso(now) })) {
          skipAfter(companyId, exec, open.index, now)
          r.setExecutionState(exec.id, 'running', 'unknown', {})
        }
      } else if (!open && !steps.some(s => s.state === 'unknown') && steps.some(s => s.state === 'pending')
        && exec.firstPermittedAt !== null && now >= ms(exec.firstPermittedAt) + BROWSER_LINE_TIMES.runLimit) {
        skipAfter(companyId, exec, 0, now)
        finish(companyId, exec, 'partial', { voidReason: 'run-limit' }, now)
      }
    }
    return r.execution(exec.id) as BrowserLineExecutionRow
  }

  return {
    settle,
    pastWindow,

    /**
     * `Claim`: the plan approved and judged by the caller (gate), every lock key the plan names free on **both** paths
     * (the old path's `browser_target_locks` too: one object, one key, C11) — then the execution `claimed`, one `pending`
     * row per write, every lock, the plan `claimed`, all in the caller's transaction. A holder on the old path counts as
     * busy (its own touches settle it).
     */
    claim(companyId: string, plan: BrowserLinePlanRow, content: BrowserLineWritesContent, secretHash: string, now: number): Outcome<{ executionId: string }> {
      const handle = companyData.forCompany(companyId)
      const r = handle.browserLines
      for (const key of content.locks) {
        const holder = r.lockHolder(key)
        if (holder) {
          const held = r.execution(holder)
          const heldPlan = held ? r.plan(held.planId) : null
          if (held && heldPlan) settle(companyId, held, heldPlan, now)
        }
        if (r.lockHolder(key) || handle.browserPlans.lockHolder(key)) return refuse('conflict', W.targetBusy, { code: 'BROWSER_TARGET_BUSY' })
      }
      if (!r.setPlanState(plan.id, 'approved', 'claimed', {})) return refuse('conflict', W.closed, { code: 'BROWSER_PLAN_NOT_APPROVED' })
      const executionId = `bw_${ids.newToken().slice(0, 32)}`
      r.insertExecution(
        { id: executionId, planId: plan.id, userId: plan.userId, secretHash, state: 'claimed', voidReason: null, claimedAt: iso(now), firstPermittedAt: null, settledAt: null, confirmedBy: null },
        content.writes.map((w, i) => ({
          executionId, index: i + 1, kind: w.kind, state: 'pending' as const, permittedAt: null, permittedMonoMs: null, permittedBoot: null,
          settledAt: null, createdId: null, createdLockKey: null, confirmedBy: null,
        })),
      )
      for (const key of content.locks) {
        if (!r.takeLock(key, executionId, iso(now))) throw new Error('browser lines: a lock was taken during the claim')
      }
      return ok({ executionId })
    },

    /**
     * `ServerPermits` / `ServerSaysNotYet` / `ServerRefusesPermit`: write k only from `claimed` (k = 1) or `running`, write
     * k `pending`, write k−1 `done`, nothing `permitted` / `unknown`, the run's limit not past, the gate (asked here, so a
     * refusal settles the execution in the same transaction). Once per write.
     */
    permit(companyId: string, found: BrowserLineExecutionRow, plan: BrowserLinePlanRow, content: BrowserLineWritesContent, index: number,
      gate: () => Refusal | null, now: number): Outcome<BrowserLinePermit> {
      const r = repo(companyId)
      const exec = settle(companyId, found, plan, now)
      if (exec.state === 'unknown') return refuse('conflict', W.afterUnknown, { code: 'BROWSER_LINE_AFTER_UNKNOWN' })
      if (exec.state !== 'claimed' && exec.state !== 'running') return refuse('conflict', W.closed, { code: 'BROWSER_EXECUTION_CLOSED' })
      const steps = r.steps(exec.id)
      const step = steps.find(s => s.index === index)
      if (!step || steps.length !== content.writes.length) return refuse('bad-request', W.badReport, { code: 'BROWSER_BAD_WRITE_INDEX' })
      if (step.state !== 'pending') return refuse('conflict', W.stepUsed, { code: 'BROWSER_PERMIT_USED' })
      const before = steps.find(s => s.index === index - 1)
      if (before && before.state === 'permitted') return refuse('conflict', W.notYet, { code: 'BROWSER_LINE_NOT_YET' })
      if ((before && before.state !== 'done') || steps.some(s => OPEN_STEP.includes(s.state))) return refuse('conflict', W.notInOrder, { code: 'BROWSER_LINE_NOT_IN_ORDER' })
      if (exec.state === 'claimed' && index !== 1) return refuse('conflict', W.notInOrder, { code: 'BROWSER_LINE_NOT_IN_ORDER' })
      const refused = gate()
      if (refused) {
        // A refusal never revives the secret: claimed → void; running with nothing open → partial (the rest skipped).
        if (exec.state === 'claimed') finish(companyId, exec, 'void', { voidReason: String(refused.body.code ?? 'refused') }, now)
        else { skipAfter(companyId, exec, 0, now); finish(companyId, exec, 'partial', { voidReason: String(refused.body.code ?? 'refused') }, now) }
        return refused
      }
      // A change of what an earlier write created goes to the id the server recorded for it, never one the app names.
      const write = content.writes[index - 1]
      let createdTarget: string | null = null
      if (write.on) {
        const made = steps.find(s => s.index === write.on?.created)
        if (!made || made.state !== 'done' || made.createdId === null) return refuse('conflict', W.notInOrder, { code: 'BROWSER_LINE_NOT_IN_ORDER' })
        createdTarget = made.createdId
      }
      const monoMs = Math.floor(monotonic.monoMs())
      if (!r.setStepState(exec.id, index, 'pending', 'permitted', { permittedAt: iso(now), permittedMonoMs: monoMs, permittedBoot: monotonic.bootId })) {
        return refuse('conflict', W.stepUsed, { code: 'BROWSER_PERMIT_USED' })
      }
      if (exec.state === 'claimed' && !r.setExecutionState(exec.id, 'claimed', 'running', { firstPermittedAt: iso(now) })) throw new Error('browser lines: the execution moved during the permit')
      return ok({ index, permittedAt: iso(now), validMs: BROWSER_LINE_TIMES.permit, createdTarget })
    },

    /**
     * `ServerGetsReport` for write `index` (never "the current one"): permitted + done → done (a create records its object
     * and takes its lock; the last → succeeded); permitted + not_sent → not_sent, the rest skipped (write 1 → failed, else
     * partial); permitted + unknown → unknown, the rest skipped, the execution unknown; unknown + done → done and the
     * execution **ends** (succeeded when last, else partial) — never running again. Anything else is recorded only.
     */
    report(companyId: string, found: BrowserLineExecutionRow, plan: BrowserLinePlanRow, content: BrowserLineWritesContent,
      input: { index: number; result: BrowserWriteResult; reason: string | null; createdId: string | null }, now: number): Outcome<BrowserLineReportAnswer> {
      const r = repo(companyId)
      const exec = settle(companyId, found, plan, now)
      const steps = r.steps(exec.id)
      const step = steps.find(s => s.index === input.index)
      if (!step) return refuse('bad-request', W.badReport, { code: 'BROWSER_BAD_REPORT' })
      const write = content.writes[input.index - 1]
      // A create is done only with the object identified (C3): its id, as the app found it for sure.
      if (input.result === 'done' && write?.kind === 'create' && input.createdId === null) return refuse('bad-request', W.badReport, { code: 'BROWSER_BAD_REPORT' })
      if (input.createdId !== null && (write?.kind !== 'create' || input.result !== 'done')) return refuse('bad-request', W.badReport, { code: 'BROWSER_BAD_REPORT' })
      const last = input.index === steps.length
      const createdChange = () => {
        if (write.kind !== 'create' || input.createdId === null) return {}
        return { createdId: input.createdId, createdLockKey: createdLockKey(content, write, input.createdId) }
      }
      let outcome: BrowserLineReportAnswer['outcome']
      const s = step.state
      if (s === 'permitted' || (s === 'unknown' && input.result === 'done')) {
        if (s === 'unknown' && exec.state !== 'unknown') outcome = 'conflict'
        else if (input.result === 'done') {
          const change = createdChange()
          if (!r.setStepState(exec.id, step.index, s, 'done', { settledAt: iso(now), ...change })) outcome = 'conflict'
          else {
            outcome = 'applied'
            const lockTaken = !change.createdLockKey || r.takeLock(change.createdLockKey, exec.id, iso(now))
            if (s === 'unknown') finish(companyId, exec, last ? 'succeeded' : 'partial', {}, now)
            else if (last) finish(companyId, exec, 'succeeded', {}, now)
            else if (!lockTaken) {
              // Its new object's key is someone else's: nothing more is sent (safe side).
              skipAfter(companyId, exec, step.index, now)
              finish(companyId, exec, 'partial', { voidReason: 'created-busy' }, now)
            }
          }
        } else if (input.result === 'not_sent') {
          if (!r.setStepState(exec.id, step.index, 'permitted', 'not_sent', { settledAt: iso(now) })) outcome = 'conflict'
          else {
            outcome = 'applied'
            skipAfter(companyId, exec, step.index, now)
            finish(companyId, exec, step.index === 1 ? 'failed' : 'partial', {}, now)
          }
        } else {
          if (!r.setStepState(exec.id, step.index, 'permitted', 'unknown', { settledAt: iso(now) })) outcome = 'conflict'
          else {
            outcome = 'applied'
            skipAfter(companyId, exec, step.index, now)
            r.setExecutionState(exec.id, 'running', 'unknown', {})
          }
        }
      } else if (s === 'pending' || s === 'skipped') {
        // Never permitted: nothing can have been sent.
        outcome = 'conflict'
      } else {
        const contradicts = (input.result === 'done' && (s === 'not_sent' || s === 'confirmed_not_done'))
          || (input.result === 'not_sent' && (s === 'done' || s === 'confirmed_done'))
          || (input.result === 'done' && s === 'done' && input.createdId !== step.createdId)
        outcome = contradicts ? 'conflict' : s === input.result ? 'same' : 'recorded'
      }
      r.appendReport({ id: ids.newId(), executionId: exec.id, index: step.index, result: input.result, reason: input.reason, createdId: input.createdId, outcome, stateBefore: s, at: iso(now) })
      if (outcome === 'conflict') {
        return refuse('conflict', s === 'pending' || s === 'skipped' ? W.notPermitted : W.reportConflict, { code: 'BROWSER_REPORT_CONFLICT', state: s })
      }
      const after = r.steps(exec.id).find(x => x.index === step.index) as BrowserStepRow
      return ok({ state: (r.execution(exec.id) as BrowserLineExecutionRow).state, step: after.state, outcome })
    },

    /**
     * `PersonConfirms`: only the unknown write, only past its own window on both clocks, never with the server's clock
     * behind its permit; the write and the execution `confirmed_*`, the locks go. Who may: decided by the caller.
     */
    confirm(companyId: string, found: BrowserLineExecutionRow, plan: BrowserLinePlanRow, index: number, result: 'done' | 'not_done', by: string, now: number): Outcome<BrowserLineExecutionRow> {
      const r = repo(companyId)
      const exec = settle(companyId, found, plan, now)
      const step = r.steps(exec.id).find(s => s.index === index)
      if (!step) return refuse('bad-request', W.badReport, { code: 'BROWSER_BAD_WRITE_INDEX' })
      if (step.state === 'pending' || step.state === 'skipped') return refuse('conflict', W.notPermitted, { code: 'BROWSER_NOT_PERMITTED' })
      if (step.state !== 'permitted' && step.state !== 'unknown') return refuse('conflict', W.alreadySettled, { code: 'BROWSER_ALREADY_SETTLED' })
      if (now < ms(step.permittedAt as string)) return refuse('conflict', W.clockBackwards, { code: 'BROWSER_CLOCK_BACKWARDS' })
      if (step.state !== 'unknown' || exec.state !== 'unknown' || !pastWindow(step, now)) return refuse('conflict', W.tooEarly, { code: 'BROWSER_TOO_EARLY' })
      const to = result === 'done' ? 'confirmed_done' as const : 'confirmed_not_done' as const
      if (!r.setStepState(exec.id, index, 'unknown', to, { settledAt: iso(now), confirmedBy: by })) return refuse('conflict', W.alreadySettled, { code: 'BROWSER_ALREADY_SETTLED' })
      finish(companyId, exec, to, { confirmedBy: by }, now)
      return ok(r.execution(exec.id) as BrowserLineExecutionRow)
    },

    /**
     * `AppStopsBetween` (the app gives the rest back) and leaving: claimed → void; running with nothing open and the next
     * write pending → partial (the rest skipped). A write open (permitted / unknown) may have been sent: refused.
     */
    giveBack(companyId: string, found: BrowserLineExecutionRow, plan: BrowserLinePlanRow, reason: string, now: number): Outcome<null> {
      const r = repo(companyId)
      const exec = settle(companyId, found, plan, now)
      if (exec.state === 'claimed') return finish(companyId, exec, 'void', { voidReason: reason }, now) ? ok(null) : refuse('conflict', W.closed, { code: 'BROWSER_PLAN_NOT_OPEN' })
      if (exec.state === 'running' && !r.steps(exec.id).some(s => OPEN_STEP.includes(s.state))) {
        skipAfter(companyId, exec, 0, now)
        return finish(companyId, exec, 'partial', { voidReason: reason }, now) ? ok(null) : refuse('conflict', W.closed, { code: 'BROWSER_PLAN_NOT_OPEN' })
      }
      if (exec.state === 'running' || exec.state === 'unknown') return refuse('conflict', W.mayHaveSent, { code: 'BROWSER_MAY_HAVE_SENT' })
      return refuse('conflict', W.closed, { code: 'BROWSER_PLAN_NOT_OPEN' })
    },

    now: () => clock.nowMs(),
  }
}

/** A created object's lock key: the same shape as every other (company, host, account, `<site>.<thing>`, its id). */
function createdLockKey(content: BrowserLineWritesContent, write: BrowserLineWrite, id: string): string {
  return browserObjectLockKey({ company: content.company, host: content.host, account: content.account, site: content.site, thing: write.thing, id: { field: write.idField, value: id } })
}

export type BrowserLineSteps = ReturnType<typeof createBrowserLineSteps>
