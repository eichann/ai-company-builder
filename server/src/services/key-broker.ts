/**
 * The API key broker's admin side (「API キー」, owner/admin): register,
 * replace, edit, disable and delete keys; per-service decision rules; whether
 * members may register own keys. Every change writes broker_history.
 * (.claude/rules/key-broker.md)
 *
 * Write-only: no answer carries a key's value — the summary shows its last
 * four characters. Values go straight from the request into
 * `vault.seal` (services/broker-vault.ts); validation errors never quote them.
 *
 * Who may use a company key: two dials (shared/core `BrokerAudience`) —
 * ① for which work (全社, or consultations in these departments: matched by
 * the token against the chat's department) and ② by whom (全員 or listed
 * people, ± per-person exceptions). `usableBy` lists dial ②; dial ① is
 * decided per consultation. Own keys: the owner.
 *
 * Generic services (K9, `PUT …/broker/relay-services/:service`): an
 * owner/admin names the one https host (and base path) and the header the key
 * travels in; every key for the service — company or own — may go to that
 * host only.
 */
import {
  BROKER_KEY_RULES,
  BROKER_KEY_STATUSES,
  BROKER_SERVICE_CATEGORIES,
  BUILTIN_BROKER_SERVICES,
  NO_BROKER_CAPS,
  brokerSecretLast4,
  builtinBrokerService,
  builtinHostsMessage,
  builtinHostsOutside,
  checkBrokerSecret,
  isPracticeSecret,
  PRACTICE_KEY_PREFIX,
  companyKeyEligibility,
  defaultBrokerRule,
  isValidBrokerServiceName,
  isValidRelayServiceId,
  parseBrokerAudience,
  parseBrokerRelayDefinition,
  readBrokerRelayDefinition,
  upgradeBrokerAudience,
  parseBrokerCaps,
  parseBrokerDestinations,
  parseBrokerDisplayName,
  parseOwnKeyHosts,
  parseInternalHosts,
  ownKeysSwitchSetting,
  type BrokerAudience,
  type BrokerCaps,
  type BrokerDestinations,
  type BrokerKeyCheckResult,
  type BrokerKeyRule,
  type BrokerKeyScope,
  type BrokerKeyStatus,
  type BrokerRelayDefinition,
  type BrokerServiceCategory,
} from '../../shared/core/key-broker'
import { pathKey } from '../../shared/core/paths'
import type {
  BrokerChange,
  BrokerChangeDetail,
  BrokerKeySnapshot,
  BrokerKeySummary,
  BrokerKeyUser,
  BrokerServiceSetting,
  BrokerServiceView,
  BrokerView,
} from '../../shared/types/key-broker'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { BrokerKeyChanges, BrokerKeyRepository, BrokerKeyRow, StoredBrokerService } from '../ports/key-broker'
import type { MembershipRepository } from '../ports/memberships'
import { requireFullAccess, type Member } from './access'
import type { BrokerVault } from './broker-vault'
import { ok, refuse, type Outcome } from './outcome'

export const KEY_BROKER_FORBIDDEN = 'Only owners and admins can manage API keys'
export const BROKER_OFF_ERROR = 'The key broker is off: the server has no key-encryption key (BROKER_KEK_FILE)'
/** The refusal when the service said the key does not work (the check on saving); never quotes the key. */
export const KEY_REJECTED_ERROR = 'The service refused this key (one read-only check request); it was not saved'

/** Checks a key once before it is saved (services/broker-key-check.ts); null = checking is off. */
export type BrokerKeyChecker = (companyId: string, service: string, secret: string, hosts: readonly string[]) => Promise<BrokerKeyCheckResult | null>
const HISTORY_LIMIT = 50

export interface KeyBrokerDeps {
  brokerKeys: BrokerKeyRepository
  brokerVault: BrokerVault
  memberships: MembershipRepository
  companyData: CompanyDataSource
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  /** The caps' day now (YYYY-MM-DD); default the UTC day. */
  brokerDay?: () => string
  /** The one check of a key being saved (default: none). */
  checkKey?: BrokerKeyChecker
  /** Services this server sends to a practice copy (staging only, `lib/config.ts`); default none. */
  practiceServices?: readonly string[]
  /** A connector plugin manages the service for this company: the read-only switch cannot be turned off (plugins.md). */
  managedByPlugin?: (companyId: string, service: string) => boolean
}

const has = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T } catch { return fallback }
}

