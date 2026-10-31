/**
 * The key broker's relay (K4, .claude/rules/key-broker.md):
 * `/api/broker/<service>/<upstream path>` with an `acb_tok_` token in place of
 * the service's API key. Token check → (stop / caps: K5) → the key the
 * service's rule picks → the real key swapped in → HTTPS to the key's
 * destination host, the response streamed back.
 *
 * What it guarantees:
 * - The real key never leaves except in the one upstream header the service
 *   uses (`BrokerServiceInfo.credential`). It is in no answer (error bodies are
 *   searched and it is replaced), no log line, no table. A real-looking key
 *   sent by the client is refused, not forwarded.
 * - Only the key's destinations: host (exact), path prefixes, models. Paths
 *   with `..`, encoded slashes or backslashes are refused. Redirects are not
 *   followed; a `Location` / Gemini `x-goog-upload-url` to an allowed host is
 *   rewritten to come back through the relay, any other is dropped.
 * - Private / internal addresses are refused after DNS resolution (the
 *   adapter connects to the address it checked) unless the company named the
 *   host as an exception.
 * - Request size and waiting time are bounded.
 * - Generic services (K9) work the same way: the company's definition fixes
 *   the one https host (and a base path put before every path) and the header
 *   the key travels in (`relayCredentialValue`); the client's copy of that
 *   header is never forwarded, and no header or query value that carries the
 *   token is either.
 * This file is long because each step is one guard of the same request; it stays whole so
 * the order of the guards reads top to bottom.
 */
import {
  BROKER_NO_KEY_PLACEHOLDER,
  brokerNoKeyMessage,
  BROKER_TOKEN_PREFIX,
  brokerRelayReadOnlyAllows,
  builtinBrokerService,
  isValidBrokerServiceName,
  looksLikeBrokerToken,
  normalizeBrokerModel,
  relayCredentialOf,
  relayCredentialValue,
  type BrokerRelayDefinition,
  type BrokerServiceInfo,
} from '../../shared/core/key-broker'
import { checkUpstreamPath } from '../../shared/core/upstream-path'
import type { AgentToolEvent, GuardReason, ToolDecision } from '../../shared/types/agent-events'
import type { BrokerKeyRepository } from '../ports/key-broker'
import type { UpstreamClient, UpstreamFailure } from '../ports/upstream'
import type { BrokerGrant, BrokerTokenHolder, BrokerTokenRefusal, BrokerTokenService } from './broker-tokens'
import type { BrokerVault } from './broker-vault'
import type { KeyBrokerService } from './key-broker'

export interface BrokerRelayDeps {
  brokerTokens: BrokerTokenService
  brokerVault: BrokerVault
  keyBroker: KeyBrokerService
  upstream: UpstreamClient
  /** Daily use per key and member (caps). */
  brokerKeys: BrokerKeyRepository
  /** One record per call in the AI action log (agent_events), as the server observed it. */
  record: (companyId: string, userId: string, event: Omit<AgentToolEvent, 'version' | 'id' | 'callId' | 'at'>) => void
  /** The caps' day of a moment: YYYY-MM-DD. */
  dayOf: (ms: number) => string
  nowMs: () => number
  maxRequestBytes: number
  headersTimeoutMs: number
  log?: Pick<Console, 'warn'>
  /** The emergency stop (M2, agent-stop.md): the whole AI of this company is stopped → every call is refused. */
  companyStopped?: (companyId: string) => boolean
  /**
   * A connection managed by a connector plugin (plugins.md "The relay and a
   * managed connection"): null = not managed. Asked on every call.
   */
  managedConnection?: (companyId: string, userId: string, service: string) => ManagedRelayPolicy | null
}

/** What the relay may still do for a service whose connection a plugin manages. */
export interface ManagedRelayPolicy {
  /** The declared search paths (POSTs that only read), exact. */
  searchPaths: string[]
  /** The member is in the read scope of every connection that manages the service (an empty scope: nobody). */
  mayRead: boolean
  /** The plugins' connections (logged with each call). */
  connectionIds: string[]
}

/** A path as a pattern for the log: outside ids (digits, long hex / uuid-like segments) become `{id}`. */
export function relayPathPattern(path: string): string {
  return path.split('/').map(seg => /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /@/.test(seg) ? '{id}' : seg).join('/')
}

