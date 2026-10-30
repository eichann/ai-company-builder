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
 * Who may use a company key (`usableBy`): everyone, or the members of its
 * departments, plus people added by name, minus people removed by name. A
 * member belongs to a department when the permission rules let them read
 * its folder (ACB has no other department membership). Own keys: the owner.
 */
import {
  BROKER_KEY_RULES,
  BROKER_KEY_STATUSES,
  BROKER_SERVICE_CATEGORIES,
  BUILTIN_BROKER_SERVICES,
  NO_BROKER_CAPS,
  NOBODY,
  brokerSecretLast4,
  builtinBrokerService,
  checkBrokerSecret,
  companyKeyEligibility,
  defaultBrokerRule,
  isValidBrokerServiceName,
  parseBrokerAudience,
  parseBrokerCaps,
  parseBrokerDestinations,
  parseBrokerDisplayName,
  parseOwnKeyHosts,
  type BrokerAudience,
  type BrokerCaps,
  type BrokerDestinations,
  type BrokerKeyRule,
  type BrokerKeyScope,
  type BrokerKeyStatus,
  type BrokerServiceCategory,
} from '../../shared/core/key-broker'
import { resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
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
import type { DepartmentRepository } from '../ports/departments'
import type { BrokerKeyChanges, BrokerKeyRepository, BrokerKeyRow, StoredBrokerService } from '../ports/key-broker'
import type { MembershipRepository } from '../ports/memberships'
import type { ScopeRepository } from '../ports/scopes'
import { hasFullAccess, requireFullAccess, type Member } from './access'
import type { BrokerVault } from './broker-vault'
import { ok, refuse, type Outcome } from './outcome'

export const KEY_BROKER_FORBIDDEN = 'Only owners and admins can manage API keys'
export const BROKER_OFF_ERROR = 'The key broker is off: the server has no key-encryption key (BROKER_KEK_FILE)'
const HISTORY_LIMIT = 50

export interface KeyBrokerDeps {
  brokerKeys: BrokerKeyRepository
  brokerVault: BrokerVault
  memberships: MembershipRepository
  departments: DepartmentRepository
  scopes: ScopeRepository
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
}

const has = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T } catch { return fallback }
}