/** A stored key's parsed fields (rows written by this service; a damaged field falls back to "nothing allowed"). */
function decoded(row: BrokerKeyRow) {
  const destinations = parseJson<BrokerDestinations>(row.destinations, { hosts: [], pathPrefixes: [], models: [] })
  const audience = row.scope === 'company' ? upgradeBrokerAudience(parseJson<unknown>(row.audience, null)) : upgradeBrokerAudience(null)
  const caps = { ...NO_BROKER_CAPS, ...parseJson<Partial<BrokerCaps>>(row.caps, {}) }
  return { destinations, audience, caps }
}

function snapshot(row: BrokerKeyRow): BrokerKeySnapshot {
  const { destinations, audience, caps } = decoded(row)
  return {
    service: row.service,
    scope: row.scope as BrokerKeyScope,
    ownerUserId: row.ownerUserId,
    displayName: row.displayName,
    last4: row.last4,
    destinations,
    audience,
    caps,
    allowPrivateContent: row.allowPrivateContent,
    status: row.status as BrokerKeyStatus,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The view, with how the saved key's check went (when keys are checked). */
function withCheck(view: BrokerView, service: string, check: BrokerKeyCheckResult | null): BrokerView {
  return check ? { ...view, check: { service, result: check } } : view
}

export function createKeyBrokerService(deps: KeyBrokerDeps) {
  const { brokerKeys, brokerVault, memberships, companyData, accounts, clock, ids } = deps
  const checkKey: BrokerKeyChecker = deps.checkKey ?? (async () => null)

  /**
   * Staging (practice upstreams): while the service's connections go to its
   * practice copy, a value that is not a practice key is refused — a real
   * secret is never registered there, so never sent there (review §5.8).
   */
  function practiceSecretRefusal(service: string, secret: string) {
    if (!deps.practiceServices?.includes(service) || isPracticeSecret(secret)) return null
    return refuse('bad-request', `練習用の${builtinBrokerService(service)?.label ?? service}につながっている間は、本物の鍵を登録できません（${PRACTICE_KEY_PREFIX}… の練習用の鍵だけです）`, { code: 'REAL_KEY_ON_PRACTICE' })
  }

  /**
   * The department a consultation is in, from the folder the app sent
   * (compared as NFC with A–Z folded); null when none or not a department.
   */
  function departmentIdOfFolder(companyId: string, folder: string | null): string | null {
    if (!folder) return null
    const key = pathKey(folder)
    return companyData.forCompany(companyId).departments.list().find(d => pathKey(d.folder) === key)?.id ?? null
  }

  function serviceSettings(companyId: string): Map<string, StoredBrokerService> {
    return new Map(brokerKeys.services(companyId).map(s => [s.service, s]))
  }

  /** A generic service's definition (K9), or null (built-in, keys only, or unreadable). */
  function relayOf(stored: StoredBrokerService | undefined): BrokerRelayDefinition | null {
    return stored?.relay ? readBrokerRelayDefinition(parseJson<unknown>(stored.relay, null)) : null
  }

  /** A generic service's keys go to its one host: refused otherwise. */
  function relayHostsError(relay: BrokerRelayDefinition | null, hosts: string[], what: string): string | null {
    if (!relay || hosts.every(h => h === relay.host)) return null
    return `${what}: this service's requests go to ${relay.host} only`
  }

  /** A built-in service's keys go to its own hosts only (a HubSpot key never to Gemini's host). */
  function builtinHostsRefusal(service: string, hosts: readonly string[]) {
    if (builtinHostsOutside(service, hosts).length === 0) return null
    return refuse('bad-request', builtinHostsMessage(service), { code: 'HOSTS_NOT_FOR_SERVICE' })
  }

  function serviceSettingOf(stored: StoredBrokerService | undefined, service: string): BrokerServiceSetting {
    const category: BrokerServiceCategory = stored && has(BROKER_SERVICE_CATEGORIES, stored.category)
      ? stored.category
      : builtinBrokerService(service)?.category ?? 'tool'
    const rule: BrokerKeyRule = stored && has(BROKER_KEY_RULES, stored.rule) ? stored.rule : defaultBrokerRule(category)
    const ownKeyHosts = stored ? parseJson<string[]>(stored.ownKeyHosts, []) : []
    return { category, rule, ownKeyHosts }
  }

  function view(companyId: string): BrokerView {
    const rows = brokerKeys.list(companyId)
    const usage = brokerKeys.usageByKey(companyId, deps.brokerDay ? deps.brokerDay() : clock.now().slice(0, 10))
    const members = memberships.listByCompany(companyId)
    const history = brokerKeys.history(companyId, HISTORY_LIMIT)
    const people = accounts.byIds([...new Set([
      ...members.map(m => m.user_id),
      ...history.map(h => h.changedBy),
      ...rows.flatMap(r => (r.ownerUserId ? [r.ownerUserId] : [])),
    ])])
    const person = (userId: string) => ({ name: people.get(userId)?.name ?? null, email: people.get(userId)?.email ?? null })

    const keys: BrokerKeySummary[] = rows.map(row => {
      const s = snapshot(row)
      let usableBy: BrokerKeyUser[]
      if (row.scope === 'user') {
        usableBy = members.some(m => m.user_id === row.ownerUserId) ? [{ userId: row.ownerUserId!, ...person(row.ownerUserId!), via: 'owner' }] : []
      } else {
        usableBy = members.flatMap(m => {
          const via = companyKeyEligibility(s.audience, m.user_id)
          return via ? [{ userId: m.user_id, ...person(m.user_id), via }] : []
        })
      }
      return {
        id: row.id,
        scope: s.scope,
        ownerUserId: row.ownerUserId,
        ownerName: row.ownerUserId ? person(row.ownerUserId).name ?? person(row.ownerUserId).email : null,
        service: row.service,
        displayName: row.displayName,
        last4: row.last4,
        destinations: s.destinations,
        audience: s.audience,
        caps: s.caps,
        allowPrivateContent: row.allowPrivateContent,
        status: s.status,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        secretUpdatedAt: row.secretUpdatedAt,
        usableBy,
        usageToday: usage.get(row.id) ?? { requests: 0, tokens: 0 },
      }
    })

    const stored = serviceSettings(companyId)
    const names = [...new Set([...BUILTIN_BROKER_SERVICES.map(s => s.service), ...stored.keys(), ...rows.map(r => r.service)])]
    const services: BrokerServiceView[] = names.map(service => {
      const builtin = builtinBrokerService(service)
      const setting = serviceSettingOf(stored.get(service), service)
      const relay = builtin ? null : relayOf(stored.get(service))
      return {
        service,
        label: builtin?.label ?? relay?.label ?? service,
        builtin: !!builtin,
        ...setting,
        defaultHosts: builtin ? [...builtin.defaultHosts] : relay ? [relay.host] : [],
        relay,
        readOnly: stored.get(service)?.readOnly ?? false,
        practice: deps.practiceServices?.includes(service) ?? false,
        companyKeys: rows.filter(r => r.service === service && r.scope === 'company').length,
        userKeys: rows.filter(r => r.service === service && r.scope === 'user').length,
        updatedAt: stored.get(service)?.updatedAt ?? null,
      }
    })

    const settings = brokerKeys.settings(companyId)
    const status = brokerVault.status()
    return {
      status: { enabled: status.enabled, reason: status.enabled ? null : status.reason },
      settings: {
        memberKeysAllowed: settings?.memberKeysAllowed ?? true,
        internalHosts: settings ? parseJson<string[]>(settings.internalHosts, []) : [],
        updatedAt: settings?.updatedAt ?? null,
        updatedBy: settings?.updatedBy ?? null,
      },
      services,
      keys,
      departments: companyData.forCompany(companyId).departments.list().map(d => ({ id: d.id, name: d.name, folder: d.folder })),
      history: history.map((h): BrokerChange | null => {
        const change = parseJson<BrokerChangeDetail | null>(h.change, null)
        return change ? { id: h.id, changedAt: h.changedAt, changedBy: h.changedBy, ...person(h.changedBy), keyId: h.keyId, change } : null
      }).filter((h): h is BrokerChange => h !== null),
    }
  }

  function changeRow(member: Member, at: string, keyId: string | null, change: BrokerChangeDetail) {
    return { id: ids.newId(), changedAt: at, changedBy: member.userId, keyId, action: change.action, change: JSON.stringify(change) }
  }

  /** Departments must be the company's, people its members. */
  function checkAudience(companyId: string, audience: BrokerAudience): string | null {
    const departmentIds = new Set(companyData.forCompany(companyId).departments.list().map(d => d.id))
    if (audience.departmentIds.some(id => !departmentIds.has(id))) return 'audience.departmentIds: unknown department'
    const userIds = new Set(memberships.listByCompany(companyId).map(m => m.user_id))
    if ([...audience.addUserIds, ...audience.removeUserIds].some(id => !userIds.has(id))) return 'audience: unknown member'
    return null
  }

  function parseCapsPatch(input: unknown, base: BrokerCaps) {
    if (!isObject(input)) return parseBrokerCaps(input)
    return parseBrokerCaps({ ...base, ...input })
  }

  /** Saves a service's rule and own-key hosts (history: action `service`). */
  function saveServiceSetting(member: Member, service: string, stored: StoredBrokerService | undefined, after: BrokerServiceSetting) {
    const before = stored ? serviceSettingOf(stored, service) : null
    if (same(before, after)) return
    const at = clock.now()
    brokerKeys.saveService(member.companyId, {
      service, category: after.category, rule: after.rule, ownKeyHosts: JSON.stringify(after.ownKeyHosts),
      relay: stored?.relay ?? null, readOnly: stored?.readOnly ?? false, updatedAt: at, updatedBy: member.userId,
    }, changeRow(member, at, null, { action: 'service', service, before, after }))
  }

  return {
    practiceSecretRefusal,

    /** GET …/broker */
    get(member: Member): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(view(member.companyId))
    },

    /** POST …/broker/keys: register a company key. */
    async create(member: Member, body: unknown): Promise<Outcome<BrokerView>> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      if (!isValidBrokerServiceName(body.service)) return refuse('bad-request', 'service must be a lower-case ASCII name (a-z, 0-9, -, _)')
      const service = body.service
      const name = parseBrokerDisplayName(body.displayName)
      if ('error' in name) return refuse('bad-request', name.error)
      const secret = checkBrokerSecret(body.secret)
      if ('error' in secret) return refuse('bad-request', secret.error)
      const practice = practiceSecretRefusal(service, secret.value)
      if (practice) return practice
      const builtin = builtinBrokerService(service)
      const relay = builtin ? null : relayOf(serviceSettings(member.companyId).get(service))
      const defaultHosts = builtin ? builtin.defaultHosts : relay ? [relay.host] : null
      const destinations = body.destinations === undefined && defaultHosts
        ? { value: { hosts: [...defaultHosts], pathPrefixes: [], models: [] } }
        : parseBrokerDestinations(body.destinations)
      if ('error' in destinations) return refuse('bad-request', destinations.error)
      const hostsError = relayHostsError(relay, destinations.value.hosts, 'destinations.hosts')
      if (hostsError) return refuse('bad-request', hostsError)
      const builtinHosts = builtinHostsRefusal(service, destinations.value.hosts)
      if (builtinHosts) return builtinHosts
      const audience = parseBrokerAudience(body.audience)
      if ('error' in audience) return refuse('bad-request', audience.error)
      const caps = parseBrokerCaps(body.caps)
      if ('error' in caps) return refuse('bad-request', caps.error)
      if (body.allowPrivateContent !== undefined && typeof body.allowPrivateContent !== 'boolean') return refuse('bad-request', 'allowPrivateContent must be true or false')
      const audienceError = checkAudience(member.companyId, audience.value)
      if (audienceError) return refuse('bad-request', audienceError)
      if (!brokerVault.status().enabled) return refuse('unavailable', BROKER_OFF_ERROR, { code: 'BROKER_OFF' })
      const check = await checkKey(member.companyId, service, secret.value, destinations.value.hosts)
      if (check === 'rejected') return refuse('bad-request', KEY_REJECTED_ERROR, { code: 'KEY_REJECTED' })

      const keyId = ids.newId()
      const sealed = await brokerVault.seal(member.companyId, keyId, secret.value)
      const at = clock.now()
      const row: BrokerKeyRow = {
        id: keyId,
        companyId: member.companyId,
        scope: 'company',
        ownerUserId: null,
        service,
        displayName: name.value,
        last4: brokerSecretLast4(secret.value),
        destinations: JSON.stringify(destinations.value),
        audience: JSON.stringify(audience.value),
        caps: JSON.stringify(caps.value),
        allowPrivateContent: body.allowPrivateContent === true,
        status: 'active',
        kekId: sealed.kekId,
        createdAt: at,
        createdBy: member.userId,
        updatedAt: at,
        updatedBy: member.userId,
        secretUpdatedAt: at,
      }
      brokerKeys.insert(row, sealed, changeRow(member, at, keyId, { action: 'create', key: snapshot(row), ...(check ? { check } : {}) }))
      return ok(withCheck(view(member.companyId), service, check))
    },

    /** PUT …/broker/keys/:keyId/secret: replace the value (company or own key). */
    async replaceSecret(member: Member, keyId: string, body: unknown): Promise<Outcome<BrokerView>> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const secret = checkBrokerSecret(body.secret)
      if ('error' in secret) return refuse('bad-request', secret.error)
      const existing = brokerKeys.find(member.companyId, keyId)
      if (!existing) return refuse('not-found', 'API key not found')
      const practice = practiceSecretRefusal(existing.service, secret.value)
      if (practice) return practice
      if (!brokerVault.status().enabled) return refuse('unavailable', BROKER_OFF_ERROR, { code: 'BROKER_OFF' })
      const check = await checkKey(member.companyId, existing.service, secret.value, decoded(existing).destinations.hosts)
      if (check === 'rejected') return refuse('bad-request', KEY_REJECTED_ERROR, { code: 'KEY_REJECTED' })
      const sealed = await brokerVault.seal(member.companyId, keyId, secret.value)
      const current = brokerKeys.find(member.companyId, keyId)
      if (!current) return refuse('not-found', 'API key not found')
      const at = clock.now()
      const last4 = brokerSecretLast4(secret.value)
      brokerKeys.replaceSecret(member.companyId, keyId, sealed, last4, at, member.userId, changeRow(member, at, keyId, {
        action: 'replace', service: current.service, displayName: current.displayName, last4Before: current.last4, last4After: last4,
        ...(check ? { check } : {}),
      }))
      return ok(withCheck(view(member.companyId), current.service, check))
    },

    /** PATCH …/broker/keys/:keyId: settings of a company key; an own key's status only. */
    update(member: Member, keyId: string, body: unknown): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const row = brokerKeys.find(member.companyId, keyId)
      if (!row) return refuse('not-found', 'API key not found')
      const before = snapshot(row)
      if (row.scope === 'user' && Object.keys(body).some(k => k !== 'status')) {
        return refuse('bad-request', 'A member\'s own key can only be enabled or disabled here')
      }
      const after: BrokerKeySnapshot = { ...before }
      if (body.displayName !== undefined) {
        const v = parseBrokerDisplayName(body.displayName)
        if ('error' in v) return refuse('bad-request', v.error)
        after.displayName = v.value
      }
      if (body.destinations !== undefined) {
        const v = parseBrokerDestinations(body.destinations)
        if ('error' in v) return refuse('bad-request', v.error)
        const hostsError = relayHostsError(relayOf(serviceSettings(member.companyId).get(row.service)), v.value.hosts, 'destinations.hosts')
        if (hostsError) return refuse('bad-request', hostsError)
        const builtinHosts = builtinHostsRefusal(row.service, v.value.hosts)
        if (builtinHosts) return builtinHosts
        after.destinations = v.value
      }
      if (body.audience !== undefined) {
        const v = parseBrokerAudience(body.audience)
        if ('error' in v) return refuse('bad-request', v.error)
        const audienceError = checkAudience(member.companyId, v.value)
        if (audienceError) return refuse('bad-request', audienceError)
        after.audience = v.value
      }
      if (body.caps !== undefined) {
        const v = parseCapsPatch(body.caps, before.caps)
        if ('error' in v) return refuse('bad-request', v.error)
        after.caps = v.value
      }
      if (body.allowPrivateContent !== undefined) {
        if (typeof body.allowPrivateContent !== 'boolean') return refuse('bad-request', 'allowPrivateContent must be true or false')
        after.allowPrivateContent = body.allowPrivateContent
      }
      if (body.status !== undefined) {
        if (!has(BROKER_KEY_STATUSES, body.status)) return refuse('bad-request', 'status must be active or disabled')
        after.status = body.status
      }
      const changes: BrokerKeyChanges = {}
      const b: Partial<BrokerKeySnapshot> = {}
      const a: Partial<BrokerKeySnapshot> = {}
      const note = <K extends keyof BrokerKeySnapshot>(k: K) => {
        if (same(before[k], after[k])) return false
        b[k] = before[k]
        a[k] = after[k]
        return true
      }
      if (note('displayName')) changes.displayName = after.displayName
      if (note('destinations')) changes.destinations = JSON.stringify(after.destinations)
      if (note('audience')) changes.audience = JSON.stringify(after.audience)
      if (note('caps')) changes.caps = JSON.stringify(after.caps)
      if (note('allowPrivateContent')) changes.allowPrivateContent = after.allowPrivateContent
      if (note('status')) changes.status = after.status
      if (Object.keys(changes).length > 0) {
        const at = clock.now()
        brokerKeys.update(member.companyId, keyId, changes, at, member.userId, changeRow(member, at, keyId, {
          action: 'update', service: row.service, displayName: after.displayName, before: b, after: a,
        }))
      }
      return ok(view(member.companyId))
    },

    /**
     * POST …/broker/stop-all — the emergency stop's 「鍵」 unit for everything:
     * every active key (company and own) is disabled at once (the relay re-decides
     * on every call, so a running AI gets 「管理者が…止めています」 at its next call). Each key's
     * stop is in the history; resuming is per key.
     */
    stopAll(member: Member): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      const at = clock.now()
      for (const row of brokerKeys.list(member.companyId).filter(r => r.status === 'active')) {
        brokerKeys.update(member.companyId, row.id, { status: 'disabled' }, at, member.userId, changeRow(member, at, row.id, {
          action: 'update', service: row.service, displayName: row.displayName, before: { status: 'active' }, after: { status: 'disabled' },
        }))
      }
      return ok(view(member.companyId))
    },

    /** DELETE …/broker/keys/:keyId */
    delete(member: Member, keyId: string): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      const row = brokerKeys.find(member.companyId, keyId)
      if (!row) return refuse('not-found', 'API key not found')
      const at = clock.now()
      brokerKeys.delete(member.companyId, keyId, changeRow(member, at, keyId, { action: 'delete', key: snapshot(row) }))
      return ok(view(member.companyId))
    },

    /** PUT …/broker/services/:service { category, rule, ownKeyHosts } */
    setService(member: Member, service: string, body: unknown): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isValidBrokerServiceName(service)) return refuse('bad-request', 'service must be a lower-case ASCII name (a-z, 0-9, -, _)')
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      if (!has(BROKER_SERVICE_CATEGORIES, body.category)) return refuse('bad-request', 'category must be person, tool or system')
      if (!has(BROKER_KEY_RULES, body.rule)) return refuse('bad-request', 'rule must be company-only, user-only or company-first')
      const hosts = parseOwnKeyHosts(body.ownKeyHosts ?? [])
      if ('error' in hosts) return refuse('bad-request', hosts.error)
      const stored = serviceSettings(member.companyId).get(service)
      const hostsError = relayHostsError(relayOf(stored), hosts.value, 'ownKeyHosts')
      if (hostsError) return refuse('bad-request', hostsError)
      const builtinHosts = builtinHostsRefusal(service, hosts.value)
      if (builtinHosts) return builtinHosts
      saveServiceSetting(member, service, stored, { category: body.category, rule: body.rule, ownKeyHosts: hosts.value })
      return ok(view(member.companyId))
    },

    /**
     * PUT …/broker/services/:service/own-keys { allowed } — the one switch
     * 「メンバーが自分の鍵を使ってよい」 for a service whose destination is known
     * (built-in: its hosts; generic: its one host): own keys may go exactly
     * there and 「会社の鍵だけ」 becomes 会社優先 (`ownKeysSwitchSetting`). Off:
     * no own-key hosts, 「会社の鍵だけ」. A service with keys only (no known
     * host) → 400 `HOSTS_REQUIRED`: its hosts are typed in the detailed form.
     */
    setOwnKeys(member: Member, service: string, body: unknown): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isValidBrokerServiceName(service)) return refuse('bad-request', 'service must be a lower-case ASCII name (a-z, 0-9, -, _)')
      if (!isObject(body) || typeof body.allowed !== 'boolean') return refuse('bad-request', 'allowed must be true or false')
      const stored = serviceSettings(member.companyId).get(service)
      const builtin = builtinBrokerService(service)
      const relay = builtin ? null : relayOf(stored)
      if (!builtin && !relay && !stored && !brokerKeys.list(member.companyId).some(r => r.service === service)) return refuse('not-found', 'Unknown service')
      const knownHosts = builtin ? builtin.defaultHosts : relay ? [relay.host] : []
      const current = serviceSettingOf(stored, service)
      const next = ownKeysSwitchSetting(current, knownHosts, body.allowed)
      if (!next) return refuse('bad-request', 'This service has no known destination: set its own-key hosts with PUT …/broker/services/:service', { code: 'HOSTS_REQUIRED' })
      saveServiceSetting(member, service, stored, { category: current.category, ...next })
      return ok(view(member.companyId))
    },

    /**
     * PUT …/broker/services/:service/read-only { readOnly } — the relay
     * forwards only reads for the service (GET / HEAD and the built-in
     * service's read-only POSTs, `brokerRelayReadOnlyAllows`). Milestone 3:
     * turned on for HubSpot when its plugin is on (P4), so writes go only
     * through the plugin's typed operations. History action `read-only`.
     */
    setReadOnly(member: Member, service: string, body: unknown): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isValidBrokerServiceName(service)) return refuse('bad-request', 'service must be a lower-case ASCII name (a-z, 0-9, -, _)')
      if (!isObject(body) || typeof body.readOnly !== 'boolean') return refuse('bad-request', 'readOnly must be true or false')
      const stored = serviceSettings(member.companyId).get(service)
      if (!builtinBrokerService(service) && !relayOf(stored)) return refuse('not-found', 'Unknown service')
      const before = stored?.readOnly ?? false
      if (!body.readOnly && deps.managedByPlugin?.(member.companyId, service)) {
        return refuse('conflict', 'つなぎ先のプラグインが管理しているため、読むだけのままです（書き換えはプラグインの決まった操作からだけ行います）', { code: 'MANAGED_BY_PLUGIN' })
      }
      if (before === body.readOnly) return ok(view(member.companyId))
      const setting = serviceSettingOf(stored, service)
      const at = clock.now()
      brokerKeys.saveService(member.companyId, {
        service, category: setting.category, rule: setting.rule, ownKeyHosts: JSON.stringify(setting.ownKeyHosts),
        relay: stored?.relay ?? null, readOnly: body.readOnly, updatedAt: at, updatedBy: member.userId,
      }, changeRow(member, at, null, { action: 'read-only', service, before, after: body.readOnly }))
      return ok(view(member.companyId))
    },

    /** The relay forwards only reads for this service (the company's switch). */
    relayReadOnly(companyId: string, service: string): boolean {
      return serviceSettings(companyId).get(service)?.readOnly ?? false
    },

    /**
     * PUT …/broker/relay-services/:service { label, baseUrl, header, format?, category? } —
     * register or change a generic service (K9). Its host cannot change while
     * keys exist for it (they were registered for the old host): 409
     * `SERVICE_HAS_KEYS`.
     */
    setRelayService(member: Member, service: string, body: unknown): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isValidRelayServiceId(service)) {
        return refuse('bad-request', 'service must be 2–32 lower-case letters and digits, words joined by "-", starting with a letter, and not a built-in service')
      }
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const def = parseBrokerRelayDefinition(body)
      if ('error' in def) return refuse('bad-request', def.error)
      if (body.category !== undefined && !has(BROKER_SERVICE_CATEGORIES, body.category)) return refuse('bad-request', 'category must be person, tool or system')
      const stored = serviceSettings(member.companyId).get(service)
      const before = relayOf(stored)
      const after = def.value
      if (!before) {
        const keys = brokerKeys.list(member.companyId).filter(r => r.service === service)
        if (keys.some(r => parseJson<BrokerDestinations>(r.destinations, { hosts: [], pathPrefixes: [], models: [] }).hosts.some(h => h !== after.host))) {
          return refuse('conflict', 'Keys registered for this service go to other hosts; delete them first', { code: 'SERVICE_HAS_KEYS' })
        }
      }
      if (before && before.host !== after.host && brokerKeys.list(member.companyId).some(r => r.service === service)) {
        return refuse('conflict', 'The host cannot change while keys exist for this service; delete them first', { code: 'SERVICE_HAS_KEYS' })
      }
      if (same(before, after)) return ok(view(member.companyId))
      const setting = stored ? serviceSettingOf(stored, service) : null
      const category: BrokerServiceCategory = setting?.category ?? (body.category as BrokerServiceCategory | undefined) ?? 'tool'
      const at = clock.now()
      brokerKeys.saveService(member.companyId, {
        service,
        category,
        rule: setting?.rule ?? defaultBrokerRule(category),
        // Own keys may go only to the service's host.
        ownKeyHosts: JSON.stringify((setting?.ownKeyHosts ?? []).filter(h => h === after.host)),
        relay: JSON.stringify(after),
        readOnly: stored?.readOnly ?? false,
        updatedAt: at,
        updatedBy: member.userId,
      }, changeRow(member, at, null, { action: 'relay-service', service, before, after }))
      return ok(view(member.companyId))
    },

    /** DELETE …/broker/relay-services/:service — only once no key exists for it (409 `SERVICE_HAS_KEYS`). */
    deleteRelayService(member: Member, service: string): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      const stored = isValidRelayServiceId(service) ? serviceSettings(member.companyId).get(service) : undefined
      const before = relayOf(stored)
      if (!before) return refuse('not-found', 'Service not found')
      if (brokerKeys.list(member.companyId).some(r => r.service === service)) {
        return refuse('conflict', 'Delete the keys registered for this service first', { code: 'SERVICE_HAS_KEYS' })
      }
      const at = clock.now()
      brokerKeys.deleteService(member.companyId, service, changeRow(member, at, null, { action: 'relay-service', service, before, after: null }))
      return ok(view(member.companyId))
    },

    /** PUT …/broker/settings { memberKeysAllowed?, internalHosts? } (at least one) */
    setSettings(member: Member, body: unknown): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body) || (body.memberKeysAllowed === undefined && body.internalHosts === undefined)) {
        return refuse('bad-request', 'memberKeysAllowed must be true or false')
      }
      if (body.memberKeysAllowed !== undefined && typeof body.memberKeysAllowed !== 'boolean') return refuse('bad-request', 'memberKeysAllowed must be true or false')
      const hosts = body.internalHosts === undefined ? null : parseInternalHosts(body.internalHosts)
      if (hosts && 'error' in hosts) return refuse('bad-request', hosts.error)
      const stored = brokerKeys.settings(member.companyId)
      const before = { memberKeysAllowed: stored?.memberKeysAllowed ?? true, internalHosts: stored ? parseJson<string[]>(stored.internalHosts, []) : [] }
      const after = {
        memberKeysAllowed: typeof body.memberKeysAllowed === 'boolean' ? body.memberKeysAllowed : before.memberKeysAllowed,
        internalHosts: hosts ? hosts.value : before.internalHosts,
      }
      if (!same(before, after)) {
        const at = clock.now()
        const hostsChanged = !same(before.internalHosts, after.internalHosts)
        brokerKeys.saveSettings(member.companyId, { memberKeysAllowed: after.memberKeysAllowed, internalHosts: JSON.stringify(after.internalHosts), updatedAt: at, updatedBy: member.userId },
          changeRow(member, at, null, {
            action: 'settings',
            before: { memberKeysAllowed: before.memberKeysAllowed, ...(hostsChanged ? { internalHosts: before.internalHosts } : {}) },
            after: { memberKeysAllowed: after.memberKeysAllowed, ...(hostsChanged ? { internalHosts: after.internalHosts } : {}) },
          }))
      }
      return ok(view(member.companyId))
    },

    /** Hosts the relay may reach at private addresses (the company's explicit exception). */
    internalHosts(companyId: string): string[] {
      const stored = brokerKeys.settings(companyId)
      return stored ? parseJson<string[]>(stored.internalHosts, []) : []
    },

    /** The service's decision rule and own-key hosts (defaults when unset) — for tokens and the relay. */
    serviceSetting(companyId: string, service: string): BrokerServiceSetting {
      return serviceSettingOf(serviceSettings(companyId).get(service), service)
    },

    /** A generic service's definition (K9) — where the relay sends it and how; undefined when not one. */
    relayService(companyId: string, service: string): BrokerRelayDefinition | undefined {
      if (builtinBrokerService(service) || !isValidRelayServiceId(service)) return undefined
      return relayOf(serviceSettings(companyId).get(service)) ?? undefined
    },

    /** What people see for a service: the built-in label, a generic service's label, else its name. */
    serviceLabel(companyId: string, service: string): string {
      return builtinBrokerService(service)?.label ?? relayOf(serviceSettings(companyId).get(service))?.label ?? service
    },

    /** Members may register own keys (default on). */
    memberKeysAllowed(companyId: string): boolean {
      return brokerKeys.settings(companyId)?.memberKeysAllowed ?? true
    },

    /** Services the company configured (a row in broker_services). */
    knownServices(companyId: string): string[] {
      return brokerKeys.services(companyId).map(s => s.service)
    },

    /** The consultation's department (dial ①), for tokens. */
    departmentIdOfFolder,

    /** The one check of a key being saved (own keys use it too). */
    checkKey,
  }
}

export type KeyBrokerService = ReturnType<typeof createKeyBrokerService>
