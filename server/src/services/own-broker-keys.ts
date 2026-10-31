/**
 * A member's own API keys (K8, 「自分の鍵」, .claude/rules/key-broker.md): any
 * member, from the desktop app's settings, registers, replaces or deletes
 * their own key for a service — only where the company allows own keys
 * (the members' switch, a service rule other than 「会社の鍵だけ」, and at
 * least one own-key destination the admin allowed). The key is sent only to
 * those destinations, is usable by its owner alone, and is never answered:
 * the app sees its last four characters.
 *
 * Every change is written to broker_history like an admin's, so the admin
 * page's history shows it. An admin's stop (status 'disabled') survives a
 * replacement; only an admin resumes it.
 */
import {
  BUILTIN_BROKER_SERVICES,
  brokerSecretLast4,
  builtinBrokerService,
  checkBrokerSecret,
  companyKeyEligibility,
  isValidBrokerServiceName,
  parseBrokerDisplayName,
  upgradeBrokerAudience,
  type BrokerDestinations,
  type BrokerKeyStatus,
} from '../../shared/core/key-broker'
import type { BrokerChangeDetail, BrokerKeySnapshot, MyBrokerKeys, MyBrokerService, OwnKeyBlocked } from '../../shared/types/key-broker'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { BrokerKeyRepository, BrokerKeyRow } from '../ports/key-broker'
import type { Member } from './access'
import type { BrokerVault } from './broker-vault'
import { BROKER_OFF_ERROR, KEY_REJECTED_ERROR, type KeyBrokerService } from './key-broker'
import { ok, refuse, type Outcome } from './outcome'

export interface OwnBrokerKeyDeps {
  brokerKeys: BrokerKeyRepository
  brokerVault: BrokerVault
  keyBroker: KeyBrokerService
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
}

const OWN_KEY_BLOCKED_ERROR: Record<OwnKeyBlocked, string> = {
  'member-keys-off': 'The company does not allow members to register their own keys',
  'company-only': 'This service uses the company\'s keys only',
  'no-destinations': 'The company has not allowed own keys for this service yet',
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T } catch { return fallback }
}

function snapshot(row: BrokerKeyRow): BrokerKeySnapshot {
  return {
    service: row.service,
    scope: 'user',
    ownerUserId: row.ownerUserId,
    displayName: row.displayName,
    last4: row.last4,
    destinations: parseJson<BrokerDestinations>(row.destinations, { hosts: [], pathPrefixes: [], models: [] }),
    audience: upgradeBrokerAudience(null),
    caps: { requestsPerDay: null, tokensPerDay: null, requestsPerMemberPerDay: null, tokensPerMemberPerDay: null },
    allowPrivateContent: false,
    status: row.status as BrokerKeyStatus,
  }
}

