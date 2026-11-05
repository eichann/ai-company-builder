/**
 * A contract-3 connector's declared reads (plugins.md "Contract 3"): `read`,
 * `search` and `document`. The gate is an operation's, narrower — a person is
 * present (no execution run), the records switch, `active()`, the AI stops,
 * `who` through `mayRunAt`, the member's share of the pace — and every refusal
 * sends nothing. Then one call through the connector, with the actor's header;
 * the answer goes through the `returns` allow-list (`keepDeclared`), and one line
 * goes to the access log before anything is handed back: a read that cannot be
 * logged is not shown.
 *
 * Nothing of an answer is stored: not in the ledger, an operation record or the
 * log, which holds plain id inputs only. Personal values are shown to whoever
 * passed `who`; a sensitive field only comes through a call declaring it, so its
 * `who` is what guards it.
 */
import { CALL_CURSOR_RE, keepDeclared, citeLink, pointersOf, type KeptEntry, type PluginCall, type PluginCallRequest, type PluginCallListing, type PluginCalling } from '../../shared/core/plugins'
import type { AiRunFailureClass } from '../../shared/core/ai-runs'
import type { AgentStopPolicy, AgentStopToolKind } from '../../shared/types/agent-stop'
import type { PluginAccessLogEntry, PluginCallAnswer } from '../../shared/types/plugins'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import { requireFullAccess } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { EXTERNAL_ID_RE, type ConnectorResult, type PluginConnector } from './plugin-connector'
import { notActive, type OperationActor } from './plugin-operation-common'
import type { PluginOperationService } from './plugin-operations'
import type { ActivePlugin, PluginService } from './plugins'
import { PLUGINS_FORBIDDEN, PLUGIN_NOT_FOUND } from './plugin-service-common'
import { RECORDS_DISABLED } from './records'

export const ACCESS_LOG_RETENTION_DAYS = 365
const ACCESS_LOG_LIMIT = 200
const ACCESS_LOG_CURSOR_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]{1,20}Z~[A-Za-z0-9-]{1,64}$/
const TEXT_INPUT_MAX = 2000
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.+Z-]{1,30})?$/
const EMAIL_RE = /^[^\s@]{1,100}@[^\s@]{1,200}$/
/** How long a checked account stands: a service's limit is small, and every read asking it too would halve it. */
const ACCOUNT_CHECK_MS = 5 * 60_000
const ACTOR_PREFIX = 'acb_member_'
/** One member's share of the connection's pace: a looping AI leaves the rest for the team. */
const MEMBER_SHARE = 4
/** The same pace when the declaration names none. */
const DEFAULT_PER_MINUTE = 60
/** The tool kinds whose stop ends a read: this is the AI reaching a service outside, over the web. */
const STOPPED_BY: readonly AgentStopToolKind[] = ['mcp-external', 'web']

type Part = 'page' | 'list' | 'search' | null
export type CallActor = OperationActor

export interface PluginCallDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  plugins: Pick<PluginService, 'active'>
  connector: Pick<PluginConnector, 'callDeclared'>
  gate: PluginOperationService['gate']
  /** The stops in force for this member: the company's and their own, the whole AI or a tool kind. */
  aiStops: (member: Member) => AgentStopPolicy
  /** Identifies the key's current value (`<keyId>.<secretUpdatedAt>`); null: no such key. */
  keyStamp: (companyId: string, keyId: string) => string | null
  companyIds: () => string[]
  /** The AI's reads also go to the AI action log. */
  recordAiRead: (companyId: string, userId: string, e: { conversationId: string | null; call: string; host: string; path: string; status: number | null; ok: boolean }) => void
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => (map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined)
const badInput = (error: string) => refuse('bad-request', error, { code: 'CALL_INPUT_INVALID' })

/** The request a call's part makes: a read is GET, a search POST, a document's page and list GET and its search POST. */
function requestOf(call: PluginCall, part: unknown): { request: PluginCallRequest; listing: PluginCallListing | null; method: 'GET' | 'POST'; part: Part } | null {
  if (call.kind === 'read') return part === undefined || part === null ? { request: call, listing: null, method: 'GET', part: null } : null
  if (call.kind === 'search') return part === undefined || part === null ? { request: call, listing: call, method: 'POST', part: null } : null
  if (call.kind !== 'document') return null
  if (part === 'page') return { request: call.page, listing: null, method: 'GET', part }
  if (part === 'list' && call.list) return { request: call.list, listing: call.list, method: 'GET', part }
  if (part === 'search' && call.search) return { request: call.search, listing: call.search, method: 'POST', part }
  return null
}