/** A stored key's parsed fields (rows written by this service; a damaged field falls back to "nothing allowed"). */
function decoded(row: BrokerKeyRow) {
  const destinations = parseJson<BrokerDestinations>(row.destinations, { hosts: [], pathPrefixes: [], models: [] })
  const audience = row.scope === 'company' ? parseJson<BrokerAudience>(row.audience, NOBODY) : NOBODY
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

export function createKeyBrokerService(deps: KeyBrokerDeps) {
  const { brokerKeys, brokerVault, memberships, departments, scopes, accounts, clock, ids } = deps

  /** Does the member belong to the department (can read its folder)? Cached per call. */
  function departmentMembership(companyId: string) {
    const list = scopes.listWithRules(companyId)
    const folders = new Map(departments.listByCompany(companyId).map(d => [d.id, d.folder]))
    const cache = new Map<string, boolean>()
    return (userId: string, role: string) => (departmentId: string): boolean => {
      const folder = folders.get(departmentId)
      if (folder === undefined) return false
      const key = `${userId}\0${departmentId}`
      let v = cache.get(key)
      if (v === undefined) {
        const repo: PermissionRepository = { getMemberRole: () => role, listScopes: () => list }
        v = hasFullAccess(role) || resolveAccess(companyId, userId, folder, repo).read
        cache.set(key, v)
      }
      return v
    }
  }

  function serviceSettings(companyId: string): Map<string, StoredBrokerService> {
    return new Map(brokerKeys.services(companyId).map(s => [s.service, s]))
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
    const members = memberships.listByCompany(companyId)
    const inDepartment = departmentMembership(companyId)
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
          const via = companyKeyEligibility(s.audience, m.user_id, inDepartment(m.user_id, m.role))
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
      }
    })

    const stored = serviceSettings(companyId)
    const names = [...new Set([...BUILTIN_BROKER_SERVICES.map(s => s.service), ...stored.keys(), ...rows.map(r => r.service)])]
    const services: BrokerServiceView[] = names.map(service => {
      const builtin = builtinBrokerService(service)
      const setting = serviceSettingOf(stored.get(service), service)
      return {
        service,
        label: builtin?.label ?? service,
        builtin: !!builtin,
        ...setting,
        defaultHosts: builtin ? [...builtin.defaultHosts] : [],
        companyKeys: rows.filter(r => r.service === service && r.scope === 'company').length,
        userKeys: rows.filter(r => r.service === service && r.scope === 'user').length,
        updatedAt: stored.get(service)?.updatedAt ?? null,
      }
    })

    const settings = brokerKeys.settings(companyId)
    const status = brokerVault.status()
    return {
      status: { enabled: status.enabled, reason: status.enabled ? null : status.reason },
      settings: { memberKeysAllowed: settings?.memberKeysAllowed ?? true, updatedAt: settings?.updatedAt ?? null, updatedBy: settings?.updatedBy ?? null },
      services,
      keys,
      departments: departments.listByCompany(companyId).map(d => ({ id: d.id, name: d.name, folder: d.folder })),
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
    const departmentIds = new Set(departments.listByCompany(companyId).map(d => d.id))
    if (audience.departmentIds.some(id => !departmentIds.has(id))) return 'audience.departmentIds: unknown department'
    const userIds = new Set(memberships.listByCompany(companyId).map(m => m.user_id))
    if ([...audience.addUserIds, ...audience.removeUserIds].some(id => !userIds.has(id))) return 'audience: unknown member'
    return null
  }

  function parseCapsPatch(input: unknown, base: BrokerCaps) {
    if (!isObject(input)) return parseBrokerCaps(input)
    return parseBrokerCaps({ ...base, ...input })
  }

  return {
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
      const builtin = builtinBrokerService(service)
      const destinations = body.destinations === undefined && builtin
        ? { value: { hosts: [...builtin.defaultHosts], pathPrefixes: [], models: [] } }
        : parseBrokerDestinations(body.destinations)
      if ('error' in destinations) return refuse('bad-request', destinations.error)
      const audience = parseBrokerAudience(body.audience)
      if ('error' in audience) return refuse('bad-request', audience.error)
      const caps = parseBrokerCaps(body.caps)
      if ('error' in caps) return refuse('bad-request', caps.error)
      if (body.allowPrivateContent !== undefined && typeof body.allowPrivateContent !== 'boolean') return refuse('bad-request', 'allowPrivateContent must be true or false')
      const audienceError = checkAudience(member.companyId, audience.value)
      if (audienceError) return refuse('bad-request', audienceError)
      if (!brokerVault.status().enabled) return refuse('unavailable', BROKER_OFF_ERROR, { code: 'BROKER_OFF' })

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
      brokerKeys.insert(row, sealed, changeRow(member, at, keyId, { action: 'create', key: snapshot(row) }))
      return ok(view(member.companyId))
    },

    /** PUT …/broker/keys/:keyId/secret: replace the value (company or own key). */
    async replaceSecret(member: Member, keyId: string, body: unknown): Promise<Outcome<BrokerView>> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const secret = checkBrokerSecret(body.secret)
      if ('error' in secret) return refuse('bad-request', secret.error)
      if (!brokerKeys.find(member.companyId, keyId)) return refuse('not-found', 'API key not found')
      if (!brokerVault.status().enabled) return refuse('unavailable', BROKER_OFF_ERROR, { code: 'BROKER_OFF' })
      const sealed = await brokerVault.seal(member.companyId, keyId, secret.value)
      const current = brokerKeys.find(member.companyId, keyId)
      if (!current) return refuse('not-found', 'API key not found')
      const at = clock.now()
      const last4 = brokerSecretLast4(secret.value)
      brokerKeys.replaceSecret(member.companyId, keyId, sealed, last4, at, member.userId, changeRow(member, at, keyId, {
        action: 'replace', service: current.service, displayName: current.displayName, last4Before: current.last4, last4After: last4,
      }))
      return ok(view(member.companyId))
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
      const before = stored ? serviceSettingOf(stored, service) : null
      const after: BrokerServiceSetting = { category: body.category, rule: body.rule, ownKeyHosts: hosts.value }
      if (!same(before, after)) {
        const at = clock.now()
        brokerKeys.saveService(member.companyId, {
          service, category: after.category, rule: after.rule, ownKeyHosts: JSON.stringify(after.ownKeyHosts), updatedAt: at, updatedBy: member.userId,
        }, changeRow(member, at, null, { action: 'service', service, before, after }))
      }
      return ok(view(member.companyId))
    },

    /** PUT …/broker/settings { memberKeysAllowed } */
    setSettings(member: Member, body: unknown): Outcome<BrokerView> {
      const allowed = requireFullAccess(member, KEY_BROKER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body) || typeof body.memberKeysAllowed !== 'boolean') return refuse('bad-request', 'memberKeysAllowed must be true or false')
      const before = brokerKeys.settings(member.companyId)?.memberKeysAllowed ?? true
      if (before !== body.memberKeysAllowed) {
        const at = clock.now()
        brokerKeys.saveSettings(member.companyId, { memberKeysAllowed: body.memberKeysAllowed, updatedAt: at, updatedBy: member.userId },
          changeRow(member, at, null, { action: 'settings', before: { memberKeysAllowed: before }, after: { memberKeysAllowed: body.memberKeysAllowed } }))
      }
      return ok(view(member.companyId))
    },

    /** The service's decision rule and own-key hosts (defaults when unset) — for tokens and the relay. */
    serviceSetting(companyId: string, service: string): BrokerServiceSetting {
      return serviceSettingOf(serviceSettings(companyId).get(service), service)
    },

    /** Members may register own keys (default on). */
    memberKeysAllowed(companyId: string): boolean {
      return brokerKeys.settings(companyId)?.memberKeysAllowed ?? true
    },

    /** Department membership as `usableBy` decides it, for tokens. */
    departmentMembership,
  }
}

export type KeyBrokerService = ReturnType<typeof createKeyBrokerService>
