/**
 * 「ブラウザ操作」 plans on the server (PR 6a; agent-browser.md "Plans, executions, permits and locks";
 * internal design memo §30–§31). The app's main process registers a candidate with the facts its
 * checker read; the member approves the content they saw (its hash); the app claims the plan once
 * (an execution and its secret; the target lock), asks for a permit right before the one send, and
 * reports. A person says whether an execution whose result is not known happened.
 *
 * - Everything is a person's session (the routes' `companyMember`), except the report, which the
 *   execution's secret alone proves (a member who left may still report). No AI token reaches any.
 * - Every state change is a compare-and-set on the current state inside one transaction: of two
 *   at the same moment only one wins.
 * - Time-outs are judged whenever a plan or an execution is touched (read, claim, permit, report,
 *   confirm, the lists), by the server's clock — never only by a timer.
 * - At register, approve, claim and permit: the combination is approved (not retired) and the app
 *   new enough, the operation passes the first version's rule, the company's setting lets the
 *   member use it on that site at that level, the AI is not stopped, the member is granted the type.
 *   Report, confirm and the lists go on for a retired combination (clean-up never stops).
 * - Nothing in the app calls these yet (6b).
 */
import { browserAiStopped, type BrowserOperationSettings } from '../../shared/core/browser-operation'
import {
  BROWSER_PLAN_TIMES, BROWSER_REPORT_RESULTS, browserFactsAccount, browserFactsProblem, browserFactsState,
  browserLockKey, isFinalExecutionState, type BrowserExecutionState, type BrowserFact, type BrowserReportResult,
} from '../../shared/core/browser-plans'
import { compareClientVersions, parseClientVersion } from '../../shared/core/client-version'
import { canonicalJson } from '../../shared/core/fixed-content'
import {
  browserFirstVersionProblem, browserOperationsAllowed, browserPlanProblem, expectedAfter, isPlainBrowserText,
  type BrowserOperation, type PluginBrowser,
} from '../../shared/core/plugin-browser-declaration'
import { parsePluginManifest } from '../../shared/core/plugins'
import type {
  BrowserClaim, BrowserExecutionView, BrowserPermit, BrowserPlanView, BrowserReportAnswer, BrowserTypeGrantsView, BrowserWaitingPage,
} from '../../shared/types/browser-plans'
import type { AccountDirectory } from '../ports/accounts'
import type {
  ApprovedCombinationRow, BrowserConnectorCatalog, BrowserExecutionLookup, BrowserExecutionRow, BrowserPlanRepository, BrowserPlanRow,
} from '../ports/browser-plans'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { hashCanonical } from '../lib/content-hash'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserPlanDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  tokenDigest: TokenDigest
  catalog: BrowserConnectorCatalog
  executionLookup: BrowserExecutionLookup
  memberships: Pick<MembershipRepository, 'roleOf' | 'joinedAt'>
  accounts: AccountDirectory
  /** The member's browser setting now (the company's, with their own mode: agent-browser.md). */
  browserPolicy: (member: Member) => BrowserOperationSettings
  /** The member's AI stops now (agent-stop.md). */
  aiStops: (member: Member) => { all: boolean; tools: readonly string[] }
  log?: Pick<Console, 'warn'>
}

/** The words people (and the app) see. */
export const BROWSER_PLAN_WORDS = {
  badPlan: '計画の形が正しくありません',
  notFound: '計画が見つかりません',
  executionNotFound: '実行が見つかりません',
  notApproved: 'この操作の型（またはアプリの確かめる部品）は認められていません。アプリを新しくしてください',
  retired: 'この操作の型は、もう使えません',
  appTooOld: 'アプリが古いので、この操作は任せられません。アプリを新しくしてください',
  unknownOperation: 'この操作の型はありません',
  notAllowed: 'この会社では、いまこのサイトのこの操作は使えません',
  aiStopped: 'AI が止められているので、ブラウザ操作はできません',
  notGranted: 'この操作は、管理者からまだ任されていません',
  factsStale: 'サイトから読み取った情報が古いか、時刻が正しくありません。もう一度読み取ってください',
  cannotComeTrue: '計画どおりの結果になりえません（いまの状態とかみ合いません）',
  expired: '計画の期限が切れました。もう一度計画を作ってください',
  notDraft: 'この計画は、もう任せる前の状態ではありません',
  contentChanged: '内容が変わりました。もう一度確かめてください',
  notApprovedYet: 'この計画は、まだ任されていないか、もう使われました',
  targetBusy: '同じ対象で、実行中か確かめ待ちのものがあります。それが済むまで待ってください',
  permitUsed: 'この実行の送る許可は、もう出ています。もう一度は出せません',
  executionClosed: 'この実行は、もう送れません',
  notPermitted: 'この実行には送る許可が出ていません（送られていません）',
  reportConflict: '前の報告と食い違う報告です（記録しました）',
  tooEarly: 'まだ送られるかもしれません。少し待ってから確かめてください',
  clockBackwards: 'サーバーの時刻が戻っています。時刻が正しくなってから確かめてください',
  alreadySettled: 'この実行の結果は、もう決まっています',
  notYoursYet: '本人が確かめるのを待っています（本人が会社を抜けたか、24時間たつと確かめられます）',
  mayHaveSent: '送られた可能性があるので、やめられません。済んだかどうかを確かめてください',
  notOpen: 'この計画は、もう終わっています',
  manageForbidden: 'ブラウザ操作の任せ先を変えられるのは、オーナーと管理者だけです',
  memberNotFound: 'Member not found',
} as const

