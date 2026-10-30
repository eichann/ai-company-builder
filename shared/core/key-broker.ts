/**
 * The API key broker (「API キー」): one copy of its vocabulary and input
 * rules for the server (the vault, the admin API, short-lived tokens), the
 * admin console (the page that edits it) and, later, the desktop app.
 *
 * Owner decisions (docs/key-broker-plan.md, 2026-10-30):
 * - Two kinds of key: a **company key** (registered by an owner/admin, used by
 *   departments or everyone plus per-person exceptions) and a member's **own
 *   key** (usable by that member only). Both live in the server's vault;
 *   nothing is ever sent back in plain text.
 * - Skills ask for a **service**, not a key. Per service the company chooses
 *   which key applies: company only / own only / company first, then own.
 *   Defaults by what the service acts as: a person (Gmail, Slack) → own key
 *   only; a tool (OpenAI, Gemini) or a company system → company key only.
 * - Members may register own keys (default on), only for destinations the
 *   admin allowed.
 */
import { normalizeSandboxDomain } from './agent-sandbox'

export type BrokerKeyScope = 'company' | 'user'
export const BROKER_KEY_SCOPES: readonly BrokerKeyScope[] = ['company', 'user']

/**
 * Why the broker is off: no key-encryption key configured, or one the server
 * refused (unreadable, malformed, readable by others / inside the data folder).
 */
export type BrokerStatusReason = 'not-configured' | 'kek-unreadable' | 'kek-invalid' | 'kek-insecure'
export const BROKER_STATUS_REASONS: readonly BrokerStatusReason[] = ['not-configured', 'kek-unreadable', 'kek-invalid', 'kek-insecure']

export type BrokerKeyStatus = 'active' | 'disabled'
export const BROKER_KEY_STATUSES: readonly BrokerKeyStatus[] = ['active', 'disabled']

/**
 * What the service's API acts as (「サービスの3分類」):
 * - `person`: acts as the member (mail, chat, calendar) → own keys by default;
 * - `tool`: a tool anyone may use on the company's account (AI APIs, maps);
 * - `system`: the company's own systems (CRM, accounting).
 */
export type BrokerServiceCategory = 'person' | 'tool' | 'system'
export const BROKER_SERVICE_CATEGORIES: readonly BrokerServiceCategory[] = ['person', 'tool', 'system']

/** Which key a request for the service uses (「決め方」). */
export type BrokerKeyRule = 'company-only' | 'user-only' | 'company-first'
export const BROKER_KEY_RULES: readonly BrokerKeyRule[] = ['company-only', 'user-only', 'company-first']

export function defaultBrokerRule(category: BrokerServiceCategory): BrokerKeyRule {
  return category === 'person' ? 'user-only' : 'company-only'
}

export interface BrokerServiceInfo {
  service: string
  label: string
  category: BrokerServiceCategory
  /** Where the relay sends this service's requests unless the key says otherwise. */
  defaultHosts: readonly string[]
}

/** The services the relay knows from the start (stage 1: Gemini → OpenAI → Anthropic). */
export const BUILTIN_BROKER_SERVICES: readonly BrokerServiceInfo[] = [
  { service: 'gemini', label: 'Google Gemini', category: 'tool', defaultHosts: ['generativelanguage.googleapis.com'] },
  { service: 'openai', label: 'OpenAI', category: 'tool', defaultHosts: ['api.openai.com'] },
  { service: 'anthropic', label: 'Anthropic（Claude API）', category: 'tool', defaultHosts: ['api.anthropic.com'] },
]

export function builtinBrokerService(service: string): BrokerServiceInfo | undefined {
  return BUILTIN_BROKER_SERVICES.find(s => s.service === service)
}

export const BROKER_LIMITS = {
  serviceName: 40,
  displayName: 80,
  secretMin: 8,
  secretMax: 4096,
  hosts: 20,
  pathPrefixes: 50,
  pathPrefixLength: 512,
  models: 100,
  modelLength: 100,
  audienceEntries: 500,
  /** Daily caps: a whole number from 1 to this, or null (none). */
  capMax: 1_000_000_000,
} as const

