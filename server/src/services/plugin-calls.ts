/**
 * A contract-3 connector's declared reads (plugins.md "Contract 3"): `read`,
 * `search` and `document`. The gate is an operation's — the step's run, the
 * records switch, `active()`, the AI stop, `via`, `who` through `mayRunAt` — and
 * every refusal sends nothing. Then one call through the connector, with the
 * actor's header; the answer goes through the `returns` allow-list
 * (`keepDeclared`), and one line goes to the access log before anything is handed
 * back: a read that cannot be logged is not shown.
 *
 * Nothing of an answer is stored: not in the ledger, an operation record or the
 * log, which holds plain id inputs only. Personal values are shown to whoever
 * passed `who`; a sensitive field only comes through a call declaring it, so its
 * `who` is what guards it.
 */
import { keepDeclared, citeLink, type KeptEntry, type PluginCall, type PluginCallRequest, type PluginCallListing, type PluginCalling } from '../../shared/core/plugins'
import { viaOf } from '../../shared/core/record-types'
import type { AiRunFailureClass } from '../../shared/core/ai-runs'
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
import { callVia, NOT_VIA } from './record-engine'
import { RECORDS_DISABLED } from './records'

export const ACCESS_LOG_RETENTION_DAYS = 365
const ACCESS_LOG_LIMIT = 200
const TEXT_INPUT_MAX = 2000
const CURSOR_MAX = 500
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.+Z-]{1,30})?$/
const EMAIL_RE = /^[^\s@]{1,100}@[^\s@]{1,200}$/
/** How long a checked account stands: a service's limit is small, and every read asking it too would halve it. */
const ACCOUNT_CHECK_MS = 5 * 60_000
const ACTOR_PREFIX = 'acb_member_'

type Part = 'page' | 'list' | 'search' | null
export type CallActor = OperationActor

export interface PluginCallDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  plugins: Pick<PluginService, 'active'>
  connector: Pick<PluginConnector, 'callDeclared'>
  gate: PluginOperationService['gate']
  aiStopped: (companyId: string) => boolean
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