export interface RelayRequest {
  service: string
  method: string
  /** What follows /api/broker/<service>: the path as received (percent-encoded) and the query. */
  pathAndQuery: string
  /** Lower-case names. */
  headers: Array<[string, string]>
  body: AsyncIterable<Uint8Array> | null
  signal: AbortSignal
  /** How members reach this server (`https://acb.example.com`), for rewritten upload / redirect URLs. */
  publicBase: string
}

export interface RelayAnswer {
  status: number
  headers: Array<[string, string]>
  body: AsyncIterable<Uint8Array> | Uint8Array | null
  /** For the call's record (K5): who and what, never a key or a body. */
  grant: BrokerGrant | null
  /** Set when the relay itself answered (a refusal or an upstream failure). */
  code?: RelayErrorCode
}

/** What the call's record says besides the answer (filled in as the relay goes). */
interface CallMeta {
  who?: BrokerTokenHolder
  grant?: BrokerGrant
  host?: string
  path?: string
  /** A plugin-managed service: its connection(s), for the log. */
  connection?: string
  model?: string
  bytesIn: number
  /** The request reached the provider (counted for the caps). */
  forwarded: boolean
}

/** Error codes the relay answers itself (JSON readable by the Gemini, OpenAI and Anthropic SDKs). */
export type RelayErrorCode =
  | 'ACB_NO_TOKEN' | 'ACB_REAL_KEY_REFUSED' | 'ACB_TOKEN_INVALID' | 'ACB_NOT_MEMBER' | 'ACB_NO_KEY' | 'ACB_BROKER_OFF'
  | 'ACB_UNKNOWN_SERVICE' | 'ACB_BAD_PATH' | 'ACB_DESTINATION_NOT_ALLOWED' | 'ACB_PRIVATE_ADDRESS' | 'ACB_TOO_LARGE'
  | 'ACB_UPSTREAM_UNREACHABLE' | 'ACB_UPSTREAM_TIMEOUT' | 'ACB_REDIRECT_REFUSED' | 'ACB_STOPPED' | 'ACB_OVER_CAP' | 'ACB_READ_ONLY'
  | 'ACB_MANAGED_BY_PLUGIN' | 'ACB_READ_NOT_ALLOWED'

/** How a refusal of the relay is filed in the AI action log. */
const REFUSAL_RECORD: Partial<Record<RelayErrorCode, { decision: ToolDecision; guardReason?: GuardReason }>> = {
  ACB_NO_KEY: { decision: 'guard-denied', guardReason: 'key-not-available' },
  ACB_STOPPED: { decision: 'stopped' },
  ACB_BAD_PATH: { decision: 'guard-denied', guardReason: 'destination-not-allowed' },
  ACB_DESTINATION_NOT_ALLOWED: { decision: 'guard-denied', guardReason: 'destination-not-allowed' },
  ACB_READ_ONLY: { decision: 'guard-denied', guardReason: 'destination-not-allowed' },
  ACB_MANAGED_BY_PLUGIN: { decision: 'guard-denied', guardReason: 'destination-not-allowed' },
  ACB_READ_NOT_ALLOWED: { decision: 'guard-denied', guardReason: 'destination-not-allowed' },
  ACB_REDIRECT_REFUSED: { decision: 'guard-denied', guardReason: 'destination-not-allowed' },
  ACB_PRIVATE_ADDRESS: { decision: 'guard-denied', guardReason: 'internal-address' },
  ACB_OVER_CAP: { decision: 'guard-denied', guardReason: 'over-cap' },
  ACB_TOO_LARGE: { decision: 'guard-denied' },
}

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'] as const
/** Never forwarded upstream (hop-by-hop, our own, the client's identity). */
const DROP_REQUEST = new Set([
  ...CREDENTIAL_HEADERS, 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'cookie', 'forwarded', 'via', 'x-real-ip', 'accept-encoding', 'origin', 'referer',
])
/** Headers some APIs read as the real method (refused while a service is read-only). */
const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override'])
/** Never answered (hop-by-hop, cookies of the provider). */
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'alt-svc'])
/** JSON bodies are read (model check, K5 record) up to this size; larger JSON is refused. */
const JSON_BUFFER_LIMIT = 32 * 1024 * 1024
/** An error answer is read to hide the key, up to this size (cut beyond it). */
const ERROR_BODY_LIMIT = 1024 * 1024