/** Service names are ASCII ids (`gemini`, `hubspot`, `case-master`). */
export function isValidBrokerServiceName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= BROKER_LIMITS.serviceName && /^[a-z0-9][a-z0-9_-]*$/.test(value)
}

/**
 * A destination host as the relay will compare it, or undefined: one exact
 * host (lower case, no scheme, port or path). Wildcards, IP literals and
 * `localhost` are refused — the relay sends a real key there, so the
 * destination must be named exactly.
 */
export function normalizeBrokerHost(input: unknown): string | undefined {
  const host = normalizeSandboxDomain(input)
  if (!host || host.startsWith('*.')) return undefined
  if (host.endsWith('.local') || host.endsWith('.internal')) return undefined
  return host
}

/**
 * A path prefix the key may be used for, or undefined: starts with `/`, no
 * query, fragment, `..` / `.` segments, backslashes or control characters.
 * A trailing `/` is kept (it means "below this folder").
 */
export function normalizeBrokerPathPrefix(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.trim()
  if (!value.startsWith('/') || value.length > BROKER_LIMITS.pathPrefixLength) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s?#\\%]/.test(value)) return undefined
  if (value.split('/').some(segment => segment === '.' || segment === '..')) return undefined
  if (value.includes('//')) return undefined
  return value
}

/** A model id (`gemini-2.5-flash`, `gpt-5`, `models/text-embedding-004`), or undefined. */
export function normalizeBrokerModel(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.trim()
  if (!value || value.length > BROKER_LIMITS.modelLength || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value)) return undefined
  return value
}

/** Where a key may be sent. Empty `pathPrefixes` / `models` = any path / model on those hosts. */
export interface BrokerDestinations {
  hosts: string[]
  pathPrefixes: string[]
  models: string[]
}

/**
 * Who may use a company key — two dials (owner decision 2026-10-30):
 * ① **for which work**: `allDepartments` (全社), or only consultations whose
 *    department is one of `departmentIds` — the department the chat is in,
 *    which the token records;
 * ② **by whom**: `everyone` (全員), or only the people in `addUserIds`; with
 *    per-person exceptions: `addUserIds` may always use it, `removeUserIds`
 *    never may (even under 全員).
 * Reading a department's folder no longer decides anything (where everyone
 * reads everything, that rule meant "everyone").
 */
export interface BrokerAudience {
  allDepartments: boolean
  departmentIds: string[]
  everyone: boolean
  addUserIds: string[]
  removeUserIds: string[]
}

/** Daily caps (null = none). Counted per company key, and per member on it. Enforced by the relay (K5). */
export interface BrokerCaps {
  requestsPerDay: number | null
  tokensPerDay: number | null
  requestsPerMemberPerDay: number | null
  tokensPerMemberPerDay: number | null
}

export const NO_BROKER_CAPS: BrokerCaps = { requestsPerDay: null, tokensPerDay: null, requestsPerMemberPerDay: null, tokensPerMemberPerDay: null }
export const NOBODY: BrokerAudience = { allDepartments: false, departmentIds: [], everyone: false, addUserIds: [], removeUserIds: [] }

type Parsed<T> = { value: T } | { error: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function uniqueList(input: unknown, normalize: (value: unknown) => string | undefined, limit: number, what: string): Parsed<string[]> {
  if (input === undefined) return { value: [] }
  if (!Array.isArray(input)) return { error: `${what} must be an array` }
  if (input.length > limit) return { error: `${what}: at most ${limit} entries` }
  const out: string[] = []
  for (const item of input) {
    const normalized = normalize(item)
    if (!normalized) return { error: `${what}: invalid entry` }
    if (!out.includes(normalized)) out.push(normalized)
  }
  return { value: out }
}

const idEntry = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined)

