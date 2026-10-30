/**
 * The key broker's short-lived tokens (K3, .claude/rules/key-broker.md).
 *
 * - `issue` (POST …/me/broker-tokens, any member, from the desktop app): an
 *   unguessable `acb_tok_` + 256 random bits, scoped to the member, company,
 *   the services they can use now, the conversation and its department;
 *   15–60 minutes. Only its sha256 is stored; the value is answered once.
 * - `revoke` (the member's own token) and `revokeAll` (the emergency stop, M2).
 * - `validate` is for the relay (K4): token → grant (which key, where it may
 *   go). It re-decides the key on every call, so disabling or deleting a key,
 *   changing who may use it, the service's rule, or removing the member takes
 *   effect at once — a token is never a copy of a permission.
 */
import {
  BROKER_TOKEN_PREFIX,
  BROKER_TOKEN_TTL_MINUTES,
  NO_BROKER_CAPS,
  builtinBrokerService,
  chooseBrokerKeySource,
  clampBrokerTokenTtl,
  companyKeyUsable,
  isValidBrokerServiceName,
  looksLikeBrokerToken,
  upgradeBrokerAudience,
  type BrokerCaps,
  type BrokerDestinations,
  type BrokerKeyScope,
} from '../../shared/core/key-broker'
import type { BrokerTokenIssued, BrokerUnavailableReason } from '../../shared/types/key-broker'
import type { Clock, IdGenerator } from '../ports/clock'
import type { BrokerKeyRepository, BrokerKeyRow, BrokerTokenRepository, TokenDigest } from '../ports/key-broker'
import type { MembershipRepository } from '../ports/memberships'
import type { Member } from './access'
import type { BrokerVault } from './broker-vault'
import type { KeyBrokerService } from './key-broker'
import { ok, refuse, type Outcome } from './outcome'

/** Live tokens one member may hold in a company (a new conversation takes one). */
export const BROKER_TOKENS_PER_MEMBER = 50
const MAX_SERVICES = 20
const DAY_MS = 86_400_000

export interface BrokerTokenDeps {
  brokerTokens: BrokerTokenRepository
  brokerKeys: BrokerKeyRepository
  brokerVault: BrokerVault
  keyBroker: KeyBrokerService
  memberships: MembershipRepository
  tokenDigest: TokenDigest
  clock: Clock
  ids: IdGenerator
  /** The server's token lifetime (BROKER_TOKEN_TTL_MINUTES), clamped to 15–60. */
  ttlMinutes: number
}

/** What the relay may do with a validated token (no key value: that is `vault.reveal(companyId, keyId)`). */
export interface BrokerGrant {
  tokenId: string
  companyId: string
  userId: string
  conversationId: string
  department: string | null
  service: string
  keyId: string
  source: BrokerKeyScope
  destinations: BrokerDestinations
  caps: BrokerCaps
  allowPrivateContent: boolean
}

export type BrokerTokenRefusal =
  | 'broker-off' | 'malformed' | 'unknown' | 'expired' | 'revoked' | 'not-member' | 'service-not-granted' | 'no-key'
  /** The key that would apply is stopped by an admin (no other key to fall back to). */
  | 'key-stopped'