const W = BROWSER_PLAN_WORDS
/** Rows per page of the waiting list (lifecycle work has no limit: `executionsIn` without a page). */
export const WAITING_PAGE = 100
/** Why a claimed execution became void when the permit's checks refused (the refusal's code → the reason kept). */
const GATE_VOID_REASONS: Record<string, string> = {
  BROWSER_AI_STOPPED: 'stopped',
  BROWSER_NOT_ALLOWED: 'setting',
  BROWSER_TYPE_NOT_GRANTED: 'not-granted',
  BROWSER_TYPE_RETIRED: 'retired',
  BROWSER_TYPE_NOT_APPROVED: 'not-approved',
  BROWSER_APP_TOO_OLD: 'app-too-old',
  BROWSER_OPERATION_NOT_YET: 'not-yet',
  BROWSER_UNKNOWN_OPERATION: 'unknown-operation',
}
const PLAN_ID_RE = /^bp_[0-9a-f]{32}$/
const EXEC_ID_RE = /^bx_[0-9a-f]{32}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const CONVERSATION_RE = /^[A-Za-z0-9_-]{1,100}$/
const REASON_RE = /^[a-z][a-z0-9-]{0,39}$/
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string) => Date.parse(s)

interface Combination {
  row: ApprovedCombinationRow
  label: string
  browser: PluginBrowser
}

/** The fixed content of a plan (canonical JSON; its hash is what the person approves). */
interface PlanContent {
  format: 1
  company: string
  user: string
  conversation: string | null
  connector: { id: string; version: string; declarationHash: string; checkerHash: string; factsVersion: number }
  operation: string
  account: string
  target: Record<string, string>
  change: Record<string, string>
  facts: Record<string, BrowserFact>
  explanation: string | null
  createdAt: string
  expiresAt: string
}

interface Parsed {
  connector: { id: string; version: string }
  operation: string
  declarationHash: string
  checkerHash: string
  factsVersion: number
  target: Record<string, string>
  change: Record<string, string>
  facts: Record<string, BrowserFact>
  explanation: string | null
  conversationId: string | null
}

const stringMap = (v: unknown): v is Record<string, string> => isMap(v) && Object.values(v).every(x => typeof x === 'string')

function parseInput(body: unknown): Parsed | null {
  if (!isMap(body)) return null
  const allowed = ['connector', 'operation', 'declarationHash', 'checkerHash', 'factsVersion', 'target', 'change', 'facts', 'explanation', 'conversationId']
  if (Object.keys(body).some(k => !allowed.includes(k))) return null
  const c = body.connector
  if (!isMap(c) || Object.keys(c).length !== 2 || typeof c.id !== 'string' || !NAME_RE.test(c.id) || typeof c.version !== 'string' || !VERSION_RE.test(c.version)) return null
  if (typeof body.operation !== 'string' || !NAME_RE.test(body.operation)) return null
  if (typeof body.declarationHash !== 'string' || !HASH_RE.test(body.declarationHash)) return null
  if (typeof body.checkerHash !== 'string' || !HASH_RE.test(body.checkerHash)) return null
  if (!Number.isSafeInteger(body.factsVersion)) return null
  if (!stringMap(body.target) || !stringMap(body.change) || !isMap(body.facts)) return null
  let explanation: string | null = null
  if (body.explanation !== undefined) {
    if (!isPlainBrowserText(body.explanation, 2000, true)) return null
    explanation = body.explanation
  }
  let conversationId: string | null = null
  if (body.conversationId !== undefined) {
    if (typeof body.conversationId !== 'string' || !CONVERSATION_RE.test(body.conversationId)) return null
    conversationId = body.conversationId
  }
  return {
    connector: { id: c.id, version: c.version }, operation: body.operation, declarationHash: body.declarationHash, checkerHash: body.checkerHash,
    factsVersion: body.factsVersion as number, target: body.target, change: body.change, facts: body.facts as Record<string, BrowserFact>,
    explanation, conversationId,
  }
}