export function createPluginCalls(deps: PluginCallDeps) {
  const { companyData, clock, plugins, connector, gate } = deps
  /** connection → when its account was last seen right. */
  const accountSeen = new Map<string, number>()

  /** The account and environment of the key, bound on first sight; another one → refused. Asked as `system`. */
  async function accountRefusal(member: Member, plugin: ActivePlugin, precheck: () => Promise<string | null>) {
    const info = plugin.manifest.accountInfo
    if (!info?.idField || !info.environmentField) return refuse('conflict', 'つなぎ先のアカウントを確かめられません', { code: 'ACCOUNT_UNREADABLE' })
    const now = clock.nowMs()
    if (plugin.accountId !== null && now - (accountSeen.get(plugin.connectionId) ?? -Infinity) < ACCOUNT_CHECK_MS) return null
    const r = await connector.callDeclared(member.companyId, plugin, { method: 'GET', path: info.path, actor: { member: 'system', email: null } }, precheck)
    const id = r.ok && isObj(r.body) ? r.body[info.idField] : undefined
    const environment = r.ok && isObj(r.body) ? r.body[info.environmentField] : undefined
    if (typeof id !== 'string' || typeof environment !== 'string' || !EXTERNAL_ID_RE.test(id) || !EXTERNAL_ID_RE.test(environment)) {
      return refuse('conflict', 'つなぎ先のアカウントを確かめられません', { code: 'ACCOUNT_UNREADABLE' })
    }
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
    accountSeen.set(plugin.connectionId, now)
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
      if (actor.kind === 'ai' && deps.aiStopped(member.companyId)) return refuse('forbidden', '管理者が AI の利用を一時停止しています。', { code: 'ACB_STOPPED' })
      const plugin = active.plugin
      const call = own(plugin.manifest.calls, name)
      if (!call) return refuse('not-found', 'この呼び出しはありません', { code: 'CALL_NOT_FOUND' })
      if (!viaOf({}).includes(callVia(actor))) return refuse('forbidden', NOT_VIA.error, { code: NOT_VIA.code })
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
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > CURSOR_MAX || !target.listing?.cursor)) return badInput('cursor は続きのある一覧だけです')

      // The checks repeated before every attempt; a stop there is a refusal, not a read.
      const repeated = gate.precheckFor(member, actor, plugin, call.who, null, '', () => true)
      let stopped: string | null = null
      const precheck = async () => { stopped = await repeated(); return stopped }
      const account = await accountRefusal(member, plugin, precheck)
      if (account) return account

      const { id, ...others } = input
      const outsideValues: Record<string, unknown> = Object.fromEntries(Object.entries(others).filter(([, v]) => v !== undefined && v !== null))
      if (cursor !== undefined) outsideValues[target.listing!.cursor!.param] = cursor
      const r = await connector.callDeclared(member.companyId, plugin, {
        method: target.method, path: target.request.path, ...(typeof id === 'string' ? { id } : {}),
        ...(target.method === 'GET' ? { query: Object.fromEntries(Object.entries(outsideValues).map(([k, v]) => [k, String(v)])) } : { body: outsideValues }),
        actor: { member: `${ACTOR_PREFIX}${member.userId}`, email: verifiedEmail(member) },
      }, precheck)

      if (stopped) return refuse('conflict', 'いまは読めません', { code: 'CALL_STOPPED', reason: stopped })

      const empty = { call: name, part: target.part, data: null, items: null, next: null, cite: null }
      let answer: PluginCallAnswer
      if (r.ok) {
        const kept = keepDeclared(r.body, target.request.returns, target.listing?.items ?? null)
        const next = target.listing?.cursor && isObj(r.body) && typeof r.body[target.listing.cursor.next] === 'string' ? r.body[target.listing.cursor.next] as string : null
        const cite = target.part === 'page' && call.kind === 'document' && call.cite && isObj(r.body) ? citeLink(r.body[call.cite], plugin.manifest.baseUrl.host) : null
        answer = { outcome: 'ok', ...empty, data: kept.data as KeptEntry | null, items: kept.items, next, cite, dropped: kept.dropped }
      } else {
        answer = { outcome: 'failed', ...empty, dropped: 0, failure: failureOf(r, plugin.manifest.calling?.errors ?? null), ...(r.code ? { code: r.code } : {}) }
      }

      const refs = Object.fromEntries(Object.entries(input).filter(([k, v]) => {
        const rule = own(target.request.inputs, k)
        return rule?.kind === 'id' && rule.dataClass === 'normal' && typeof v === 'string'
      }))
      const at = clock.now()
      handle.plugins.addAccessLog({
        id: deps.ids.newId(), pluginId, call: target.part ? `${name}.${target.part}` : name, userId: member.userId, actorKind: actor.kind === 'ai' ? 'ai' : 'human',
        conversationId: actor.conversationId ?? null, runId: actor.runId ?? null, refs: JSON.stringify(refs),
        status: answer.outcome === 'ok' ? 'ok' : answer.failure!, dropped: answer.dropped, at,
      }, new Date(clock.nowMs() - ACCESS_LOG_RETENTION_DAYS * 86_400_000).toISOString())
      if (actor.kind === 'ai') {
        deps.recordAiRead(member.companyId, member.userId, {
          conversationId: actor.conversationId ?? null, call: `${pluginId}/${name}`, host: plugin.manifest.baseUrl.host, path: target.request.path, status: r.ok ? r.status : r.status ?? null, ok: r.ok,
        })
      }
      return ok(answer)
    },

    /** GET …/plugins/:pluginId/access-log — owner / admin. */
    accessLog(member: Member, pluginId: string): Outcome<{ entries: PluginAccessLogEntry[] }> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const repo = companyData.forCompany(member.companyId).plugins
      if (typeof pluginId !== 'string' || pluginId.length > 40 || !repo.install(pluginId)) return refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      return ok({
        entries: repo.accessLog(pluginId, ACCESS_LOG_LIMIT).map(({ at, userId, actorKind, call, refs, status, dropped, conversationId, runId }) =>
          ({ at, userId, actorKind, call, refs: JSON.parse(refs) as Record<string, string>, status, dropped, conversationId, runId })),
      })
    },
  }
}

export type PluginCallService = ReturnType<typeof createPluginCalls>