function jsonError(status: number, code: RelayErrorCode, message: string, grant: BrokerGrant | null = null): RelayAnswer {
  const body = new TextEncoder().encode(JSON.stringify({ type: 'error', error: { type: code, code, status: code, message } }))
  return { status, headers: [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'no-store']], body, grant, code }
}

/** 「この作業には <サービス> の鍵が必要です。…」 + the marker the app turns into a 「自分の鍵」 card. */
const NEEDS_KEY = brokerNoKeyMessage

function tokenRefusal(reason: BrokerTokenRefusal, label: string, service: string): RelayAnswer {
  switch (reason) {
    case 'broker-off': return jsonError(503, 'ACB_BROKER_OFF', 'サーバーで API キーを預かる機能が、まだ使えるようになっていません。管理者に相談してください。')
    case 'not-member': return jsonError(403, 'ACB_NOT_MEMBER', 'この会社のメンバーではないため、鍵を使えません。')
    case 'service-not-granted':
    case 'no-key': return jsonError(403, 'ACB_NO_KEY', NEEDS_KEY(label, service))
    case 'key-stopped': return jsonError(403, 'ACB_STOPPED', `管理者が ${label} の鍵を止めています。再開されるまで使えません。`)
    default: return jsonError(401, 'ACB_TOKEN_INVALID', 'ACB の通行証の期限が切れたか、使えなくなりました。新しい相談でもう一度お試しください。')
  }
}

/** A token-shaped string anywhere in a value (a generic service's own header form). */
const TOKEN_IN_VALUE = new RegExp(`${BROKER_TOKEN_PREFIX}[0-9a-f]{64}`, 'g')

/**
 * Every credential value the client sent (header forms and `?key=`). `inFormat`:
 * a generic service's own value shape (`Token token=…`) is not known before the
 * token names the company, so a value holding exactly one token counts as it.
 */
function credentialValues(headers: Array<[string, string]>, query: URLSearchParams, inFormat = false): string[] {
  const values: string[] = []
  for (const [name, value] of headers) {
    if (!(CREDENTIAL_HEADERS as readonly string[]).includes(name)) continue
    let v = (name === 'authorization' ? value.replace(/^Bearer\s+/i, '') : value).trim()
    const tokens = inFormat ? v.match(TOKEN_IN_VALUE) ?? [] : []
    if (tokens.length === 1) v = tokens[0]
    if (v) values.push(v)
  }
  for (const v of query.getAll('key')) if (v.trim()) values.push(v.trim())
  return values
}

/** The one credential the client sent (header forms or `?key=`), or what is wrong with it. */
function credentialOf(headers: Array<[string, string]>, query: URLSearchParams, inFormat: boolean): { token: string } | { error: 'none' | 'real-key' } {
  const values = credentialValues(headers, query, inFormat)
  if (values.length === 0) return { error: 'none' }
  // Anything that is not one of our tokens may be a real key: never forwarded.
  if (!values.every(looksLikeBrokerToken)) return { error: 'real-key' }
  if (new Set(values).size > 1) return { error: 'real-key' }
  return { token: values[0] }
}

/**
 * A generic service's token where its definition is not known yet (before the
 * token names the company): the one token-shaped value in any header, or none.
 */
function tokenInAnyHeader(headers: Array<[string, string]>): string | null {
  const found = new Set(headers.flatMap(([, value]) => value.match(TOKEN_IN_VALUE) ?? []))
  return found.size === 1 ? [...found][0] : null
}

/** Where one service's requests go and how its key travels: built-in, or a company's generic service. */
interface RelayTarget {
  label: string
  builtin: BrokerServiceInfo | null
  relay: BrokerRelayDefinition | null
}