export function createBrowserPlanService(deps: BrowserPlanDeps) {
  const { companyData, transactions, clock, ids, tokenDigest, catalog, executionLookup, memberships } = deps
  const log = deps.log ?? console

  // The approved combinations, each checked: its declaration hashes to its row's hash and parses.
  let combinations: Combination[] | null = null
  function combos(): Combination[] {
    if (combinations) return combinations
    combinations = []
    for (const row of catalog.combinations()) {
      const fine = isMap(row) && typeof row.declaration === 'string' && typeof row.declarationHash === 'string' && typeof row.checkerHash === 'string'
        && Number.isSafeInteger(row.factsVersion) && (row.status === 'approved' || row.status === 'retired')
        && (row.minAppVersion === null || (typeof row.minAppVersion === 'string' && parseClientVersion(row.minAppVersion) !== null))
      if (!fine || hashCanonical(row.declaration) !== row.declarationHash) { log.warn('[browser-plans] an approved combination does not match its hash; left out'); continue }
      const parsed = parsePluginManifest(row.declaration)
      if (!parsed.ok || !parsed.value.browser || parsed.value.id !== row.connector || parsed.value.version !== row.version) {
        log.warn('[browser-plans] an approved combination does not parse; left out')
        continue
      }
      combinations.push({ row, label: parsed.value.label, browser: parsed.value.browser })
    }
    return combinations
  }
  const findCombination = (k: { id: string; version: string; declarationHash: string; checkerHash: string; factsVersion: number }) =>
    combos().find(c => c.row.connector === k.id && c.row.version === k.version && c.row.declarationHash === k.declarationHash
      && c.row.checkerHash === k.checkerHash && c.row.factsVersion === k.factsVersion) ?? null

  const plans = (companyId: string): BrowserPlanRepository => companyData.forCompany(companyId).browserPlans

  /** Whether the member holds a grant for the type that was given while they are a member this time. */
  function granted(member: Member, connector: string, operation: string, declarationHash: string): boolean {
    const g = plans(member.companyId).grant(member.userId, connector, operation, declarationHash)
    const joined = memberships.joinedAt(member.companyId, member.userId)
    return !!g && typeof joined === 'string' && g.grantedAt >= joined
  }

  /**
   * Every rule a step of a plan must pass now (register, approve, claim, permit), in this order:
   * the combination approved and not retired, the app new enough, the operation known and allowed by
   * the first version's rule, the company's setting, the AI stop, the member's grant.
   */
  function gate(member: Member, key: Parsed['connector'] & { declarationHash: string; checkerHash: string; factsVersion: number }, operationName: string, appVersion: string | undefined):
    Outcome<{ combination: Combination; operation: BrowserOperation }> {
    const combination = findCombination(key)
    if (!combination) return refuse('conflict', W.notApproved, { code: 'BROWSER_TYPE_NOT_APPROVED' })
    if (combination.row.status !== 'approved') return refuse('conflict', W.retired, { code: 'BROWSER_TYPE_RETIRED' })
    if (combination.row.minAppVersion !== null) {
      const app = parseClientVersion(appVersion)
      const min = parseClientVersion(combination.row.minAppVersion)
      if (!app || !min || compareClientVersions(app, min) < 0) return refuse('conflict', W.appTooOld, { code: 'BROWSER_APP_TOO_OLD' })
    }
    const operation = own(combination.browser.operations, operationName) ? combination.browser.operations[operationName] : undefined
    if (!operation) return refuse('bad-request', W.unknownOperation, { code: 'BROWSER_UNKNOWN_OPERATION' })
    const notYet = browserFirstVersionProblem(operation)
    if (notYet) return refuse('conflict', notYet, { code: 'BROWSER_OPERATION_NOT_YET' })
    const use = browserOperationsAllowed(combination.browser, deps.browserPolicy(member))
    if (!use.usable.includes(operationName)) return refuse('conflict', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
    if (browserAiStopped(deps.aiStops(member))) return refuse('conflict', W.aiStopped, { code: 'BROWSER_AI_STOPPED' })
    if (!granted(member, key.id, operationName, key.declarationHash)) return refuse('forbidden', W.notGranted, { code: 'BROWSER_TYPE_NOT_GRANTED' })
    return ok({ combination, operation })
  }

  const contentOf = (plan: BrowserPlanRow): PlanContent => JSON.parse(plan.content) as PlanContent
  const keyOf = (plan: BrowserPlanRow) => ({
    id: plan.connectorId, version: plan.connectorVersion, declarationHash: plan.declarationHash, checkerHash: plan.checkerHash, factsVersion: plan.factsVersion,
  })

  // --- time-outs, judged on every touch --------------------------------------------------------

  /** A draft / approved plan past its hour is closed. */
  function settlePlan(companyId: string, plan: BrowserPlanRow, now: number): BrowserPlanRow {
    if ((plan.state === 'draft' || plan.state === 'approved') && now >= ms(plan.expiresAt)) {
      plans(companyId).setPlanState(plan.id, plan.state, 'closed', { closedAt: iso(now), closeReason: 'expired' })
      return plans(companyId).plan(plan.id) as BrowserPlanRow
    }
    return plan
  }

  /** Move an execution to a final state: the lock goes (only this execution's) and the plan is done. */
  function finish(companyId: string, exec: BrowserExecutionRow, to: BrowserExecutionState, change: { voidReason?: string; confirmedBy?: string }, now: number): boolean {
    const repo = plans(companyId)
    if (!repo.setExecutionState(exec.id, exec.state, to, { ...change, settledAt: iso(now) })) return false
    repo.releaseLock(exec.lockKey, exec.id)
    repo.setPlanState(exec.planId, 'claimed', 'done', { closedAt: iso(now) })
    return true
  }

  /** A claimed execution without a permit for 2 minutes (or past its plan's hour) is void; a permitted one silent past permit + 5 s + 30 s is unknown. */
  function settleExecution(companyId: string, exec: BrowserExecutionRow, now: number): BrowserExecutionRow {
    const repo = plans(companyId)
    if (exec.state === 'claimed') {
      const plan = repo.plan(exec.planId)
      if (now >= ms(exec.claimedAt) + BROWSER_PLAN_TIMES.claimWithoutPermit || (plan && now >= ms(plan.expiresAt))) finish(companyId, exec, 'void', { voidReason: 'expired' }, now)
    } else if (exec.state === 'permitted' && exec.permittedAt && now >= ms(exec.permittedAt) + BROWSER_PLAN_TIMES.permit + BROWSER_PLAN_TIMES.grace) {
      repo.setExecutionState(exec.id, 'permitted', 'unknown', { settledAt: iso(now) })
    }
    return repo.execution(exec.id) as BrowserExecutionRow
  }

  // --- views ---------------------------------------------------------------------------------

  function executionView(exec: BrowserExecutionRow): BrowserExecutionView {
    return {
      id: exec.id, state: exec.state, claimedAt: exec.claimedAt, permittedAt: exec.permittedAt, settledAt: exec.settledAt,
      confirmableAt: exec.permittedAt ? iso(ms(exec.permittedAt) + BROWSER_PLAN_TIMES.permit + BROWSER_PLAN_TIMES.grace) : null,
      voidReason: exec.voidReason, confirmedBy: exec.confirmedBy,
    }
  }

  function planView(companyId: string, plan: BrowserPlanRow): BrowserPlanView {
    const content = contentOf(plan)
    const combination = findCombination(keyOf(plan))
    const operation = combination?.browser.operations[plan.operation]
    const exec = plans(companyId).executionOfPlan(plan.id)
    return {
      id: plan.id, state: plan.state, closeReason: plan.closeReason,
      connector: { id: plan.connectorId, version: plan.connectorVersion, label: combination?.label ?? plan.connectorId },
      operation: plan.operation, label: operation?.label ?? plan.operation, sharedNote: operation?.shared ?? null, delivers: operation?.delivers ?? 'unknown',
      account: plan.account, target: content.target, change: content.change, facts: content.facts, explanation: content.explanation,
      createdAt: plan.createdAt, expiresAt: plan.expiresAt, approvedAt: plan.approvedAt, contentHash: plan.contentHash,
      execution: exec ? executionView(exec) : null,
    }
  }

  /** The member's own plan (anyone else's, or another company's, is one that does not exist). */
  function ownPlan(member: Member, planId: string): BrowserPlanRow | null {
    if (!PLAN_ID_RE.test(planId)) return null
    const plan = plans(member.companyId).plan(planId)
    return plan && plan.userId === member.userId ? plan : null
  }
  const planMissing = (): Refusal => refuse('not-found', W.notFound, { code: 'BROWSER_PLAN_NOT_FOUND' })
  const execMissing = (): Refusal => refuse('not-found', W.executionNotFound, { code: 'BROWSER_EXECUTION_NOT_FOUND' })

  /** The member's own execution, by its id and its secret (both must match). */
  function ownExecution(member: Member, executionId: string, secret: string | undefined): BrowserExecutionRow | null {
    if (!EXEC_ID_RE.test(executionId) || typeof secret !== 'string' || secret.length < 32 || secret.length > 200) return null
    const exec = plans(member.companyId).execution(executionId)
    if (!exec || exec.userId !== member.userId || exec.secretHash !== tokenDigest.digest(secret)) return null
    return exec
  }

  function grantsView(member: Member): BrowserTypeGrantsView {
    const types = combos().filter(c => c.row.status === 'approved').flatMap(c => Object.entries(c.browser.operations)
      .filter(([, op]) => !browserFirstVersionProblem(op))
      .map(([operation, op]) => ({ connector: c.row.connector, version: c.row.version, declarationHash: c.row.declarationHash, operation, label: op.label })))
    const rows = plans(member.companyId).grants().filter(g => {
      const joined = memberships.joinedAt(member.companyId, g.userId)
      return typeof joined === 'string' && g.grantedAt >= joined
    })
    const people = deps.accounts.byIds([...new Set(rows.map(g => g.userId))])
    return {
      types,
      grants: rows.map(g => ({
        userId: g.userId, name: people.get(g.userId)?.name ?? null, connector: g.connectorId, operation: g.operation,
        declarationHash: g.declarationHash, grantedAt: g.grantedAt, grantedBy: g.grantedBy,
      })),
    }
  }

  return {
    /** POST /browser-plans: a candidate and its facts → a draft plan (its fixed content and hash). */
    register(member: Member, body: unknown, appVersion: string | undefined): Outcome<BrowserPlanView> {
      const input = parseInput(body)
      if (!input) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      const passed = gate(member, { ...input.connector, declarationHash: input.declarationHash, checkerHash: input.checkerHash, factsVersion: input.factsVersion }, input.operation, appVersion)
      if (!passed.ok) return passed
      const { combination, operation } = passed.value
      const values = { target: input.target, change: input.change }
      const planProblem = browserPlanProblem(operation, values)
      if (planProblem) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN', detail: planProblem })
      const factsProblem = browserFactsProblem(operation, input.factsVersion, input.facts, values)
      if (factsProblem) return refuse('bad-request', factsProblem, { code: 'BROWSER_FACTS_REFUSED' })
      const now = clock.nowMs()
      for (const fact of Object.values(input.facts)) {
        const at = ms(fact.readAt)
        if (at > now + 60_000 || at < now - BROWSER_PLAN_TIMES.factsMaxAge) return refuse('bad-request', W.factsStale, { code: 'BROWSER_FACTS_STALE' })
      }
      const account = browserFactsAccount(input.facts)
      if (!account) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      const before = browserFactsState(input.facts) ?? {}
      if (expectedAfter(before, operation, values) === null) return refuse('bad-request', W.cannotComeTrue, { code: 'BROWSER_CANNOT_COME_TRUE' })
      const id = `bp_${ids.newToken().slice(0, 32)}`
      const content: PlanContent = {
        format: 1, company: member.companyId, user: member.userId, conversation: input.conversationId,
        connector: { ...input.connector, declarationHash: input.declarationHash, checkerHash: input.checkerHash, factsVersion: input.factsVersion },
        operation: input.operation, account, target: input.target, change: input.change, facts: input.facts, explanation: input.explanation,
        createdAt: iso(now), expiresAt: iso(now + BROWSER_PLAN_TIMES.planLifetime),
      }
      let canonical: string
      try { canonical = canonicalJson(content) } catch { return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' }) }
      const row: BrowserPlanRow = {
        id, userId: member.userId, connectorId: combination.row.connector, connectorVersion: combination.row.version, operation: input.operation,
        declarationHash: input.declarationHash, checkerHash: input.checkerHash, factsVersion: input.factsVersion, account,
        content: canonical, contentHash: hashCanonical(canonical), state: 'draft', closeReason: null,
        createdAt: content.createdAt, expiresAt: content.expiresAt, approvedAt: null, closedAt: null,
      }
      plans(member.companyId).insertPlan(row)
      return ok(planView(member.companyId, row))
    },

    /** GET /browser-plans/:planId: the member's own plan. */
    get(member: Member, planId: string): Outcome<BrowserPlanView> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      return transactions.run(() => {
        const now = clock.nowMs()
        const plan = settlePlan(member.companyId, found, now)
        const exec = plans(member.companyId).executionOfPlan(plan.id)
        if (exec) settleExecution(member.companyId, exec, now)
        return ok(planView(member.companyId, plans(member.companyId).plan(plan.id) as BrowserPlanRow))
      })
    },

    /** POST /browser-plans/:planId/approve { contentHash }: the member approves the content they saw. */
    approve(member: Member, planId: string, body: unknown, appVersion: string | undefined): Outcome<BrowserPlanView> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      const shown = isMap(body) ? body.contentHash : undefined
      if (typeof shown !== 'string' || !HASH_RE.test(shown)) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_PLAN' })
      return transactions.run(() => {
        const now = clock.nowMs()
        const plan = settlePlan(member.companyId, found, now)
        if (plan.state === 'closed' && plan.closeReason === 'expired') return refuse('conflict', W.expired, { code: 'BROWSER_PLAN_EXPIRED' })
        if (plan.state !== 'draft') return refuse('conflict', W.notDraft, { code: 'BROWSER_PLAN_NOT_DRAFT' })
        if (shown !== plan.contentHash) return refuse('conflict', W.contentChanged, { code: 'CONTENT_CHANGED' })
        const passed = gate(member, keyOf(plan), plan.operation, appVersion)
        if (!passed.ok) return passed
        if (!plans(member.companyId).setPlanState(plan.id, 'draft', 'approved', { approvedAt: iso(now) })) return refuse('conflict', W.notDraft, { code: 'BROWSER_PLAN_NOT_DRAFT' })
        return ok(planView(member.companyId, plans(member.companyId).plan(plan.id) as BrowserPlanRow))
      })
    },

    /**
     * POST /browser-plans/:planId/cancel 「やめる」: a draft / approved plan closes; a claimed one whose
     * execution has no permit yet becomes void (nothing was sent). After a permit it may have been sent:
     * refused (the person confirms instead).
     */
    cancel(member: Member, planId: string): Outcome<BrowserPlanView> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      return transactions.run(() => {
        const now = clock.nowMs()
        const repo = plans(member.companyId)
        const plan = settlePlan(member.companyId, found, now)
        if (plan.state === 'draft' || plan.state === 'approved') {
          if (!repo.setPlanState(plan.id, plan.state, 'closed', { closedAt: iso(now), closeReason: 'cancelled' })) return refuse('conflict', W.notOpen, { code: 'BROWSER_PLAN_NOT_OPEN' })
        } else if (plan.state === 'claimed') {
          const exec = settleExecution(member.companyId, repo.executionOfPlan(plan.id) as BrowserExecutionRow, now)
          if (exec.state === 'permitted' || exec.state === 'unknown') return refuse('conflict', W.mayHaveSent, { code: 'BROWSER_MAY_HAVE_SENT' })
          if (exec.state !== 'claimed' || !finish(member.companyId, exec, 'void', { voidReason: 'cancelled' }, now)) return refuse('conflict', W.notOpen, { code: 'BROWSER_PLAN_NOT_OPEN' })
        } else return refuse('conflict', W.notOpen, { code: 'BROWSER_PLAN_NOT_OPEN' })
        return ok(planView(member.companyId, repo.plan(plan.id) as BrowserPlanRow))
      })
    },

    /**
     * POST /browser-plans/:planId/claim: once per plan, ever. Takes the target lock in the same
     * transaction and answers the execution's secret — the only time it is ever sent; the server keeps
     * its hash. A lost answer is not given again: the plan is consumed (a new plan is a new approval).
     */
    claim(member: Member, planId: string, appVersion: string | undefined): Outcome<BrowserClaim> {
      const found = ownPlan(member, planId)
      if (!found) return planMissing()
      return transactions.run(() => {
        const now = clock.nowMs()
        const repo = plans(member.companyId)
        const plan = settlePlan(member.companyId, found, now)
        if (plan.state === 'closed' && plan.closeReason === 'expired') return refuse('conflict', W.expired, { code: 'BROWSER_PLAN_EXPIRED' })
        if (plan.state !== 'approved') return refuse('conflict', W.notApprovedYet, { code: 'BROWSER_PLAN_NOT_APPROVED' })
        const passed = gate(member, keyOf(plan), plan.operation, appVersion)
        if (!passed.ok) return passed
        const { combination, operation } = passed.value
        const content = contentOf(plan)
        const lockKey = browserLockKey({
          company: member.companyId, host: combination.browser.host, account: plan.account, kind: (operation.lock as { kind: string }).kind,
          fields: operation.target, target: content.target,
        })
        // A holder that has timed out is settled first (and lets go when it was only claimed).
        const holder = repo.lockHolder(lockKey)
        if (holder) {
          const held = repo.execution(holder)
          if (held) settleExecution(member.companyId, held, now)
          if (repo.lockHolder(lockKey)) return refuse('conflict', W.targetBusy, { code: 'BROWSER_TARGET_BUSY' })
        }
        const executionId = `bx_${ids.newToken().slice(0, 32)}`
        const secret = ids.newToken()
        if (!repo.setPlanState(plan.id, 'approved', 'claimed', {})) return refuse('conflict', W.notApprovedYet, { code: 'BROWSER_PLAN_NOT_APPROVED' })
        repo.insertExecution({
          id: executionId, planId: plan.id, userId: member.userId, secretHash: tokenDigest.digest(secret), lockKey, state: 'claimed', voidReason: null,
          claimedAt: iso(now), permittedAt: null, settledAt: null, confirmedBy: null,
        })
        // Free a moment ago in this same synchronous transaction; a failure here rolls the whole claim back.
        if (!repo.takeLock(lockKey, executionId, iso(now))) throw new Error('browser plans: the target lock was taken during the claim')
        return ok({
          executionId, secret,
          plan: {
            planId: plan.id, companyId: member.companyId, connector: { id: plan.connectorId, version: plan.connectorVersion }, operation: plan.operation,
            account: plan.account, target: content.target, change: content.change, before: browserFactsState(content.facts) ?? {},
            approvedAt: plan.approvedAt as string, expiresAt: plan.expiresAt,
          },
        })
      })
    },

    /**
     * POST /browser-executions/:executionId/send-permit (the execution's secret in a header): once,
     * claimed → permitted, with every check in the same transaction; the permit time is the server's.
     */
    permit(member: Member, executionId: string, secret: string | undefined, appVersion: string | undefined): Outcome<BrowserPermit> {
      const found = ownExecution(member, executionId, secret)
      if (!found) return execMissing()
      return transactions.run(() => {
        const now = clock.nowMs()
        const repo = plans(member.companyId)
        const exec = settleExecution(member.companyId, found, now)
        if (exec.state === 'permitted' || exec.state === 'unknown' || exec.state === 'succeeded' || exec.state === 'failed' || exec.state.startsWith('confirmed_')) {
          return refuse('conflict', W.permitUsed, { code: 'BROWSER_PERMIT_USED' })
        }
        if (exec.state !== 'claimed') return refuse('conflict', W.executionClosed, { code: 'BROWSER_EXECUTION_CLOSED' })
        const plan = repo.plan(exec.planId) as BrowserPlanRow
        const passed = gate(member, keyOf(plan), plan.operation, appVersion)
        if (!passed.ok) {
          // A stop, a changed setting, a revoked grant, a retired combination or a too-old app ends this
          // execution (design memo §30.4: claimed → void): lifting it later never revives the same secret.
          finish(member.companyId, exec, 'void', { voidReason: GATE_VOID_REASONS[String(passed.body.code)] ?? 'refused' }, now)
          return passed
        }
        if (repo.lockHolder(exec.lockKey) !== exec.id) return refuse('conflict', W.executionClosed, { code: 'BROWSER_EXECUTION_CLOSED' })
        if (!repo.setExecutionState(exec.id, 'claimed', 'permitted', { permittedAt: iso(now) })) return refuse('conflict', W.permitUsed, { code: 'BROWSER_PERMIT_USED' })
        return ok({ permittedAt: iso(now), validMs: BROWSER_PLAN_TIMES.permit })
      })
    },

    /**
     * POST /api/browser-executions/report (the secret alone; the member may have left): succeeded only
     * from permitted / unknown; failed (stopped before sending) only from permitted; unknown from
     * permitted. The same report again is answered as before; a late one is kept; one that
     * contradicts a final state is refused and kept, marked.
     */
    report(secret: string | undefined, body: unknown): Outcome<BrowserReportAnswer> {
      if (typeof secret !== 'string' || secret.length < 32 || secret.length > 200) return refuse('unauthorized', 'Unauthorized')
      const where = executionLookup.bySecretHash(tokenDigest.digest(secret))
      if (!where) return refuse('unauthorized', 'Unauthorized')
      if (!isMap(body) || Object.keys(body).some(k => k !== 'result' && k !== 'reason')
        || !(BROWSER_REPORT_RESULTS as readonly unknown[]).includes(body.result)
        || (body.reason !== undefined && (typeof body.reason !== 'string' || !REASON_RE.test(body.reason)))) {
        return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_REPORT' })
      }
      const result = body.result as BrowserReportResult
      const reason = (body.reason as string | undefined) ?? null
      return transactions.run(() => {
        const now = clock.nowMs()
        const repo = plans(where.companyId)
        const found = repo.execution(where.executionId)
        if (!found) return refuse('unauthorized', 'Unauthorized')
        const exec = settleExecution(where.companyId, found, now)
        const state = exec.state
        let outcome: 'applied' | 'same' | 'recorded' | 'conflict'
        if (state === 'permitted') {
          const to: BrowserExecutionState = result
          outcome = to === 'unknown'
            ? (repo.setExecutionState(exec.id, 'permitted', 'unknown', { settledAt: iso(now) }) ? 'applied' : 'conflict')
            : (finish(where.companyId, exec, to, {}, now) ? 'applied' : 'conflict')
        } else if (state === 'unknown') {
          if (result === 'succeeded') outcome = finish(where.companyId, exec, 'succeeded', {}, now) ? 'applied' : 'conflict'
          else outcome = result === 'unknown' ? 'same' : 'recorded'
        } else if (state === 'claimed' || state === 'void') {
          // No permit was given: nothing can have been sent.
          outcome = 'conflict'
        } else {
          const contradicts = (result === 'succeeded' && (state === 'failed' || state === 'confirmed_not_done'))
            || (result === 'failed' && (state === 'succeeded' || state === 'confirmed_done'))
          outcome = contradicts ? 'conflict' : state === result ? 'same' : 'recorded'
        }
        repo.appendReport({ id: ids.newId(), executionId: exec.id, result, reason, outcome, stateBefore: state, at: iso(now) })
        if (outcome === 'conflict') {
          return refuse('conflict', state === 'claimed' || state === 'void' ? W.notPermitted : W.reportConflict, { code: 'BROWSER_REPORT_CONFLICT', state })
        }
        return ok({ state: (repo.execution(exec.id) as BrowserExecutionRow).state, outcome })
      })
    },

    /**
     * POST /browser-executions/:executionId/confirm { result: done | not_done }: the plan's member (or an
     * owner / admin once they left, or 24 hours after the permit) says whether it happened — only
     * after permit + 5 s + 30 s by the server's clock, never while its clock reads before the permit.
     */
    confirm(member: Member, executionId: string, body: unknown): Outcome<BrowserExecutionView> {
      if (!EXEC_ID_RE.test(executionId)) return execMissing()
      const repo = plans(member.companyId)
      const found = repo.execution(executionId)
      if (!found) return execMissing()
      const mine = found.userId === member.userId
      if (!mine && !hasFullAccess(member.role)) return execMissing()
      const result = isMap(body) && Object.keys(body).length === 1 ? body.result : undefined
      if (result !== 'done' && result !== 'not_done') return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_CONFIRM' })
      return transactions.run(() => {
        const now = clock.nowMs()
        const exec = settleExecution(member.companyId, found, now)
        if (!mine) {
          const left = memberships.roleOf(member.companyId, exec.userId) === null
          const late = exec.permittedAt !== null && now >= ms(exec.permittedAt) + BROWSER_PLAN_TIMES.adminConfirmAfter
          if (!left && !late) return refuse('forbidden', W.notYoursYet, { code: 'BROWSER_CONFIRM_NOT_YET' })
        }
        if (exec.state === 'claimed' || exec.state === 'void') return refuse('conflict', W.notPermitted, { code: 'BROWSER_NOT_PERMITTED' })
        if (isFinalExecutionState(exec.state)) return refuse('conflict', W.alreadySettled, { code: 'BROWSER_ALREADY_SETTLED' })
        const permitted = ms(exec.permittedAt as string)
        if (now < permitted) return refuse('conflict', W.clockBackwards, { code: 'BROWSER_CLOCK_BACKWARDS' })
        if (exec.state !== 'unknown' || now < permitted + BROWSER_PLAN_TIMES.permit + BROWSER_PLAN_TIMES.grace) {
          return refuse('conflict', W.tooEarly, { code: 'BROWSER_TOO_EARLY' })
        }
        const to: BrowserExecutionState = result === 'done' ? 'confirmed_done' : 'confirmed_not_done'
        if (!finish(member.companyId, exec, to, { confirmedBy: member.userId }, now)) return refuse('conflict', W.alreadySettled, { code: 'BROWSER_ALREADY_SETTLED' })
        return ok(executionView(repo.execution(exec.id) as BrowserExecutionRow))
      })
    },

    /**
     * GET /browser-executions-waiting?after=<executionId> 「確かめ待ち」: the member's own; an owner / admin
     * also everyone else's. A page of open executions (oldest claim first); `next` continues it.
     */
    waiting(member: Member, after?: string): Outcome<BrowserWaitingPage> {
      if (after !== undefined && !EXEC_ID_RE.test(after)) return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_CURSOR' })
      return transactions.run(() => {
        const now = clock.nowMs()
        const repo = plans(member.companyId)
        const full = hasFullAccess(member.role)
        const page = repo.executionsIn(['claimed', 'permitted', 'unknown'], full ? undefined : member.userId, { limit: WAITING_PAGE, after })
        const next = page.length === WAITING_PAGE ? page[page.length - 1].id : null
        const open = page
          .map(e => settleExecution(member.companyId, e, now))
          .filter(e => e.state === 'permitted' || e.state === 'unknown')
        return ok({ next, items: open.map(exec => {
          const plan = repo.plan(exec.planId) as BrowserPlanRow
          const content = contentOf(plan)
          const operation = findCombination(keyOf(plan))?.browser.operations[plan.operation]
          const confirmable = exec.permittedAt ? ms(exec.permittedAt) + BROWSER_PLAN_TIMES.permit + BROWSER_PLAN_TIMES.grace : null
          const mine = exec.userId === member.userId
          const forOthers = !mine && exec.permittedAt !== null
            && (memberships.roleOf(member.companyId, exec.userId) === null || now >= ms(exec.permittedAt) + BROWSER_PLAN_TIMES.adminConfirmAfter)
          return {
            executionId: exec.id, planId: plan.id, userId: exec.userId, connector: { id: plan.connectorId, version: plan.connectorVersion },
            operation: plan.operation, label: operation?.label ?? plan.operation, target: content.target, state: exec.state,
            permittedAt: exec.permittedAt, confirmableAt: confirmable === null ? null : iso(confirmable),
            canConfirm: exec.state === 'unknown' && confirmable !== null && now >= confirmable && (mine || forOthers),
          }
        }) })
      })
    },

    /** GET /browser-type-grants (owner/admin): the approved types and who may use them. */
    grants(member: Member): Outcome<BrowserTypeGrantsView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', W.manageForbidden)
      return ok(grantsView(member))
    },

    /** PUT /browser-type-grants/:userId { connector, operation, declarationHash, allowed } (owner/admin). */
    setGrant(member: Member, userId: string, body: unknown): Outcome<BrowserTypeGrantsView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', W.manageForbidden)
      if (memberships.roleOf(member.companyId, userId) === null) return refuse('not-found', W.memberNotFound)
      if (!isMap(body) || Object.keys(body).some(k => !['connector', 'operation', 'declarationHash', 'allowed'].includes(k))
        || typeof body.connector !== 'string' || typeof body.operation !== 'string' || typeof body.declarationHash !== 'string' || typeof body.allowed !== 'boolean') {
        return refuse('bad-request', W.badPlan, { code: 'BROWSER_BAD_GRANT' })
      }
      const { connector, operation, declarationHash, allowed } = body as { connector: string; operation: string; declarationHash: string; allowed: boolean }
      const repo = plans(member.companyId)
      if (!allowed) {
        repo.removeGrant(userId, connector, operation, declarationHash)
        return ok(grantsView(member))
      }
      const known = combos().some(c => c.row.status === 'approved' && c.row.connector === connector && c.row.declarationHash === declarationHash
        && own(c.browser.operations, operation) && !browserFirstVersionProblem(c.browser.operations[operation]))
      if (!known) return refuse('bad-request', W.unknownOperation, { code: 'BROWSER_UNKNOWN_OPERATION' })
      repo.saveGrant({ userId, connectorId: connector, operation, declarationHash, grantedBy: member.userId, grantedAt: clock.now() })
      return ok(grantsView(member))
    },

    /**
     * In removeMember's transaction (design memo §31.1): their draft / approved plans close, a claimed
     * execution becomes void (nothing was sent; its lock goes), permitted / unknown ones stay as they
     * are (their lock too: an owner / admin confirms them), and their grants go. Nothing comes back if
     * they are invited again.
     */
    memberLeft(companyId: string, userId: string): void {
      const repo = plans(companyId)
      const now = clock.nowMs()
      for (const plan of repo.openPlansOf(userId)) repo.setPlanState(plan.id, plan.state, 'closed', { closedAt: iso(now), closeReason: 'left' })
      for (const exec of repo.executionsIn(['claimed'], userId)) finish(companyId, exec, 'void', { voidReason: 'left' }, now)
      repo.removeGrantsOf(userId)
    },
  }
}

export type BrowserPlanService = ReturnType<typeof createBrowserPlanService>
