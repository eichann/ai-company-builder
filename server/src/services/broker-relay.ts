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
 * This file is long because each step is one guard of the same request; it stays whole so
 * the order of the guards reads top to bottom.
 */
import {
  builtinBrokerService,
  looksLikeBrokerToken,
  normalizeBrokerModel,
  type BrokerServiceInfo,
} from '../../shared/core/key-broker'
import type { UpstreamClient, UpstreamFailure } from '../ports/upstream'
import type { BrokerGrant, BrokerTokenRefusal, BrokerTokenService } from './broker-tokens'
import type { BrokerVault } from './broker-vault'
import type { KeyBrokerService } from './key-broker'

export interface BrokerRelayDeps {
  brokerTokens: BrokerTokenService
  brokerVault: BrokerVault
  keyBroker: KeyBrokerService
  upstream: UpstreamClient
  maxRequestBytes: number
  headersTimeoutMs: number
  log?: Pick<Console, 'warn'>
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
}

/** Error codes the relay answers itself (JSON readable by the Gemini, OpenAI and Anthropic SDKs). */
export type RelayErrorCode =
  | 'ACB_NO_TOKEN' | 'ACB_REAL_KEY_REFUSED' | 'ACB_TOKEN_INVALID' | 'ACB_NOT_MEMBER' | 'ACB_NO_KEY' | 'ACB_BROKER_OFF'
  | 'ACB_UNKNOWN_SERVICE' | 'ACB_BAD_PATH' | 'ACB_DESTINATION_NOT_ALLOWED' | 'ACB_PRIVATE_ADDRESS' | 'ACB_TOO_LARGE'
  | 'ACB_UPSTREAM_UNREACHABLE' | 'ACB_UPSTREAM_TIMEOUT' | 'ACB_REDIRECT_REFUSED'

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'] as const
/** Never forwarded upstream (hop-by-hop, our own, the client's identity). */
const DROP_REQUEST = new Set([
  ...CREDENTIAL_HEADERS, 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'cookie', 'forwarded', 'via', 'x-real-ip', 'accept-encoding', 'origin', 'referer',
])
/** Never answered (hop-by-hop, cookies of the provider). */
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'alt-svc'])
/** JSON bodies are read (model check, K5 record) up to this size; larger JSON is refused. */
const JSON_BUFFER_LIMIT = 32 * 1024 * 1024
/** An error answer is read to hide the key, up to this size (cut beyond it). */
const ERROR_BODY_LIMIT = 1024 * 1024

function jsonError(status: number, code: RelayErrorCode, message: string, grant: BrokerGrant | null = null): RelayAnswer {
  const body = new TextEncoder().encode(JSON.stringify({ type: 'error', error: { type: code, code, status: code, message } }))
  return { status, headers: [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'no-store']], body, grant }
}

const NEEDS_KEY = (s: BrokerServiceInfo | undefined, service: string) =>
  `この作業には ${s?.label ?? service} の鍵が必要です。管理者に頼むか、設定の『自分の鍵』から登録してください。`

function tokenRefusal(reason: BrokerTokenRefusal, info: BrokerServiceInfo | undefined, service: string): RelayAnswer {
  switch (reason) {
    case 'broker-off': return jsonError(503, 'ACB_BROKER_OFF', 'サーバーで API キーを預かる機能が、まだ使えるようになっていません。管理者に相談してください。')
    case 'not-member': return jsonError(403, 'ACB_NOT_MEMBER', 'この会社のメンバーではないため、鍵を使えません。')
    case 'service-not-granted':
    case 'no-key': return jsonError(403, 'ACB_NO_KEY', NEEDS_KEY(info, service))
    default: return jsonError(401, 'ACB_TOKEN_INVALID', 'ACB の通行証の期限が切れたか、使えなくなりました。新しい相談でもう一度お試しください。')
  }
}

/** The one credential the client sent (header forms or `?key=`), or what is wrong with it. */
function credentialOf(headers: Array<[string, string]>, query: URLSearchParams): { token: string } | { error: 'none' | 'real-key' } {
  const values: string[] = []
  for (const [name, value] of headers) {
    if (!(CREDENTIAL_HEADERS as readonly string[]).includes(name)) continue
    const v = name === 'authorization' ? value.replace(/^Bearer\s+/i, '') : value
    if (v.trim()) values.push(v.trim())
  }
  for (const v of query.getAll('key')) if (v.trim()) values.push(v.trim())
  if (values.length === 0) return { error: 'none' }
  // Anything that is not one of our tokens may be a real key: never forwarded.
  if (!values.every(looksLikeBrokerToken)) return { error: 'real-key' }
  if (new Set(values).size > 1) return { error: 'real-key' }
  return { token: values[0] }
}