/** Destinations: at least one host. */
export function parseBrokerDestinations(input: unknown): Parsed<BrokerDestinations> {
  if (!isObject(input)) return { error: 'destinations must be an object' }
  const hosts = uniqueList(input.hosts, normalizeBrokerHost, BROKER_LIMITS.hosts, 'destinations.hosts')
  if ('error' in hosts) return hosts
  if (hosts.value.length === 0) return { error: 'destinations.hosts: at least one host is required' }
  const pathPrefixes = uniqueList(input.pathPrefixes, normalizeBrokerPathPrefix, BROKER_LIMITS.pathPrefixes, 'destinations.pathPrefixes')
  if ('error' in pathPrefixes) return pathPrefixes
  const models = uniqueList(input.models, normalizeBrokerModel, BROKER_LIMITS.models, 'destinations.models')
  if ('error' in models) return models
  return { value: { hosts: hosts.value, pathPrefixes: pathPrefixes.value, models: models.value } }
}

/** Own-key destinations of a service: may be empty (= members cannot register own keys for it). */
export function parseOwnKeyHosts(input: unknown): Parsed<string[]> {
  return uniqueList(input, normalizeBrokerHost, BROKER_LIMITS.hosts, 'ownKeyHosts')
}

/**
 * The audience an admin sent. Without `allDepartments` it is read in the K2
 * form and converted by `upgradeBrokerAudience`. Not 全社 needs at least one
 * department.
 */
export function parseBrokerAudience(input: unknown): Parsed<BrokerAudience> {
  if (!isObject(input)) return { error: 'audience must be an object' }
  if (typeof input.everyone !== 'boolean') return { error: 'audience.everyone must be true or false' }
  if (input.allDepartments !== undefined && typeof input.allDepartments !== 'boolean') return { error: 'audience.allDepartments must be true or false' }
  const lists: Partial<Record<'departmentIds' | 'addUserIds' | 'removeUserIds', string[]>> = {}
  for (const key of ['departmentIds', 'addUserIds', 'removeUserIds'] as const) {
    const list = uniqueList(input[key], idEntry, BROKER_LIMITS.audienceEntries, `audience.${key}`)
    if ('error' in list) return list
    lists[key] = list.value
  }
  const add = lists.addUserIds!
  const remove = lists.removeUserIds!
  if (add.some(id => remove.includes(id))) return { error: 'audience: a person cannot be both added and removed' }
  const audience = upgradeBrokerAudience({ ...input, departmentIds: lists.departmentIds, addUserIds: add, removeUserIds: remove })
  if (!audience.allDepartments && audience.departmentIds.length === 0) return { error: 'audience: choose allDepartments or at least one department' }
  return { value: audience }
}

/**
 * A stored or sent audience in the two-dial form. A K2-era audience (no
 * `allDepartments`) meant "everyone, or the members of these departments,
 * ± people", and a department's members were those who could read its folder
 * (everyone, by default). It becomes: departments listed → work in those
 * departments, by everyone (± people); none → 全社, by everyone or by the
 * added people. Anything unreadable is nobody.
 */
export function upgradeBrokerAudience(input: unknown): BrokerAudience {
  if (!isObject(input)) return { ...NOBODY }
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const departmentIds = ids(input.departmentIds)
  const addUserIds = ids(input.addUserIds)
  const removeUserIds = ids(input.removeUserIds)
  const everyone = input.everyone === true
  if (typeof input.allDepartments === 'boolean') {
    return { allDepartments: input.allDepartments, departmentIds: input.allDepartments ? [] : departmentIds, everyone, addUserIds, removeUserIds }
  }
  if (!everyone && departmentIds.length > 0) return { allDepartments: false, departmentIds, everyone: true, addUserIds, removeUserIds }
  return { allDepartments: true, departmentIds: [], everyone, addUserIds, removeUserIds }
}

export function parseBrokerCaps(input: unknown): Parsed<BrokerCaps> {
  if (input === undefined) return { value: { ...NO_BROKER_CAPS } }
  if (!isObject(input)) return { error: 'caps must be an object' }
  const out: BrokerCaps = { ...NO_BROKER_CAPS }
  for (const key of Object.keys(NO_BROKER_CAPS) as Array<keyof BrokerCaps>) {
    const v = input[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > BROKER_LIMITS.capMax) return { error: `caps.${key} must be a whole number from 1 to ${BROKER_LIMITS.capMax}, or null` }
    out[key] = v
  }
  return { value: out }
}

