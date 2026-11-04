/**
 * The Google relay with the member's own permission (「本人の許可で中継する」, owner decision
 * 2026-11-04, `.claude/rules/google-connector.md` "The relay").
 *
 * A script on the member's PC calls `$ACB_GOOGLE_BASE_URL/sheets/v4/spreadsheets/…` with the
 * broker token the app hands out (`ACB_GOOGLE_API_KEY`). The key broker's relay
 * (services/broker-relay.ts) checks the token and hands the call here with the token's member;
 * this module sends it through the one Google client (google-client.ts) **with that member's own
 * Google permission** — never a stored company key, never a service account — so every Google
 * switch applies (operator stop, company Google off, the company's スプレッドシート off, the
 * member's grant gone or stopped, the member's own 「やめる」).
 *
 * Before anything leaves ACB, in order: the path (only `/sheets/…`, `checkUpstreamPath`), the
 * company-wide and the per-member stop, method-override headers, the call (only
 * `parseSheetsCall`'s list — never a clear or delete), the query parameters, the body (a
 * `spreadsheets:batchUpdate` with any delete / clear or an unlisted request kind is refused), and
 * the member's daily cap. No person is asked (the ledger records every call: who, when, which
 * spreadsheet and range, the result — never cell contents).
 *
 * Also the admin's settings (owner/admin) and the member's own view (records of their own calls).
 */
import { checkUpstreamPath } from '../../shared/core/upstream-path'
import { GOOGLE_API_HOSTS, GOOGLE_SCOPE, googleCompanyFeatureOn, googleCompanySwitched } from '../../shared/core/google'
import {
  GOOGLE_RELAY_CAP, GOOGLE_RELAY_SERVICES, SHEETS_OPERATIONS, checkSheetsBatchUpdate, isGoogleRelayCap, isGoogleRelayService, parseSheetsCall,
  sheetsPathParts, sheetsQuery, type GoogleRelayService, type SheetsOperation,
} from '../../shared/core/google-relay'
import type { GoogleChangeAction, GoogleRelayAdminView, GoogleRelayMember, GoogleRelayRecord, GoogleUnavailableReason, MyGoogleRelay } from '../../shared/types/google'
import type { AccountDirectory } from '../ports/accounts'
import type { AgentEventRow } from '../ports/agent-events'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { ConnectorChangeRow, ConnectorRepository, GoogleRelaySettingsRow } from '../ports/connectors'
import { requireFullAccess, type Member } from './access'
import type { PersonRelay, PersonRelayCall, PersonRelayResult, RelayErrorCode } from './broker-relay'
import type { GoogleClient, GoogleResult } from './google-client'
import { ok, refuse, type Outcome } from './outcome'

export const GOOGLE_RELAY_FORBIDDEN = 'Only owners and admins can manage the Google relay'
/** The relay service's id under /api/broker/ and in `ACB_GOOGLE_*`. */
export const GOOGLE_RELAY_BROKER_SERVICE = 'google'
/** The AI-action-log tool of a relayed call (one line per call, by broker-relay.ts). */
export const GOOGLE_RELAY_TOOL = `broker:${GOOGLE_RELAY_BROKER_SERVICE}`
/** A JSON body is read up to this size (a script's rows; Google's own request limit is larger). */
const MAX_BODY_BYTES = 10 * 1024 * 1024
const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override'])
const ADMIN_RECORDS = 100
const OWN_RECORDS = 50

export interface GoogleRelayDeps {
  companyData: CompanyDataSource
  google: GoogleClient
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  /** Why Google cannot be used by the company now (google-connector.ts), null when it can. */
  unavailable(companyId: string): Promise<GoogleUnavailableReason | null>
  isMember(companyId: string, userId: string): boolean
  /** The member's relayed calls counted for a day (the key broker's daily use, its own row per member). */
  usage: { count(companyId: string, userId: string, day: string): number; add(companyId: string, userId: string, day: string): void }
  /** The caps' day of a moment (the key broker's: Japan by default). */
  dayOf(ms: number): string
  /** The relay's lines in the AI action log, newest first (one member, or everyone with null). */
  records(companyId: string, userId: string | null, limit: number): AgentEventRow[]
}

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The services a company has turned on (its client exists and is on). */
function servicesOn(connectors: ConnectorRepository): GoogleRelayService[] {
  const client = connectors.client()
  if (!client) return []
  return GOOGLE_RELAY_SERVICES.filter(s => googleCompanyFeatureOn(s, { ...client, readIncomingAllowed: false }))
}