/** The model a request names: Gemini in the path, OpenAI / Anthropic in the JSON body. */
function modelOf(decodedPath: string, json: unknown): string | null {
  const inPath = /\/(?:tuned)?[mM]odels\/([^/:]+)/.exec(decodedPath)
  if (inPath) return inPath[1]
  if (json && typeof json === 'object' && typeof (json as { model?: unknown }).model === 'string') {
    return (json as { model: string }).model.replace(/^models\//, '')
  }
  return null
}

async function readAll(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > limit) return null
    chunks.push(chunk)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/** Counts bytes on the way and stops past the limit (the relay then answers 413). */
function bounded(body: AsyncIterable<Uint8Array>, limit: number, onOverflow: () => void): AsyncIterable<Uint8Array> {
  return (async function* () {
    let size = 0
    for await (const chunk of body) {
      size += chunk.byteLength
      if (size > limit) { onOverflow(); throw new Error('request body too large') }
      yield chunk
    }
  })()
}

function replaceAll(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('[hidden]')
  return out
}

/** How long an upload session the relay started may continue without a token (Gemini resumable uploads). */
const UPLOAD_SESSION_MS = 60 * 60_000
const UPLOAD_SESSIONS_MAX = 10_000

export function createBrokerRelay(deps: BrokerRelayDeps) {
  const { brokerTokens, brokerVault, keyBroker, upstream, brokerKeys } = deps
  const log = deps.log ?? console
  /**
   * Gemini's resumable upload answers an `x-goog-upload-url` with an
   * `upload_id`; some SDK versions send the chunks there without the API key
   * header. The relay remembers which token started each upload (memory only,
   * an hour) and lets that upload's own URL continue under that token.
   */
  const uploads = new Map<string, { token: string; until: number }>()
  let prunedFor = ''
  const rememberUpload = (url: string, token: string) => {
    const id = new URL(url).searchParams.get('upload_id')
    if (!id) return
    const now = Date.now()
    for (const [k, v] of uploads) if (v.until < now || uploads.size >= UPLOAD_SESSIONS_MAX) uploads.delete(k)
    uploads.set(id, { token, until: now + UPLOAD_SESSION_MS })
  }
  const uploadToken = (service: string, rawPath: string, query: URLSearchParams): string | null => {
    const id = query.get('upload_id')
    if (service !== 'gemini' || !id || !rawPath.startsWith('/upload/')) return null
    const s = uploads.get(id)
    return s && s.until > Date.now() ? s.token : null
  }

  return {
    /** One call: the answer, and one record in the AI action log once it has ended. */
    async relay(req: RelayRequest): Promise<RelayAnswer> {
      const started = deps.nowMs()
      const meta: CallMeta = { bytesIn: 0, forwarded: false }
      const answer = await relayInner(req, meta)
      const who = meta.grant ?? meta.who
      if (!who) return answer
      const finish = (bytesOut: number, usage: UsageScanner | null, outcome: 'ok' | 'error' | 'unfinished') => {
        const tokensIn = usage?.tokensIn
        const tokensOut = usage?.tokensOut
        if (meta.grant && meta.forwarded && (tokensIn || tokensOut)) {
          brokerKeys.addUsage(meta.grant.companyId, meta.grant.keyId, meta.grant.userId, deps.dayOf(started), 0, (tokensIn ?? 0) + (tokensOut ?? 0))
        }
        const filed = answer.code ? REFUSAL_RECORD[answer.code] : undefined
        try {
          deps.record(who.companyId, who.userId, {
            durationMs: Math.max(0, deps.nowMs() - started),
            conversationId: who.conversationId.slice(0, 100),
            ...(who.department ? { department: who.department } : {}),
            agent: 'script',
            ...(meta.model ? { model: meta.model.slice(0, 100) } : {}),
            tool: `broker:${req.service}`,
            category: 'broker',
            target: {
              kind: 'broker', service: req.service,
              ...(meta.host ? { host: meta.host } : {}),
              ...(meta.path ? { path: meta.path.slice(0, 200) } : {}),
              ...(meta.connection ? { connection: meta.connection.slice(0, 100) } : {}),
              ...(meta.model ? { model: meta.model.slice(0, 100) } : {}),
              status: answer.status, bytesIn: meta.bytesIn, bytesOut,
              ...(tokensIn !== undefined ? { tokensIn } : {}),
              ...(tokensOut !== undefined ? { tokensOut } : {}),
              ...(meta.grant ? { source: meta.grant.source } : {}),
            },
            decision: filed?.decision ?? 'auto-allowed',
            ...(filed?.guardReason ? { guardReason: filed.guardReason } : {}),
            outcome,
          })
        } catch {
          log.warn(`[broker] relay ${req.service}: the call could not be recorded`)
        }
      }
      const failed = answer.status >= 400 ? 'error' : 'ok'
      // Token counts are read from the AI providers' answers only; a generic service's body is not scanned.
      const scansUsage = !!builtinBrokerService(req.service)
      if (answer.body === null || answer.body instanceof Uint8Array) {
        const usage = scansUsage ? new UsageScanner() : null
        if (answer.body && usage) usage.feed(answer.body)
        finish(answer.body?.byteLength ?? 0, usage, failed)
        return answer
      }
      const source = answer.body
      const usage = scansUsage ? new UsageScanner() : null
      return {
        ...answer,
        body: (async function* () {
          let bytes = 0
          let outcome: 'ok' | 'error' | 'unfinished' = 'unfinished'
          try {
            for await (const chunk of source) {
              bytes += chunk.byteLength
              usage?.feed(chunk)
              yield chunk
            }
            outcome = failed
          } catch (error) {
            outcome = 'error'
            throw error
          } finally {
            finish(bytes, usage, outcome)
          }
        })(),
      }
    },
  }

  async function relayInner(req: RelayRequest, meta: CallMeta): Promise<RelayAnswer> {
    {
      const q = req.pathAndQuery.indexOf('?')
      const rawPath = q < 0 ? req.pathAndQuery : req.pathAndQuery.slice(0, q)
      const query = new URLSearchParams(q < 0 ? '' : req.pathAndQuery.slice(q + 1))

      // 1. The token, before anything else (no token → 401, whatever the path).
      const builtin = builtinBrokerService(req.service) ?? null
      const realKey = () => jsonError(401, 'ACB_REAL_KEY_REFUSED', '本物の API キーが送られてきたため、送らずに止めました。鍵はスクリプトや .env に書かず、ACB に預けてください（管理者に頼むか、設定の『自分の鍵』から登録）。')
      if (credentialValues(req.headers, query).includes(BROKER_NO_KEY_PLACEHOLDER)
        || (!builtin && req.headers.some(([, v]) => v.trim().endsWith(BROKER_NO_KEY_PLACEHOLDER)))) {
        // The app had no key for this member and service: say so in plain Japanese.
        return jsonError(403, 'ACB_NO_KEY', NEEDS_KEY(builtin?.label ?? req.service, req.service))
      }
      let credential = credentialOf(req.headers, query, !builtin)
      if ('error' in credential && credential.error === 'none') {
        // Gemini upload chunks without a key; a generic service's token in its own header.
        const found = uploadToken(req.service, rawPath, query) ?? (builtin ? null : tokenInAnyHeader(req.headers))
        if (found) credential = { token: found }
      }
      if ('error' in credential) {
        return credential.error === 'none'
          ? jsonError(401, 'ACB_NO_TOKEN', 'ACB の通行証がありません。ACB のアプリの中から実行してください。')
          : realKey()
      }
      const token = credential.token
      const unknownService = () => jsonError(404, 'ACB_UNKNOWN_SERVICE', `「${req.service}」は ACB の中継先として登録されていません。`, meta.grant ?? null)
      if (!builtin && !isValidBrokerServiceName(req.service)) return unknownService()
      const checked = brokerTokens.validate(token, req.service)
      const companyId = checked.ok ? checked.grant.companyId : checked.who?.companyId
      const relay = builtin || !companyId ? null : keyBroker.relayService(companyId, req.service) ?? null
      const target: RelayTarget = { label: builtin?.label ?? relay?.label ?? req.service, builtin, relay }
      if (!checked.ok) {
        // A name that is neither built in nor one of the company's generic services: not ours (not recorded).
        if (!builtin && !relay && checked.who) return unknownService()
        meta.who = checked.who
        return tokenRefusal(checked.reason, target.label, req.service)
      }
      const grant = checked.grant
      meta.grant = grant
      if (!builtin && !relay) return unknownService()
      if (deps.companyStopped?.(grant.companyId)) return jsonError(403, 'ACB_STOPPED', '管理者が AI の利用を一時停止しています。再開されるまで使えません。', grant)
      if (relay) {
        // The service's own header must carry this token (in its format) or be absent: anything else may be a real key.
        const own = req.headers.filter(([n]) => n === relay.header).map(([, v]) => relayCredentialOf(relay.format, v))
        if (own.some(v => v !== token)) return { ...realKey(), grant }
      }

      // 2. Where it may go: the key's destinations (a generic service: its one host, always).
      const path = checkUpstreamPath(rawPath)
      if (!path || path.path.includes(token)) return jsonError(400, 'ACB_BAD_PATH', '宛先のパスの書き方が正しくありません。', grant)
      const { pathPrefixes, models } = grant.destinations
      const hosts = relay ? grant.destinations.hosts.filter(h => h === relay.host) : grant.destinations.hosts
      const host = relay || !builtin ? hosts[0] : hosts.includes(builtin.defaultHosts[0]) ? builtin.defaultHosts[0] : hosts[0]
      const basePath = relay?.basePath ?? ''
      if (!host) return jsonError(403, 'ACB_DESTINATION_NOT_ALLOWED', 'この鍵には送ってよい宛先がありません。', grant)
      meta.host = host
      meta.path = path.decoded
      if (pathPrefixes.length > 0 && !pathPrefixes.some(p => path.decoded.startsWith(p))) {
        return jsonError(403, 'ACB_DESTINATION_NOT_ALLOWED', 'この鍵では、この宛先（パス）は使えません。', grant)
      }
      // 2a. A connection managed by a connector plugin (once turned on, for good): writes go only through
      // the plugin's typed operations; reads only by members in the connection's read scope (an
      // admin's list of departments / members; empty = nobody), and searches only on the declared
      // paths. Checked on every call, so an old token or consultation cannot write either, and
      // turning the plugin off does not bring writes back. Logged with the connection and the path
      // as a pattern (never a body or the key).
      const managed = deps.managedConnection?.(grant.companyId, grant.userId, req.service) ?? null
      if (managed) {
        meta.path = relayPathPattern(path.decoded)
        meta.connection = managed.connectionIds[0]
        const reads = (req.method === 'GET' || req.method === 'HEAD' || (req.method === 'POST' && managed.searchPaths.includes(path.decoded)))
          && !req.headers.some(([n]) => METHOD_OVERRIDE_HEADERS.has(n))
        if (!reads) return jsonError(403, 'ACB_MANAGED_BY_PLUGIN', `${target.label} の書き換えは、ACB のプラグインの決まった操作からだけ行えます（ここからは読むだけです）。`, grant)
        if (!managed.mayRead) return jsonError(403, 'ACB_READ_NOT_ALLOWED', `${target.label} は、管理者が決めた「中継で読める人」だけがここから読めます。`, grant)
      }
      // 2b. The company keeps this service read-only (HubSpot once its plugin is on: writes go only through
      // the plugin's typed operations, which never pass here): only reads are forwarded.
      // A method-override header would let a "GET" write on some APIs: refused while read-only.
      if (keyBroker.relayReadOnly(grant.companyId, req.service)
        && (!brokerRelayReadOnlyAllows(builtin, req.method, path.decoded) || req.headers.some(([n]) => METHOD_OVERRIDE_HEADERS.has(n)))) {
        return jsonError(403, 'ACB_READ_ONLY', `${target.label} は、ここからは読むだけです（書き換えは ACB の決まった操作から行います）。`, grant)
      }

      // 3. The body: JSON is read (model check, the record), anything else streams, both bounded.
      const declared = Number(req.headers.find(([n]) => n === 'content-length')?.[1] ?? NaN)
      if (Number.isFinite(declared) && declared > deps.maxRequestBytes) return jsonError(413, 'ACB_TOO_LARGE', '送る内容が大きすぎます。', grant)
      const contentType = req.headers.find(([n]) => n === 'content-type')?.[1] ?? ''
      let body: AsyncIterable<Uint8Array> | null = req.body
      let json: unknown = null
      let tooLarge = false
      if (body && /json/i.test(contentType)) {
        const bytes = await readAll(body, Math.min(JSON_BUFFER_LIMIT, deps.maxRequestBytes))
        if (!bytes) return jsonError(413, 'ACB_TOO_LARGE', '送る内容が大きすぎます。', grant)
        try { json = JSON.parse(new TextDecoder().decode(bytes)) } catch { json = null }
        body = (async function* () { yield bytes })()
      } else if (body) {
        body = bounded(body, deps.maxRequestBytes, () => { tooLarge = true })
      }
      const model = modelOf(path.decoded, json)
      if (model) meta.model = normalizeBrokerModel(model) ?? undefined
      if (models.length > 0 && model !== null && !models.includes(normalizeBrokerModel(model) ?? '')) {
        return jsonError(403, 'ACB_DESTINATION_NOT_ALLOWED', `この鍵では、モデル「${normalizeBrokerModel(model) ?? '?'}」は使えません。`, grant)
      }

      // 4. The real key, in the service's one header; our token stays here.
      // 4a. The daily caps (company key: in total and per member; an own key: its own caps, none by default).
      const day = deps.dayOf(deps.nowMs())
      if (day !== prunedFor) {
        // Daily use is kept 40 days (the admin page shows today; the log keeps the calls).
        prunedFor = day
        brokerKeys.pruneUsage(deps.dayOf(deps.nowMs() - 40 * 86_400_000))
      }
      const used = brokerKeys.usage(grant.companyId, grant.keyId, grant.userId, day)
      const caps = grant.caps
      const over = (caps.requestsPerDay !== null && used.requests >= caps.requestsPerDay)
        || (caps.tokensPerDay !== null && used.tokens >= caps.tokensPerDay)
        || (caps.requestsPerMemberPerDay !== null && used.memberRequests >= caps.requestsPerMemberPerDay)
        || (caps.tokensPerMemberPerDay !== null && used.memberTokens >= caps.tokensPerMemberPerDay)
      if (over) {
        return jsonError(429, 'ACB_OVER_CAP', `${target.label} の鍵の、今日の上限に達しました。明日になるのを待つか、管理者に上限を見直してもらってください。`, grant)
      }

      const secret = await brokerVault.reveal(grant.companyId, grant.keyId)
      if (!secret) return tokenRefusal('no-key', target.label, req.service)
      const headers: Record<string, string> = {}
      for (const [name, value] of req.headers) {
        if (DROP_REQUEST.has(name) || name.startsWith('x-forwarded-') || name.startsWith('x-acb-')) continue
        // Our token never goes upstream, in whatever header it came.
        if (name === relay?.header || value.includes(token)) continue
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value
      }
      headers['accept-encoding'] = 'identity'
      if (relay) headers[relay.header] = relayCredentialValue(relay.format, secret)
      else if (builtin?.credential === 'authorization') headers.authorization = `Bearer ${secret}`
      else if (builtin) headers[builtin.credential] = secret
      query.delete('key')
      for (const [name, value] of [...query]) if (value.includes(token) || name.includes(token)) query.delete(name)
      const search = query.toString()

      brokerKeys.addUsage(grant.companyId, grant.keyId, grant.userId, day, 1, 0)
      meta.forwarded = true
      const counted = body ? countBytes(body, n => { meta.bytesIn += n }) : null
      const timeout = AbortSignal.timeout(deps.headersTimeoutMs + 30 * 60_000)
      const result = await upstream.send({
        host,
        method: req.method,
        path: `${basePath}${path.path}${search ? `?${search}` : ''}`,
        headers,
        body: counted,
        allowPrivateHosts: keyBroker.internalHosts(grant.companyId),
        signal: AbortSignal.any([req.signal, timeout]),
        headersTimeoutMs: deps.headersTimeoutMs,
      })
      if (!result.ok) {
        if (tooLarge) return jsonError(413, 'ACB_TOO_LARGE', '送る内容が大きすぎます。', grant)
        log.warn(`[broker] relay ${req.service}: upstream ${result.reason}`)
        return upstreamFailure(result.reason, grant)
      }
      const res = result.response
      if (res.viaPrivateAddress) log.warn(`[broker] relay ${req.service}: sent to an internal address (allowed by the company's exception for ${host})`)

      // 5. The answer: our own URLs for uploads / redirects to allowed hosts, nothing that holds the key.
      const relayUrl = (value: string): string | null => {
        let url: URL
        try { url = new URL(value, `https://${host}`) } catch { return null }
        if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase()) || url.port) return null
        // A generic service's URLs come back without its base path (the relay puts it back); others are not ours.
        if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return null
        url.searchParams.delete('key')
        return `${req.publicBase}/api/broker/${req.service}${url.pathname.slice(basePath.length) || '/'}${url.search}`
      }
      const out: Array<[string, string]> = []
      let redirectRefused = false
      for (const [name, value] of res.headers) {
        if (DROP_RESPONSE.has(name)) continue
        if (name === 'location' || name === 'x-goog-upload-url' || name === 'content-location') {
          const rewritten = relayUrl(value)
          if (rewritten && name === 'x-goog-upload-url') rememberUpload(rewritten, token)
          if (rewritten && !rewritten.includes(secret)) out.push([name, rewritten])
          else if (name === 'location' && res.status >= 300 && res.status < 400) redirectRefused = true
          continue
        }
        if (value.includes(secret) || value.includes(token)) continue
        out.push([name, value])
      }
      if (redirectRefused) return jsonError(502, 'ACB_REDIRECT_REFUSED', '送り先が、許可されていない場所への転送を返したため止めました。', grant)

      if (res.status >= 400) {
        const bytes = await readAll(res.body, ERROR_BODY_LIMIT).catch(() => null)
        const text = replaceAll(bytes ? new TextDecoder().decode(bytes) : '', [secret, token])
        return { status: res.status, headers: out.filter(([n]) => n !== 'content-length'), body: new TextEncoder().encode(text), grant }
      }
      return { status: res.status, headers: out, body: res.body, grant }
    }
  }
}