function inputProblem(request: PluginCallRequest, input: Record<string, unknown>): string | null {
  for (const name of Object.keys(input)) if (!own(request.inputs, name)) return `入力「${name}」はこの呼び出しにありません`
  for (const [name, rule] of Object.entries(request.inputs)) {
    const v = input[name]
    if (v === undefined || v === null) { if (rule.required) return `入力「${name}」が要ります`; continue }
    const fits = rule.kind === 'id' ? typeof v === 'string' && EXTERNAL_ID_RE.test(v)
      : rule.kind === 'text' ? typeof v === 'string' && v !== '' && v.length <= TEXT_INPUT_MAX
        : rule.kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
          : rule.kind === 'boolean' ? typeof v === 'boolean'
            : typeof v === 'string' && DATE_RE.test(v)
    if (!fits) return `入力「${name}」の形が違います`
  }
  return null
}

/** The core's failure class of what the connector answered: the declaration's table first. */
function failureOf(r: Extract<ConnectorResult, { ok: false }>, errors: PluginCalling['errors']): AiRunFailureClass {
  const declared = r.code ? own(errors?.map, r.code) : undefined
  if (declared) return declared
  if (r.kind === 'refused') return r.status === 401 || r.status === 403 ? 'permission' : 'bad-input'
  return 'temporary'
}

/** The plain id inputs of a read: what the log may keep of them. A search word, or an id declared personal, is not. */
function loggedInputs(request: PluginCallRequest, input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((e): e is [string, string] => {
    const rule = own(request.inputs, e[0])
    return rule?.kind === 'id' && rule.dataClass === 'normal' && typeof e[1] === 'string'
  }))
}