/** Whose live token it was, when it was valid up to choosing a key (for the call's record). */
export interface BrokerTokenHolder {
  tokenId: string
  companyId: string
  userId: string
  conversationId: string
  department: string | null
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T } catch { return fallback }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export function createBrokerTokenService(deps: BrokerTokenDeps) {
  const { brokerTokens, brokerKeys, brokerVault, keyBroker, memberships, tokenDigest, clock, ids } = deps
  const ttlMax = clampBrokerTokenTtl(deps.ttlMinutes)

  /**
   * The key a request for `service` uses for this member now, under the
   * service's rule: an active company key they may use for work in the
   * consultation's department (both dials), or their own active key (when
   * members may have own keys and its hosts are still allowed).
   */
  function resolveKey(
    companyId: string, userId: string, department: string | null, service: string,
    rows: BrokerKeyRow[] = brokerKeys.list(companyId), includeStopped = false,
  ): BrokerKeyRow | null {
    const setting = keyBroker.serviceSetting(companyId, service)
    const departmentId = keyBroker.departmentIdOfFolder(companyId, department)
    const live = (r: BrokerKeyRow) => includeStopped || r.status === 'active'
    const company = rows.find(r => r.scope === 'company' && r.service === service && live(r)
      && companyKeyUsable(upgradeBrokerAudience(parseJson<unknown>(r.audience, null)), userId, departmentId)) ?? null
    const own = keyBroker.memberKeysAllowed(companyId)
      ? rows.find(r => r.scope === 'user' && r.ownerUserId === userId && r.service === service && live(r)
        && parseJson<BrokerDestinations>(r.destinations, { hosts: [], pathPrefixes: [], models: [] }).hosts.every(h => setting.ownKeyHosts.includes(h))) ?? null
      : null
    const source = chooseBrokerKeySource(setting.rule, { company: !!company, user: !!own })
    return source === 'company' ? company : source === 'user' ? own : null
  }

  /** No usable key: is it because an admin stopped the one that would apply (the emergency stop's 「鍵」)? */
  function stoppedReason(companyId: string, userId: string, department: string | null, service: string, rows?: BrokerKeyRow[]): 'key-stopped' | 'no-key' {
    return resolveKey(companyId, userId, department, service, rows, true) ? 'key-stopped' : 'no-key'
  }

  return {
    /** POST …/me/broker-tokens */
    issue(member: Member, body: unknown): Outcome<BrokerTokenIssued> {
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const { conversationId, department } = body
      if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200 || CONTROL.test(conversationId)) {
        return refuse('bad-request', 'conversationId is required (1–200 characters)')
      }
      if (department !== undefined && department !== null && (typeof department !== 'string' || !department || department.length > 255 || CONTROL.test(department))) {
        return refuse('bad-request', 'department must be a folder name or null')
      }
      if (body.services !== undefined && (!Array.isArray(body.services) || body.services.length > MAX_SERVICES || !body.services.every(isValidBrokerServiceName))) {
        return refuse('bad-request', `services must be up to ${MAX_SERVICES} service names`)
      }
      if (body.ttlMinutes !== undefined && (typeof body.ttlMinutes !== 'number' || !Number.isFinite(body.ttlMinutes))) {
        return refuse('bad-request', 'ttlMinutes must be a number')
      }
      if (!brokerVault.status().enabled) {
        return ok({ enabled: false, token: null, tokenId: null, expiresAt: null, services: [], unavailable: [] })
      }

      const folder = typeof department === 'string' ? department.normalize('NFC') : null
      const rows = brokerKeys.list(member.companyId)
      const known = new Set([...rows.map(r => r.service), ...keyBroker.knownServices(member.companyId)])
      const requested = body.services !== undefined
        ? [...new Set(body.services as string[])]
        : [...new Set(rows.map(r => r.service))]
      const granted: BrokerTokenIssued['services'] = []
      const unavailable: Array<{ service: string; reason: BrokerUnavailableReason }> = []
      for (const service of requested) {
        if (!known.has(service) && !builtinBrokerService(service)) { unavailable.push({ service, reason: 'unknown-service' }); continue }
        const key = resolveKey(member.companyId, member.userId, folder, service, rows)
        if (key) granted.push({ service, source: key.scope as BrokerKeyScope })
        else unavailable.push({ service, reason: stoppedReason(member.companyId, member.userId, folder, service, rows) === 'key-stopped' ? 'stopped' : 'no-key' })
      }
      if (granted.length === 0) return ok({ enabled: true, token: null, tokenId: null, expiresAt: null, services: [], unavailable })

      const nowMs = clock.nowMs()
      const now = new Date(nowMs).toISOString()
      brokerTokens.pruneExpired(new Date(nowMs - DAY_MS).toISOString())
      if (brokerTokens.countLive(member.companyId, member.userId, now) >= BROKER_TOKENS_PER_MEMBER) {
        return refuse('rate-limited', 'Too many live broker tokens; try again later', { code: 'TOO_MANY_TOKENS', retryAfterSeconds: 60 })
      }
      const ttl = body.ttlMinutes === undefined
        ? ttlMax
        : Math.min(ttlMax, Math.max(BROKER_TOKEN_TTL_MINUTES.min, Math.round(body.ttlMinutes as number)))
      const token = `${BROKER_TOKEN_PREFIX}${ids.newToken()}`
      const tokenId = ids.newId()
      const expiresAt = new Date(nowMs + ttl * 60_000).toISOString()
      brokerTokens.insert({
        id: tokenId,
        companyId: member.companyId,
        userId: member.userId,
        tokenHash: tokenDigest.digest(token),
        services: JSON.stringify(granted.map(g => g.service)),
        department: folder,
        conversationId,
        createdAt: now,
        expiresAt,
        revokedAt: null,
      })
      return ok({ enabled: true, token, tokenId, expiresAt, services: granted, unavailable })
    },

    /** DELETE …/me/broker-tokens/:tokenId — the member's own token. */
    revoke(member: Member, tokenId: string): Outcome<{ revoked: true }> {
      return brokerTokens.revoke(member.companyId, member.userId, tokenId, clock.now())
        ? ok({ revoked: true })
        : refuse('not-found', 'Token not found')
    },

    /** Stop every live token of a member, or of the whole company (userId null) — the emergency stop (M2). */
    revokeAll(companyId: string, userId: string | null): number {
      return brokerTokens.revokeAll(companyId, userId, clock.now())
    },

    /**
     * For the relay (K4): is `token` valid for `service` right now, and with
     * which key? Never logs or returns the token. The relay then reveals the
     * key with `vault.reveal(grant.companyId, grant.keyId)`.
     */
    validate(token: unknown, service: string): { ok: true; grant: BrokerGrant } | { ok: false; reason: BrokerTokenRefusal; who?: BrokerTokenHolder } {
      if (!brokerVault.status().enabled) return { ok: false, reason: 'broker-off' }
      if (!looksLikeBrokerToken(token)) return { ok: false, reason: 'malformed' }
      const row = brokerTokens.findByHash(tokenDigest.digest(token))
      if (!row) return { ok: false, reason: 'unknown' }
      if (row.revokedAt) return { ok: false, reason: 'revoked' }
      if (Date.parse(row.expiresAt) <= clock.nowMs()) return { ok: false, reason: 'expired' }
      const role = memberships.roleOf(row.companyId, row.userId)
      if (role === null) return { ok: false, reason: 'not-member' }
      const who: BrokerTokenHolder = { tokenId: row.id, companyId: row.companyId, userId: row.userId, conversationId: row.conversationId, department: row.department }
      if (!parseJson<string[]>(row.services, []).includes(service)) return { ok: false, reason: 'service-not-granted', who }
      const key = resolveKey(row.companyId, row.userId, row.department, service)
      if (!key) return { ok: false, reason: stoppedReason(row.companyId, row.userId, row.department, service), who }
      return {
        ok: true,
        grant: {
          tokenId: row.id,
          companyId: row.companyId,
          userId: row.userId,
          conversationId: row.conversationId,
          department: row.department,
          service,
          keyId: key.id,
          source: key.scope as BrokerKeyScope,
          destinations: parseJson<BrokerDestinations>(key.destinations, { hosts: [], pathPrefixes: [], models: [] }),
          caps: { ...NO_BROKER_CAPS, ...parseJson<Partial<BrokerCaps>>(key.caps, {}) },
          allowPrivateContent: key.allowPrivateContent,
        },
      }
    },
  }
}

export type BrokerTokenService = ReturnType<typeof createBrokerTokenService>