function countBytes(body: AsyncIterable<Uint8Array>, add: (n: number) => void): AsyncIterable<Uint8Array> {
  return (async function* () {
    for await (const chunk of body) { add(chunk.byteLength); yield chunk }
  })()
}

/**
 * Token counts in a provider's answer, read as it streams (no body is kept):
 * Gemini `usageMetadata` (promptTokenCount, candidatesTokenCount,
 * thoughtsTokenCount), OpenAI `usage` (prompt_tokens / completion_tokens or
 * input_tokens / output_tokens), Anthropic `usage` (input_tokens,
 * output_tokens — cumulative in streams). Streams repeat running totals, so
 * the largest value of each field wins.
 */
export class UsageScanner {
  private tail = ''
  private max = new Map<string, number>()
  private readonly decoder = new TextDecoder()
  private static readonly FIELD = /"(promptTokenCount|candidatesTokenCount|thoughtsTokenCount|prompt_tokens|completion_tokens|input_tokens|output_tokens)"\s*:\s*(\d{1,12})/g

  feed(chunk: Uint8Array): void {
    const text = this.tail + this.decoder.decode(chunk, { stream: true })
    for (const m of text.matchAll(UsageScanner.FIELD)) {
      const n = Number(m[2])
      if (n > (this.max.get(m[1]) ?? -1)) this.max.set(m[1], n)
    }
    this.tail = text.slice(-64)
  }