export function createPluginCalls(deps: PluginCallDeps) {
  const { companyData, clock, plugins, connector, gate } = deps
  /** connection → the key it was last seen right with, and when. A new key value is checked at once. */
  const accountSeen = new Map<string, { stamp: string; at: number }>()
  /** company | connection | member → the reads of the last minute. Refused ones do not count, so it stays bounded. */
  const memberReads = new Map<string, number[]>()

  /** The member's share of the pace: over it, refused before anything goes out, and no line in the log. */
  function overMemberShare(member: Member, plugin: ActivePlugin): boolean {
    const now = clock.nowMs()
    const key = `${member.companyId}|${plugin.connectionId}|${member.userId}`
    const recent = (memberReads.get(key) ?? []).filter(t => t > now - 60_000)
    const over = recent.length >= Math.ceil((plugin.manifest.calling?.limits?.perMinute ?? DEFAULT_PER_MINUTE) / MEMBER_SHARE)
    memberReads.set(key, over ? recent : [...recent, now])
    return over
  }

  /** The AI's stops, as a reason: the whole AI (company or member) or a tool kind that covers this read. */
  function aiStop(member: Member, actor: CallActor): string | null {
    if (actor.kind !== 'ai') return null
    const stops = deps.aiStops(member)
    return stops.all || stops.tools.some(t => STOPPED_BY.includes(t)) ? 'ai-stopped' : null
  }

  /**
   * The account and environment of the key. The package states the environment it must
   * be (`expected_environment`): stated and the same, or nothing reads. The account is
   * bound on first sight; another one → refused. Asked as `system`.
   */
  async function accountRefusal(member: Member, plugin: ActivePlugin, precheck: () => Promise<string | null>) {
    const info = plugin.manifest.accountInfo
    if (!info?.idField || !info.environmentField) return refuse('conflict', 'つなぎ先のアカウントを確かめられません', { code: 'ACCOUNT_UNREADABLE' })
    if (!info.expectedEnvironment) return refuse('conflict', 'このつなぎ先は、どの環境につなぐかが決められていないため読めません', { code: 'ENVIRONMENT_NOT_STATED' })
    const now = clock.nowMs()
    const stamp = deps.keyStamp(member.companyId, plugin.keyId)
    const seenBefore = accountSeen.get(plugin.connectionId)
    if (plugin.accountId !== null && stamp !== null && seenBefore?.stamp === `${stamp}.${info.expectedEnvironment}` && now - seenBefore.at < ACCOUNT_CHECK_MS) return null
    const r = await connector.callDeclared(member.companyId, plugin, { method: 'GET', path: info.path, actor: { member: 'system', email: null } }, precheck)
    const id = r.ok && isObj(r.body) ? r.body[info.idField] : undefined
    const environment = r.ok && isObj(r.body) ? r.body[info.environmentField] : undefined
    if (typeof id !== 'string' || typeof environment !== 'string' || !EXTERNAL_ID_RE.test(id) || !EXTERNAL_ID_RE.test(environment)) {
      return refuse('conflict', 'つなぎ先のアカウントを確かめられません', { code: 'ACCOUNT_UNREADABLE' })
    }
    if (environment !== info.expectedEnvironment) return refuse('conflict', 'つなぎ先の環境が、決められたものと違います。管理者に確かめてください', { code: 'ENVIRONMENT_MISMATCH' })
    const seen = `${id}.${environment}`
    const changed = () => refuse('conflict', 'つなぎ先のアカウントが変わっています。管理者が新しいつなぎ先として始めるまで読めません', { code: 'ACCOUNT_CHANGED' })
    if (plugin.accountId !== null && plugin.accountId !== seen) return changed()
    if (plugin.accountId === null) {
      const repo = companyData.forCompany(member.companyId).plugins
      const bound = repo.bindAccount(plugin.connectorId, plugin.connectionId, seen, {
        id: deps.ids.newId(), pluginId: plugin.connectorId, action: 'account', at: clock.now(), by: 'connector', change: JSON.stringify({ connectionId: plugin.connectionId, accountId: seen }),
      })
      if (!bound && repo.install(plugin.connectorId)?.accountId !== seen) return changed()
    }
    if (stamp !== null) accountSeen.set(plugin.connectionId, { stamp: `${stamp}.${info.expectedEnvironment}`, at: now })
    return null
  }

  /** The address the service may be told: the member's own, verified by their Google grant; else none. */
  function verifiedEmail(member: Member): string | null {
    const grant = companyData.forCompany(member.companyId).connectors.grant('google', member.userId)
    return grant?.status === 'active' && EMAIL_RE.test(grant.accountEmail) ? grant.accountEmail : null
  }

  return {
    /** POST …/plugins/:pluginId/calls/:call { part?, input?, cursor? } — a person (session) or their AI (record token). */
    async read(member: Member, actor: CallActor, pluginId: string, name: string, body: unknown): Promise<Outcome<PluginCallAnswer>> {
      const stepRefusal = await gate.callStepRefusal(member, actor, pluginId, name)
      if (stepRefusal) return stepRefusal
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const active = await plugins.active(member.companyId, pluginId)
      if (!active.ok) return notActive(active.problem)
      if (aiStop(member, actor)) return refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' })
      const plugin = active.plugin
      const call = own(plugin.manifest.calls, name)
      if (!call) return refuse('not-found', 'この呼び出しはありません', { code: 'CALL_NOT_FOUND' })
      if (!gate.mayRunAt(member, actor, call.who, {}, '', { pluginId, recordId: null })) {
        return refuse('forbidden', actor.kind === 'ai' && !call.who.includes('ai') ? 'この呼び出しは AI からはできません' : 'この呼び出しをする権限がありません', { code: 'NOT_ALLOWED' })
      }
      if (!isObj(body)) return badInput('{ input } の形で送ってください')
      const target = requestOf(call, body.part)
      if (!target) return refuse('bad-request', 'この呼び出しでは使えません', { code: 'CALL_NOT_READABLE' })
      const input = body.input === undefined ? {} : body.input
      if (!isObj(input)) return badInput('input は { 名前: 値 } の形です')
      const problem = inputProblem(target.request, input)
      if (problem) return badInput(problem)
      const cursor = body.cursor
      if (cursor !== undefined && (typeof cursor !== 'string' || !CALL_CURSOR_RE.test(cursor) || !target.listing?.cursor)) return badInput('cursor は続きのある一覧だけです')
      if (overMemberShare(member, plugin)) return refuse('rate-limited', '読む回数が多すぎます。少し待ってから、もう一度お試しください', { code: 'CALL_PACED' })

      // The checks repeated before every attempt; a stop there is a refusal, not a read.
      const repeated = gate.precheckFor(member, actor, plugin, call.who, null, '', () => true)
      let stopped: string | null = null
      const precheck = async () => { stopped = aiStop(member, actor) ?? await repeated(); return stopped }
      const stoppedRefusal = (reason: string | null) => refuse('conflict', 'いまは読めません', { code: 'CALL_STOPPED', reason })
      const account = await accountRefusal(member, plugin, precheck)
      if (account) return stopped ? stoppedRefusal(stopped) : account

      const { id, ...others } = input
      const outsideValues: Record<string, unknown> = Object.fromEntries(Object.entries(others).filter(([, v]) => v !== undefined && v !== null))
      if (cursor !== undefined) outsideValues[target.listing!.cursor!.param] = cursor
      const out = { sent: false }
      const r = await connector.callDeclared(member.companyId, plugin, {
        method: target.method, path: target.request.path, ...(typeof id === 'string' ? { id } : {}),
        ...(target.method === 'GET' ? { query: Object.fromEntries(Object.entries(outsideValues).map(([k, v]) => [k, String(v)])) } : { body: outsideValues }),
        actor: { member: `${ACTOR_PREFIX}${member.userId}`, email: verifiedEmail(member) }, onSend: () => { out.sent = true },
      }, precheck)

      const empty = { call: name, part: target.part, data: null, items: null, next: null, cite: null }
      let answer: PluginCallAnswer
      let returned: ReturnType<typeof pointersOf> = { ids: [], more: 0 }
      if (r.ok) {
        const kept = keepDeclared(r.body, target.request.returns, target.listing?.items ?? null)
        let { dropped } = kept
        if (kept.items) returned = pointersOf(kept.items, target.request.returns)
        // The next page's cursor reaches the AI and a URL: only its own shape, else the list ends here.
        const rawNext = target.listing?.cursor && isObj(r.body) ? r.body[target.listing.cursor.next] : undefined
        const next = typeof rawNext === 'string' && CALL_CURSOR_RE.test(rawNext) ? rawNext : null
        if (next === null && rawNext !== undefined && rawNext !== null) dropped++
        // The link travels only as `cite`, checked: the copy among the fields would be the same value unchecked.
        const citeField = target.part === 'page' && call.kind === 'document' ? call.cite : null
        const cite = citeField && isObj(r.body) ? citeLink(r.body[citeField], plugin.manifest.baseUrl.host) : null
        const data = kept.data as KeptEntry | null
        if (citeField && data && Object.prototype.hasOwnProperty.call(data, citeField)) {
          delete data[citeField]
          if (cite === null) dropped++
        }
        answer = { outcome: 'ok', ...empty, data, items: kept.items, next, cite, dropped }
      } else {
        answer = { outcome: 'failed', ...empty, dropped: 0, failure: failureOf(r, plugin.manifest.calling?.errors ?? null), ...(r.code ? { code: r.code } : {}) }
      }

      // One line for a read that went out, however it ended, also one stopped before its next attempt. It
      // may throw: a read that cannot be logged is not shown. Nothing went out (stopped first, the pace): no line.
      if (out.sent) {
        handle.plugins.addAccessLog({
          id: deps.ids.newId(), pluginId, call: target.part ? `${name}.${target.part}` : name, userId: member.userId, actorKind: actor.kind === 'ai' ? 'ai' : 'human',
          conversationId: actor.conversationId ?? null, runId: actor.runId ?? null,
          refs: JSON.stringify({ input: loggedInputs(target.request, input), returned: returned.ids, more: returned.more }),
          status: stopped ? 'stopped' : answer.outcome === 'ok' ? 'ok' : answer.failure!, dropped: answer.dropped, at: clock.now(),
        })
      }
      if (out.sent && actor.kind === 'ai') {
        deps.recordAiRead(member.companyId, member.userId, {
          conversationId: actor.conversationId ?? null, call: `${pluginId}/${name}`, host: plugin.manifest.baseUrl.host, path: target.request.path, status: r.ok ? r.status : r.status ?? null, ok: r.ok,
        })
      }
      return stopped ? stoppedRefusal(stopped) : ok(answer)
    },

    /**
     * GET …/plugins/:pluginId/access-log?before=<next>&limit=<n> — owner / admin, newest
     * first, at most 200 a page; `next` is the `before` of the next page, null at the end.
     */
    accessLog(member: Member, pluginId: string, page: { before?: string; limit?: string } = {}): Outcome<{ entries: PluginAccessLogEntry[]; next: string | null }> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const repo = companyData.forCompany(member.companyId).plugins
      if (typeof pluginId !== 'string' || pluginId.length > 40 || !repo.install(pluginId)) return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      if (page.before !== undefined && !ACCESS_LOG_CURSOR_RE.test(page.before)) return refuse('bad-request', 'before の形が違います', { code: 'BAD_CURSOR' })
      const limit = page.limit === undefined ? ACCESS_LOG_LIMIT : Number(page.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > ACCESS_LOG_LIMIT) return refuse('bad-request', `limit は 1〜${ACCESS_LOG_LIMIT} です`, { code: 'BAD_LIMIT' })
      const before = page.before === undefined ? null : { at: page.before.split('~')[0], id: page.before.split('~')[1] }
      const rows = repo.accessLog(pluginId, limit + 1, before)
      const shown = rows.slice(0, limit)
      const last = shown.at(-1)
      return ok({
        entries: shown.map(({ at, userId, actorKind, call, refs, status, dropped, conversationId, runId }) =>
          ({ at, userId, actorKind, call, refs: JSON.parse(refs) as PluginAccessLogEntry['refs'], status, dropped, conversationId, runId })),
        next: rows.length > limit && last ? `${last.at}~${last.id}` : null,
      })
    },

    /** Removes rows past the year, every company through its own handle (`lib/plugin-access-log-retention.ts`). */
    cleanupAccessLog(): { deleted: number } {
      const keepFrom = new Date(clock.nowMs() - ACCESS_LOG_RETENTION_DAYS * 86_400_000).toISOString()
      let deleted = 0
      for (const companyId of deps.companyIds()) deleted += companyData.forCompany(companyId).plugins.pruneAccessLog(keepFrom)
      return { deleted }
    },
  }
}

export type PluginCallService = ReturnType<typeof createPluginCalls>