export function createOwnBrokerKeyService(deps: OwnBrokerKeyDeps) {
  const { brokerKeys, brokerVault, keyBroker, companyData, clock, ids } = deps

  /** May the member register an own key for the service now? */
  function ownKeyAllowance(companyId: string, service: string): MyBrokerService['ownKey'] {
    if (!keyBroker.memberKeysAllowed(companyId)) return { allowed: false, reason: 'member-keys-off' }
    const setting = keyBroker.serviceSetting(companyId, service)
    if (setting.rule === 'company-only') return { allowed: false, reason: 'company-only' }
    if (setting.ownKeyHosts.length === 0) return { allowed: false, reason: 'no-destinations' }
    return { allowed: true, hosts: setting.ownKeyHosts }
  }

  const ownRow = (member: Member, service: string, rows = brokerKeys.list(member.companyId)) =>
    rows.find(r => r.scope === 'user' && r.ownerUserId === member.userId && r.service === service) ?? null

  function view(member: Member): MyBrokerKeys {
    const rows = brokerKeys.list(member.companyId)
    const departmentNames = new Map(companyData.forCompany(member.companyId).departments.list().map(d => [d.id, d.name]))
    const names = [...new Set([
      ...BUILTIN_BROKER_SERVICES.map(s => s.service),
      ...keyBroker.knownServices(member.companyId),
      ...rows.filter(r => r.scope === 'company' || r.ownerUserId === member.userId).map(r => r.service),
    ])]
    const services = names.map((service): MyBrokerService => {
      const setting = keyBroker.serviceSetting(member.companyId, service)
      const own = ownRow(member, service, rows)
      return {
        service,
        label: keyBroker.serviceLabel(member.companyId, service),
        category: setting.category,
        rule: setting.rule,
        ownKey: ownKeyAllowance(member.companyId, service),
        companyKeys: rows
          .filter(r => r.scope === 'company' && r.service === service && r.status === 'active')
          .flatMap(r => {
            const audience = upgradeBrokerAudience(parseJson<unknown>(r.audience, null))
            if (companyKeyEligibility(audience, member.userId) === null) return []
            return [{
              displayName: r.displayName,
              allDepartments: audience.allDepartments,
              departments: audience.departmentIds.flatMap(id => (departmentNames.has(id) ? [departmentNames.get(id)!] : [])),
            }]
          }),
        key: own
          ? {
            id: own.id,
            displayName: own.displayName,
            last4: own.last4,
            hosts: parseJson<BrokerDestinations>(own.destinations, { hosts: [], pathPrefixes: [], models: [] }).hosts,
            status: own.status as BrokerKeyStatus,
            secretUpdatedAt: own.secretUpdatedAt,
          }
          : null,
      }
    })
    return { enabled: brokerVault.status().enabled, memberKeysAllowed: keyBroker.memberKeysAllowed(member.companyId), services }
  }

  function changeRow(member: Member, at: string, keyId: string, change: BrokerChangeDetail) {
    return { id: ids.newId(), changedAt: at, changedBy: member.userId, keyId, action: change.action, change: JSON.stringify(change) }
  }

  return {
    /** GET …/me/broker-keys */
    list(member: Member): Outcome<MyBrokerKeys> {
      return ok(view(member))
    },

    /** PUT …/me/broker-keys/:service { secret, displayName? } — register or replace. */
    async save(member: Member, service: string, body: unknown): Promise<Outcome<MyBrokerKeys>> {
      if (!isValidBrokerServiceName(service)) return refuse('bad-request', 'service must be a lower-case ASCII name (a-z, 0-9, -, _)')
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const secret = checkBrokerSecret(body.secret)
      if ('error' in secret) return refuse('bad-request', secret.error)
      const practice = deps.keyBroker.practiceSecretRefusal(service, secret.value)
      if (practice) return practice
      let displayName: string | undefined
      if (body.displayName !== undefined) {
        const name = parseBrokerDisplayName(body.displayName)
        if ('error' in name) return refuse('bad-request', name.error)
        displayName = name.value
      }
      if (!builtinBrokerService(service) && !keyBroker.knownServices(member.companyId).includes(service)) {
        return refuse('not-found', 'Unknown service')
      }
      const allowance = ownKeyAllowance(member.companyId, service)
      if (!allowance.allowed) return refuse('forbidden', OWN_KEY_BLOCKED_ERROR[allowance.reason], { code: 'OWN_KEY_NOT_ALLOWED', reason: allowance.reason })
      if (!brokerVault.status().enabled) return refuse('unavailable', BROKER_OFF_ERROR, { code: 'BROKER_OFF' })
      // One read-only request to the service's fixed host; a key it refuses is not saved.
      const check = await keyBroker.checkKey(member.companyId, service, secret.value, allowance.hosts)
      if (check === 'rejected') return refuse('bad-request', KEY_REJECTED_ERROR, { code: 'KEY_REJECTED' })
      const answer = (): MyBrokerKeys => (check ? { ...view(member), check: { service, result: check } } : view(member))

      const existing = ownRow(member, service)
      const keyId = existing?.id ?? ids.newId()
      const sealed = await brokerVault.seal(member.companyId, keyId, secret.value)
      const at = clock.now()
      const last4 = brokerSecretLast4(secret.value)
      const destinations = JSON.stringify({ hosts: allowance.hosts, pathPrefixes: [], models: [] })
      // Re-read after the await: another request may have registered or deleted it meanwhile.
      const current = ownRow(member, service)
      if (current && current.id === keyId) {
        brokerKeys.replaceSecret(member.companyId, keyId, sealed, last4, at, member.userId, changeRow(member, at, keyId, {
          action: 'replace', service, displayName: current.displayName, last4Before: current.last4, last4After: last4, ...(check ? { check } : {}),
        }))
        const changes: { displayName?: string; destinations?: string } = {}
        if (displayName && displayName !== current.displayName) changes.displayName = displayName
        if (destinations !== current.destinations) changes.destinations = destinations
        if (Object.keys(changes).length > 0) {
          const before = snapshot(current)
          const after = snapshot({ ...current, ...changes })
          brokerKeys.update(member.companyId, keyId, changes, at, member.userId, changeRow(member, at, keyId, {
            action: 'update', service, displayName: after.displayName,
            before: { ...(changes.displayName ? { displayName: before.displayName } : {}), ...(changes.destinations ? { destinations: before.destinations } : {}) },
            after: { ...(changes.displayName ? { displayName: after.displayName } : {}), ...(changes.destinations ? { destinations: after.destinations } : {}) },
          }))
        }
        return ok(answer())
      }
      if (current) return refuse('conflict', 'Your key for this service changed meanwhile; try again')
      const row: BrokerKeyRow = {
        id: keyId,
        companyId: member.companyId,
        scope: 'user',
        ownerUserId: member.userId,
        service,
        displayName: displayName ?? `${keyBroker.serviceLabel(member.companyId, service)}（自分の鍵）`,
        last4,
        destinations,
        audience: JSON.stringify(upgradeBrokerAudience(null)),
        caps: '{}',
        allowPrivateContent: false,
        status: 'active',
        kekId: sealed.kekId,
        createdAt: at,
        createdBy: member.userId,
        updatedAt: at,
        updatedBy: member.userId,
        secretUpdatedAt: at,
      }
      brokerKeys.insert(row, sealed, changeRow(member, at, keyId, { action: 'create', key: snapshot(row), ...(check ? { check } : {}) }))
      return ok(answer())
    },

    /** DELETE …/me/broker-keys/:service — always allowed (even with own keys switched off). */
    remove(member: Member, service: string): Outcome<MyBrokerKeys> {
      const row = isValidBrokerServiceName(service) ? ownRow(member, service) : null
      if (!row) return refuse('not-found', 'You have no key for this service')
      const at = clock.now()
      brokerKeys.delete(member.companyId, row.id, changeRow(member, at, row.id, { action: 'delete', key: snapshot(row) }))
      return ok(view(member))
    },
  }
}

export type OwnBrokerKeyService = ReturnType<typeof createOwnBrokerKeyService>