/** The upstream path, checked: '/'-rooted, no `.` / `..` segments, no encoded '/' or '\', no control characters. */
function checkPath(raw: string): { path: string; decoded: string } | null {
  if (!raw.startsWith('/') || raw.includes('//') || raw.includes('\\') || /%(2f|5c|00)/i.test(raw)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(raw)) return null
  let decoded: string
  try { decoded = raw.split('/').map(decodeURIComponent).join('/') } catch { return null }
  if (decoded.split('/').some(s => s === '.' || s === '..')) return null
  return { path: raw, decoded }
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
  const { brokerTokens, brokerVault, keyBroker, upstream } = deps
  const log = deps.log ?? console
  /**
   * Gemini's resumable upload answers an `x-goog-upload-url` with an
   * `upload_id`; some SDK versions send the chunks there without the API key
   * header. The relay remembers which token started each upload (memory only,
   * an hour) and lets that upload's own URL continue under that token.
   */
  const uploads = new Map<string, { token: string; until: number }>()
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
    async relay(req: RelayRequest): Promise<RelayAnswer> {
      const q = req.pathAndQuery.indexOf('?')
      const rawPath = q < 0 ? req.pathAndQuery : req.pathAndQuery.slice(0, q)
      const query = new URLSearchParams(q < 0 ? '' : req.pathAndQuery.slice(q + 1))

      // 1. The token, before anything else (no token → 401, whatever the path).
      let credential = credentialOf(req.headers, query)
      if ('error' in credential && credential.error === 'none') {
        const token = uploadToken(req.service, rawPath, query)
        if (token) credential = { token }
      }
      if ('error' in credential) {
        return credential.error === 'none'
          ? jsonError(401, 'ACB_NO_TOKEN', 'ACB の通行証がありません。ACB のアプリの中から実行してください。')
          : jsonError(401, 'ACB_REAL_KEY_REFUSED', '本物の API キーが送られてきたため、送らずに止めました。鍵はスクリプトや .env に書かず、ACB に預けてください（管理者に頼むか、設定の『自分の鍵』から登録）。')
      }
      const info = builtinBrokerService(req.service)
      if (!info) return jsonError(404, 'ACB_UNKNOWN_SERVICE', `「${req.service}」は ACB の中継先として登録されていません。`)
      const checked = brokerTokens.validate(credential.token, req.service)
      if (!checked.ok) return tokenRefusal(checked.reason, info, req.service)
      const grant = checked.grant

      // 2. Where it may go: the key's destinations.
      const path = checkPath(rawPath)
      if (!path) return jsonError(400, 'ACB_BAD_PATH', '宛先のパスの書き方が正しくありません。', grant)
      const { hosts, pathPrefixes, models } = grant.destinations
      const host = hosts.includes(info.defaultHosts[0]) ? info.defaultHosts[0] : hosts[0]
      if (!host) return jsonError(403, 'ACB_DESTINATION_NOT_ALLOWED', 'この鍵には送ってよい宛先がありません。', grant)
      if (pathPrefixes.length > 0 && !pathPrefixes.some(p => path.decoded.startsWith(p))) {
        return jsonError(403, 'ACB_DESTINATION_NOT_ALLOWED', 'この鍵では、この宛先（パス）は使えません。', grant)
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
      if (models.length > 0 && model !== null && !models.includes(normalizeBrokerModel(model) ?? '')) {
        return jsonError(403, 'ACB_DESTINATION_NOT_ALLOWED', `この鍵では、モデル「${normalizeBrokerModel(model) ?? '?'}」は使えません。`, grant)
      }

      // 4. The real key, in the service's one header; our token stays here.
      const secret = await brokerVault.reveal(grant.companyId, grant.keyId)
      if (!secret) return tokenRefusal('no-key', info, req.service)
      const headers: Record<string, string> = {}
      for (const [name, value] of req.headers) {
        if (DROP_REQUEST.has(name) || name.startsWith('x-forwarded-') || name.startsWith('x-acb-')) continue
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value
      }
      headers['accept-encoding'] = 'identity'
      if (info.credential === 'authorization') headers.authorization = `Bearer ${secret}`
      else headers[info.credential] = secret
      query.delete('key')
      const search = query.toString()

      const timeout = AbortSignal.timeout(deps.headersTimeoutMs + 30 * 60_000)
      const result = await upstream.send({
        host,
        method: req.method,
        path: `${path.path}${search ? `?${search}` : ''}`,
        headers,
        body,
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
        url.searchParams.delete('key')
        return `${req.publicBase}/api/broker/${req.service}${url.pathname}${url.search}`
      }
      const out: Array<[string, string]> = []
      let redirectRefused = false
      for (const [name, value] of res.headers) {
        if (DROP_RESPONSE.has(name)) continue
        if (name === 'location' || name === 'x-goog-upload-url' || name === 'content-location') {
          const rewritten = relayUrl(value)
          if (rewritten && name === 'x-goog-upload-url') rememberUpload(rewritten, credential.token)
          if (rewritten && !rewritten.includes(secret)) out.push([name, rewritten])
          else if (name === 'location' && res.status >= 300 && res.status < 400) redirectRefused = true
          continue
        }
        if (value.includes(secret)) continue
        out.push([name, value])
      }
      if (redirectRefused) return jsonError(502, 'ACB_REDIRECT_REFUSED', '送り先が、許可されていない場所への転送を返したため止めました。', grant)

      if (res.status >= 400) {
        const bytes = await readAll(res.body, ERROR_BODY_LIMIT).catch(() => null)
        const text = replaceAll(bytes ? new TextDecoder().decode(bytes) : '', [secret, credential.token])
        return { status: res.status, headers: out.filter(([n]) => n !== 'content-length'), body: new TextEncoder().encode(text), grant }
      }
      return { status: res.status, headers: out, body: res.body, grant }
    },
  }
}

function upstreamFailure(reason: UpstreamFailure, grant: BrokerGrant): RelayAnswer {
  switch (reason) {
    case 'private-address': return jsonError(403, 'ACB_PRIVATE_ADDRESS', '宛先が社内のアドレスを指しているため、送りませんでした。必要なら管理者に「社内の宛先（例外）」を頼んでください。', grant)
    case 'timeout': return jsonError(504, 'ACB_UPSTREAM_TIMEOUT', '送り先からの返事が時間内に来ませんでした。', grant)
    default: return jsonError(502, 'ACB_UPSTREAM_UNREACHABLE', '送り先につながりませんでした。時間をおいてもう一度お試しください。', grant)
  }
}

export type BrokerRelay = ReturnType<typeof createBrokerRelay>