/**
 * Whether the company offers the person relay now (for token issue: the app then hands scripts
 * `ACB_GOOGLE_*`). Every call is decided again; this only decides whether the variables appear.
 */
export function googleRelayOffered(companyData: CompanyDataSource, companyId: string): string[] {
  const connectors = companyData.forCompany(companyId).connectors
  const client = connectors.client()
  return client?.enabled && servicesOn(connectors).length > 0 ? [GOOGLE_RELAY_BROKER_SERVICE] : []
}

async function readBody(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | null> {
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

/** A not-sent reason of the Google client → the relay's refusal (nothing left ACB). */
function notSentRefusal(reason: string): { status: number; code: RelayErrorCode; message: string } {
  switch (reason) {
    case 'operator-stopped': return { status: 403, code: 'ACB_STOPPED', message: 'いまは Google を使えません（運用担当者が止めています）。' }
    case 'not-configured':
    case 'off': return { status: 403, code: 'ACB_GOOGLE_OFF', message: '管理者が Google（またはスプレッドシートの中継）を止めています。' }
    case 'vault-off': return { status: 503, code: 'ACB_BROKER_OFF', message: 'サーバーの準備ができていないため、Google の中継を使えません。管理者に確かめてください。' }
    case 'not-member': return { status: 403, code: 'ACB_NOT_MEMBER', message: 'この会社のメンバーではないため、中継できません。' }
    case 'feature-off': return { status: 403, code: 'ACB_GOOGLE_NOT_ALLOWED', message: 'あなたが「スプレッドシートを中継で使う」をやめています。使うときは、アプリの「設定 → Google」で［許可する］を押してください。' }
    case 'no-grant':
    case 'grant-revoked':
    case 'grant-stopped':
    case 'scope-not-granted': return { status: 403, code: 'ACB_GOOGLE_NOT_ALLOWED', message: 'この作業には、あなたの Google の許可が必要です。アプリの「設定 → Google」で「スプレッドシートを中継で使う」の［許可する］を押してください。' }
    case 'timeout': return { status: 504, code: 'ACB_UPSTREAM_TIMEOUT', message: 'Google からの返事が時間内に来ませんでした。' }
    default: return { status: 502, code: 'ACB_UPSTREAM_UNREACHABLE', message: 'Google につながりませんでした。時間をおいてもう一度お試しください。' }
  }
}

/** Google's answer in Google's own error shape (so client libraries read it); never Google's message. */
function googleError(status: number, googleStatus: string, message: string): Uint8Array {
  return enc({ error: { code: status, status: googleStatus, message } })
}

function resultBody(result: Extract<GoogleResult, { ok: true }>): Uint8Array {
  if (result.json !== null && result.json !== undefined) return enc(result.json)
  return enc(result.text === null || result.text === '' ? {} : { text: result.text })
}

/** One AI-action-log line → the records' line (who, when, which sheet and range, the result). */
function recordOf(row: AgentEventRow, names: Map<string, { name: string | null } | undefined>): GoogleRelayRecord {
  const t = (isObject(row.target) ? row.target : {}) as { path?: unknown; operation?: unknown; status?: unknown }
  const path = typeof t.path === 'string' ? t.path : ''
  const operation = typeof t.operation === 'string' && (SHEETS_OPERATIONS as readonly string[]).includes(t.operation) ? t.operation as SheetsOperation : null
  const status = typeof t.status === 'number' ? t.status : null
  const parts = sheetsPathParts(path)
  let result: GoogleRelayRecord['result']
  let reason: GoogleRelayRecord['reason'] = null
  if (row.decision === 'stopped') { result = 'refused'; reason = 'stopped' } else if (row.decision === 'guard-denied') {
    result = 'refused'
    reason = row.guardReason === 'no-deletion' ? 'deletion'
      : row.guardReason === 'over-cap' ? 'over-cap'
        : row.guardReason === 'key-not-available' ? 'not-allowed'
          : row.guardReason === 'destination-not-allowed' ? 'not-relayed' : 'other'
  } else if (status !== null && status >= 200 && status < 300) result = 'ok'
  else if (status !== null && status >= 400 && status < 500 && status !== 429) result = 'google-refused'
  else result = 'error'
  return {
    id: row.id, at: row.at, userId: row.userId, memberName: names.get(row.userId)?.name ?? null,
    service: 'sheets', operation, spreadsheetId: parts.spreadsheetId, range: parts.range ? parts.range.slice(0, 120) : null,
    status, result, reason,
  }
}

export function createGoogleRelay(deps: GoogleRelayDeps) {
  const { companyData, google, accounts, clock, ids } = deps
  const connectorsOf = (companyId: string) => companyData.forCompany(companyId).connectors
  const capOf = (s: GoogleRelaySettingsRow) => (isGoogleRelayCap(s.capPerMemberPerDay) ? s.capPerMemberPerDay : GOOGLE_RELAY_CAP.default)

  function change(action: GoogleChangeAction, by: string, userId: string | null, detail: Record<string, unknown>): ConnectorChangeRow {
    return { id: ids.newId(), provider: 'google', action, userId, at: clock.now(), by, change: JSON.stringify(detail) }
  }

  function records(companyId: string, userId: string | null, limit: number): GoogleRelayRecord[] {
    const rows = deps.records(companyId, userId, limit)
    const names = accounts.byIds([...new Set(rows.map(r => r.userId))])
    return rows.map(r => recordOf(r, names))
  }

  /** Allowed: an active grant holding the service's permission, not turned off by the member. */
  function allowedBy(connectors: ConnectorRepository, userId: string): { allowed: boolean; turnedOff: boolean; at: string | null } {
    const grant = connectors.grant('google', userId)
    const has = grant?.status === 'active' && grant.scopes.includes(GOOGLE_SCOPE.spreadsheets)
    const turnedOff = !!has && grant!.featuresOff.includes('sheets')
    return { allowed: !!has && !turnedOff, turnedOff, at: has ? grant!.updatedAt : null }
  }

  async function adminViewOf(companyId: string): Promise<GoogleRelayAdminView> {
    const connectors = connectorsOf(companyId)
    const settings = connectors.relaySettings() ?? {}
    const on = servicesOn(connectors)
    const day = deps.dayOf(clock.nowMs())
    const stoppedIds = settings.stoppedUserIds ?? []
    const userIds = [...new Set([
      ...connectors.grants('google').filter(g => g.scopes.includes(GOOGLE_SCOPE.spreadsheets)).map(g => g.userId),
      ...stoppedIds,
    ])].filter(u => deps.isMember(companyId, u))
    const people = accounts.byIds(userIds)
    const reason = await deps.unavailable(companyId)
    return {
      available: reason === null,
      reason,
      services: GOOGLE_RELAY_SERVICES.map(service => ({ service, on: on.includes(service) })),
      capPerMemberPerDay: capOf(settings),
      stopped: settings.stopped === true,
      members: userIds.map((userId): GoogleRelayMember => {
        const a = allowedBy(connectors, userId)
        return {
          userId, memberName: people.get(userId)?.name ?? null, memberEmail: people.get(userId)?.email ?? null,
          allowed: a.allowed, allowedAt: a.at, stopped: stoppedIds.includes(userId), usedToday: deps.usage.count(companyId, userId, day),
        }
      }),
      records: records(companyId, null, ADMIN_RECORDS),
    }
  }

  const relay: PersonRelay = {
    async relay(call: PersonRelayCall): Promise<PersonRelayResult> {
      const { who } = call
      const out = (status: number, code: RelayErrorCode, message: string, extra: Partial<PersonRelayResult> = {}): PersonRelayResult =>
        ({ status, body: new Uint8Array(0), refusal: { code, message }, bytesIn: 0, ...extra })

      // 1. Where: only a relay service's API (Sheets), a plain path.
      const checked = checkUpstreamPath(call.rawPath)
      if (!checked) return out(400, 'ACB_BAD_PATH', '宛先のパスの書き方が正しくありません。')
      const service = checked.decoded.split('/')[1]
      if (!isGoogleRelayService(service)) {
        return out(403, 'ACB_NOT_RELAYED', 'Google の中継は、いまスプレッドシート（/sheets/v4/spreadsheets/…）だけです。')
      }
      const apiPath = call.rawPath.slice(service.length + 1)
      const apiDecoded = checked.decoded.slice(service.length + 1)
      const parsed = parseSheetsCall(call.method, apiDecoded)
      const meta = { host: GOOGLE_API_HOSTS.sheets, path: apiDecoded.slice(0, 200), ...(parsed.ok ? { operation: parsed.call.operation } : {}) }

      // 2. The admin's stops and the company's service switch.
      const connectors = connectorsOf(who.companyId)
      const settings = connectors.relaySettings()
      if (!settings) return out(403, 'ACB_GOOGLE_OFF', 'この会社では Google がつながっていません。管理者に確かめてください。', meta)
      if (settings.stopped) return out(403, 'ACB_STOPPED', '管理者が Google の中継を止めています。再開されるまで使えません。', meta)
      if ((settings.stoppedUserIds ?? []).includes(who.userId)) {
        return out(403, 'ACB_STOPPED', '管理者が、あなたの Google の中継を止めています。再開されるまで使えません。', meta)
      }
      if (!servicesOn(connectors).includes(service)) {
        return out(403, 'ACB_GOOGLE_OFF', 'この会社では、スプレッドシートの中継を使っていません。管理者に確かめてください。', meta)
      }

      // 3. What: a listed call, never a deletion; listed query parameters only.
      if (call.headers.some(([n]) => METHOD_OVERRIDE_HEADERS.has(n))) return out(403, 'ACB_NOT_RELAYED', 'この操作は、ACB の中継では通しません。', meta)
      if (!parsed.ok) {
        return parsed.refusal === 'deletion'
          ? out(403, 'ACB_DELETE_REFUSED', '表・シート・セルの中身を消す操作は、ACB の中継では通しません。', meta)
          : out(403, 'ACB_NOT_RELAYED', 'この操作は、ACB の中継では通しません（読む・書き換える・行を足す、などだけです）。', meta)
      }
      const query = sheetsQuery(call.query)
      if (!query.ok) return out(400, 'ACB_NOT_RELAYED', `「${query.name}」の指定は、ACB の中継では使えません。`, meta)

      // 4. The body of a write: JSON, bounded; a batchUpdate only with allowed request kinds.
      let json: unknown
      let bytesIn = 0
      if (parsed.call.write) {
        if (!call.body) return out(400, 'ACB_NOT_RELAYED', '書き込む内容（JSON）がありません。', meta)
        const declared = Number(call.headers.find(([n]) => n === 'content-length')?.[1] ?? NaN)
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return out(413, 'ACB_TOO_LARGE', '送る内容が大きすぎます。', meta)
        const bytes = await readBody(call.body, MAX_BODY_BYTES)
        if (!bytes) return out(413, 'ACB_TOO_LARGE', '送る内容が大きすぎます。', meta)
        bytesIn = bytes.byteLength
        try { json = JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { json = undefined }
        if (!isObject(json)) return out(400, 'ACB_NOT_RELAYED', '書き込む内容を JSON として読めませんでした。', { ...meta, bytesIn })
        if (parsed.call.operation === 'spreadsheets.batchUpdate') {
          const kinds = checkSheetsBatchUpdate(json)
          if (!kinds.ok) {
            if (kinds.refusal === 'deletion') return out(403, 'ACB_DELETE_REFUSED', `表・シート・行や列を消す操作（${kinds.kinds.filter(k => /^(delete|clear)/i.test(k)).join('、')}）は、ACB の中継では通しません。`, { ...meta, bytesIn })
            if (kinds.refusal === 'not-relayed') return out(403, 'ACB_NOT_RELAYED', `この操作（${kinds.kinds.join('、')}）は、ACB の中継では通しません。`, { ...meta, bytesIn })
            return out(400, 'ACB_NOT_RELAYED', '書き込む内容の形が正しくありません（requests に1つずつ操作を並べてください）。', { ...meta, bytesIn })
          }
        }
      }

      // 5. The member's daily cap (counted before the call leaves, like the key broker's caps).
      const day = deps.dayOf(clock.nowMs())
      const cap = capOf(settings)
      if (deps.usage.count(who.companyId, who.userId, day) >= cap) {
        return out(429, 'ACB_OVER_CAP', `Google の中継の、今日の上限（${cap} 回）に達しました。明日になるのを待つか、管理者に上限を見直してもらってください。`, { ...meta, bytesIn })
      }
      deps.usage.add(who.companyId, who.userId, day)

      // 6. Google, with this member's own permission (every Google switch is checked there first).
      const result = await google.request(who.companyId, who.userId, {
        api: 'sheets',
        method: call.method as 'GET' | 'POST' | 'PUT',
        path: apiPath,
        query: query.query,
        ...(json !== undefined ? { body: json } : {}),
        scope: GOOGLE_SCOPE.spreadsheets,
        operation: `sheets.${parsed.call.operation}`,
        recordedByCaller: true,
      })
      if (result.ok) return { status: result.status, body: resultBody(result), bytesIn, ...meta }
      if (result.kind === 'not-sent') {
        const r = notSentRefusal(result.reason)
        return out(r.status, r.code, r.message, { ...meta, bytesIn })
      }
      if (result.kind === 'refused') {
        const status = result.status ?? 400
        const message = status === 403
          ? 'Google が断りました（あなたにはこの表を編集・閲覧する権限がないか、許可が足りません）。'
          : status === 404 ? 'Google が断りました（表が見つかりません）。' : 'Google が断りました。'
        return { status, body: googleError(status, result.googleReason ?? 'FAILED_PRECONDITION', message), bytesIn, ...meta }
      }
      if (result.kind === 'unknown') {
        return { status: 504, body: googleError(504, 'DEADLINE_EXCEEDED', 'Google に届いたか分かりません。表を確かめてから、必要ならもう一度お試しください。'), bytesIn, ...meta }
      }
      const status = result.kind === 'rate-limited' ? 429 : 502
      return { status, body: googleError(status, status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE', 'Google が混み合っているか、使えませんでした。時間をおいてもう一度お試しください。'), bytesIn, ...meta }
    },
  }

  return {
    /** The person relay the key broker's relay hands `/api/broker/google/…` to. */
    relay,

    /** GET …/google/relay (owner/admin). */
    async adminView(member: Member): Promise<Outcome<GoogleRelayAdminView>> {
      const allowed = requireFullAccess(member, GOOGLE_RELAY_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(await adminViewOf(member.companyId))
    },

    /** PUT …/google/relay { services?, capPerMemberPerDay?, stopped? } (owner/admin). */
    async save(member: Member, body: unknown): Promise<Outcome<GoogleRelayAdminView>> {
      const allowed = requireFullAccess(member, GOOGLE_RELAY_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const { services, capPerMemberPerDay, stopped } = body
      if (services === undefined && capPerMemberPerDay === undefined && stopped === undefined) {
        return refuse('bad-request', 'services, capPerMemberPerDay or stopped is required')
      }
      if (services !== undefined && (!isObject(services) || !Object.entries(services).every(([k, v]) => isGoogleRelayService(k) && typeof v === 'boolean'))) {
        return refuse('bad-request', `services must map ${GOOGLE_RELAY_SERVICES.join(', ')} to true or false`)
      }
      if (capPerMemberPerDay !== undefined && !isGoogleRelayCap(capPerMemberPerDay)) {
        return refuse('bad-request', `1人1日の上限は ${GOOGLE_RELAY_CAP.min}〜${GOOGLE_RELAY_CAP.max} 回で指定してください。`, { code: 'BAD_CAP' })
      }
      if (stopped !== undefined && typeof stopped !== 'boolean') return refuse('bad-request', 'stopped must be true or false')
      const connectors = connectorsOf(member.companyId)
      let client = connectors.client()
      if (!client) return refuse('not-found', 'Google の登録がまだありません。先に「つなぎ先 → Google」で登録してください。', { code: 'NOT_CONFIGURED' })
      for (const [service, on] of Object.entries((services ?? {}) as Record<GoogleRelayService, boolean>) as Array<[GoogleRelayService, boolean]>) {
        if (googleCompanyFeatureOn(service, { ...client, readIncomingAllowed: false }) === on) continue
        connectors.setClientFeatures(googleCompanySwitched(client, service, on), clock.now(), member.userId, change('features', member.userId, null, { feature: service, on }))
        client = connectors.client()!
      }
      if (capPerMemberPerDay !== undefined || stopped !== undefined) {
        const before = connectors.relaySettings() ?? {}
        const after: GoogleRelaySettingsRow = {
          ...before,
          ...(capPerMemberPerDay !== undefined ? { capPerMemberPerDay: capPerMemberPerDay as number } : {}),
          ...(stopped !== undefined ? { stopped: stopped as boolean } : {}),
        }
        if (capOf(after) !== capOf(before) || (after.stopped === true) !== (before.stopped === true)) {
          connectors.setRelaySettings(after, clock.now(), member.userId, change('relay', member.userId, null, {
            before: { capPerMemberPerDay: capOf(before), stopped: before.stopped === true },
            after: { capPerMemberPerDay: capOf(after), stopped: after.stopped === true },
          }))
        }
      }
      return ok(await adminViewOf(member.companyId))
    },

    /** PUT …/google/relay/members/:userId { stopped } (owner/admin): one member's relay stops / resumes. */
    async setMemberStopped(member: Member, userId: string, body: unknown): Promise<Outcome<GoogleRelayAdminView>> {
      const allowed = requireFullAccess(member, GOOGLE_RELAY_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body) || typeof body.stopped !== 'boolean') return refuse('bad-request', 'stopped must be true or false')
      const connectors = connectorsOf(member.companyId)
      const settings = connectors.relaySettings()
      // Another company's member answers exactly like an unknown one.
      if (!deps.isMember(member.companyId, userId)) return refuse('not-found', 'Member not found')
      if (!settings) return refuse('not-found', 'Google の登録がまだありません。先に「つなぎ先 → Google」で登録してください。', { code: 'NOT_CONFIGURED' })
      const before = settings.stoppedUserIds ?? []
      const has = before.includes(userId)
      if (has !== body.stopped) {
        const stoppedUserIds = body.stopped ? [...before, userId] : before.filter(u => u !== userId)
        connectors.setRelaySettings({ ...settings, stoppedUserIds }, clock.now(), member.userId, change('relay-member', member.userId, userId, { stopped: body.stopped }))
      }
      return ok(await adminViewOf(member.companyId))
    },

    /** GET …/me/google/relay (any member): what the company offers, the member's permission, their own records. */
    async my(member: Member): Promise<Outcome<MyGoogleRelay>> {
      const connectors = connectorsOf(member.companyId)
      const settings = connectors.relaySettings() ?? {}
      const reason = await deps.unavailable(member.companyId)
      const on = servicesOn(connectors)
      const a = allowedBy(connectors, member.userId)
      return ok({
        available: reason === null,
        reason,
        services: GOOGLE_RELAY_SERVICES.map(service => ({ service, offered: reason === null && on.includes(service), allowed: a.allowed, turnedOff: a.turnedOff })),
        stopped: settings.stopped ? 'company' : (settings.stoppedUserIds ?? []).includes(member.userId) ? 'member' : null,
        capPerDay: capOf(settings),
        usedToday: deps.usage.count(member.companyId, member.userId, deps.dayOf(clock.nowMs())),
        records: records(member.companyId, member.userId, OWN_RECORDS),
      })
    },
  }
}

export type GoogleRelay = ReturnType<typeof createGoogleRelay>