/**
 * The key value an admin pasted, checked without ever quoting it: printable
 * ASCII, no spaces, 8–4096 characters, not one of our own tokens. Errors
 * never contain the value (they reach the API answer and logs).
 */
export function checkBrokerSecret(input: unknown): Parsed<string> {
  if (typeof input !== 'string') return { error: 'secret must be a string' }
  const value = input.trim()
  if (value.length < BROKER_LIMITS.secretMin || value.length > BROKER_LIMITS.secretMax) {
    return { error: `secret must be ${BROKER_LIMITS.secretMin}–${BROKER_LIMITS.secretMax} characters` }
  }
  if (!/^[\x21-\x7e]+$/.test(value)) return { error: 'secret must be printable ASCII without spaces' }
  if (value.startsWith(BROKER_TOKEN_PREFIX)) return { error: 'secret is an ACB token, not the service\'s key' }
  return { value }
}

/** The part of a key shown anywhere: its last four characters. */
export function brokerSecretLast4(secret: string): string {
  return secret.slice(-4)
}

export function parseBrokerDisplayName(input: unknown): Parsed<string> {
  if (typeof input !== 'string') return { error: 'displayName must be a string' }
  const value = input.trim().normalize('NFC')
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > BROKER_LIMITS.displayName || /[\u0000-\u001f\u007f]/.test(value)) {
    return { error: `displayName must be 1–${BROKER_LIMITS.displayName} characters` }
  }
  return { value }
}

/**
 * Dial ② — why a member may use a company key, or null: removed by name →
 * never; added by name; everyone.
 */
export type BrokerEligibility = 'person' | 'everyone'
export function companyKeyEligibility(audience: BrokerAudience, userId: string): BrokerEligibility | null {
  if (audience.removeUserIds.includes(userId)) return null
  if (audience.addUserIds.includes(userId)) return 'person'
  if (audience.everyone) return 'everyone'
  return null
}

/**
 * Dial ① — may the key be used for work in this department? `departmentId`
 * is the consultation's department (null: none, or a folder the company
 * does not know as a department) — then only a 全社 key applies.
 */
export function companyKeyCoversDepartment(audience: BrokerAudience, departmentId: string | null): boolean {
  if (audience.allDepartments) return true
  return departmentId !== null && audience.departmentIds.includes(departmentId)
}

/** Both dials: may `userId` use the key for a consultation in `departmentId`? */
export function companyKeyUsable(audience: BrokerAudience, userId: string, departmentId: string | null): boolean {
  return companyKeyEligibility(audience, userId) !== null && companyKeyCoversDepartment(audience, departmentId)
}

/** Which kind of key a request uses under `rule`, given what exists for the member; null = none. */
export function chooseBrokerKeySource(
  rule: BrokerKeyRule,
  available: { company: boolean; user: boolean },
): BrokerKeyScope | null {
  if (rule === 'company-only') return available.company ? 'company' : null
  if (rule === 'user-only') return available.user ? 'user' : null
  return available.company ? 'company' : available.user ? 'user' : null
}

// ---------------------------------------------------------------------------
// Short-lived tokens (K3): what the app hands the chat's child processes.
// ---------------------------------------------------------------------------

/** Every token starts with this, so a pasted token is recognisable (and refused as a key). */
export const BROKER_TOKEN_PREFIX = 'acb_tok_'

/** Token lifetime in minutes: the server's default is configurable within these bounds. */
export const BROKER_TOKEN_TTL_MINUTES = { min: 15, max: 60, default: 30 } as const

export function clampBrokerTokenTtl(minutes: number): number {
  if (!Number.isFinite(minutes)) return BROKER_TOKEN_TTL_MINUTES.default
  return Math.min(BROKER_TOKEN_TTL_MINUTES.max, Math.max(BROKER_TOKEN_TTL_MINUTES.min, Math.round(minutes)))
}

/** The shape of a token value (prefix + 64 hex characters). Anything else is refused before a lookup. */
export function looksLikeBrokerToken(value: unknown): value is string {
  return typeof value === 'string' && /^acb_tok_[0-9a-f]{64}$/.test(value)
}