  private pick(...names: string[]): number | undefined {
    const values = names.map(n => this.max.get(n)).filter((v): v is number => v !== undefined)
    return values.length ? Math.max(...values) : undefined
  }

  get tokensIn(): number | undefined { return this.pick('promptTokenCount', 'prompt_tokens', 'input_tokens') }

  get tokensOut(): number | undefined {
    const out = this.pick('candidatesTokenCount', 'completion_tokens', 'output_tokens')
    const thoughts = this.max.get('thoughtsTokenCount')
    return out === undefined && thoughts === undefined ? undefined : (out ?? 0) + (thoughts ?? 0)
  }
}

function upstreamFailure(reason: UpstreamFailure, grant: BrokerGrant): RelayAnswer {
  switch (reason) {
    case 'private-address': return jsonError(403, 'ACB_PRIVATE_ADDRESS', '宛先が社内のアドレスを指しているため、送りませんでした。必要なら管理者に「社内の宛先（例外）」を頼んでください。', grant)
    case 'practice-real-secret': return jsonError(502, 'ACB_UPSTREAM_UNREACHABLE', '練習用の送り先には本物の鍵を送れないため、送りませんでした。', grant)
    case 'timeout': return jsonError(504, 'ACB_UPSTREAM_TIMEOUT', '送り先からの返事が時間内に来ませんでした。', grant)
    default: return jsonError(502, 'ACB_UPSTREAM_UNREACHABLE', '送り先につながりませんでした。時間をおいてもう一度お試しください。', grant)
  }
}

export type BrokerRelay = ReturnType<typeof createBrokerRelay>
