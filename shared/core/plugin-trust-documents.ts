/**
 * Plugin trust, part 2: the signed documents and their envelope (`.claude/rules/plugin-trust.md`;
 * design 署名の検証 v3 §3–§5 + v3.1 §1–§2). Pure: parsing, shapes, and opening an envelope by
 * counting valid signatures of distinct keys with the injected crypto.
 *
 * - **root** (`acb-root`, namespace `acb-root-v1`): the keys and, per role, which keys and how many
 *   must sign. Roles and key types are fixed: `root` ed25519 only (threshold ≥ 2), `targets`
 *   ECDSA P-256 only, `freshness` either. One public key is never under two ids nor in two roles.
 * - **targets** (`acb-targets`, `acb-targets-v1`): one company's list of packages
 *   (`id@version` + fingerprint v2 + the reviewed commit and tag) and `floors`; ≤ 90 days.
 * - **freshness** (`acb-freshness`, `acb-freshness-v1`): "this exact list (version + sha256 of its
 *   signed text) is still current until X"; ≤ 3 days; a closed shape that can carry nothing else.
 *
 * An envelope is `{ signed: <the exact text>, signatures: [{ key_id, sig: <armored SSHSIG> }] }`:
 * the text is never re-serialised; its UTF-8 bytes are what was signed.
 */
import { COMPANY_ID_RE } from './plugin-declaration-rules'
import { PLUGIN_ID_RE, PLUGIN_VERSION_RE } from './plugin-declaration'
import { parseRootKey, utf8, verifySshSig, type PluginTrustCrypto, type SshKeyType, type SshPublicKey } from './plugin-trust-sshsig'

const DAY_MS = 86_400_000

export const PLUGIN_TRUST_POLICY = {
  /** How far a document's `issued` may lie ahead of this computer's clock, and how far the clock may fall behind a seen `issued`. */
  clockSkewMs: 10 * 60_000,
  maxTargetsLifetimeMs: 90 * DAY_MS,
  maxFreshnessLifetimeMs: 3 * DAY_MS,
  /** A list's version may grow by at most this much over the last one accepted (a stolen key cannot park it out of reach). */
  maxVersionStep: 1000,
  maxVersion: 2 ** 31 - 1,
  minRootThreshold: 2,
  maxSignatures: 16,
  maxSignedLength: 1024 * 1024,
  maxPackages: 500,
} as const

export const TRUST_NAMESPACES = { root: 'acb-root-v1', targets: 'acb-targets-v1', freshness: 'acb-freshness-v1' } as const

export type TrustRoleName = 'root' | 'targets' | 'freshness'
export const TRUST_ROLES: readonly TrustRoleName[] = ['root', 'targets', 'freshness']
/** Which key types each role may hold (v3.1 §1): a role's keys live where that type is made. */
export const ROLE_KEY_TYPES: Record<TrustRoleName, readonly SshKeyType[]> = {
  root: ['ssh-ed25519'],
  targets: ['ecdsa-sha2-nistp256'],
  freshness: ['ssh-ed25519', 'ecdsa-sha2-nistp256'],
}

/** Every refusal has its own code, so a test can tell which guard said no. */
export type TrustRefusalCode =
  | 'envelope' | 'signed-json' | 'threshold'
  | 'root-shape' | 'root-version-step' | 'root-old-keys' | 'root-new-keys' | 'root-expired' | 'halted'
  | 'targets-shape' | 'freshness-shape' | 'duplicate-package'
  | 'other-company' | 'other-server' | 'other-list'
  | 'issued-in-future' | 'lifetime-too-long' | 'expired'
  | 'clock-went-back' | 'rollback' | 'same-version-other-content' | 'version-jump' | 'issued-went-back'
  | 'list-not-current' | 'no-freshness' | 'freshness-not-current'

export interface TrustRefusal { ok: false; code: TrustRefusalCode; detail?: string }
export type TrustResult<T> = ({ ok: true } & T) | TrustRefusal
export const refuse = (code: TrustRefusalCode, detail?: string): TrustRefusal => (detail ? { ok: false, code, detail } : { ok: false, code })

export interface SignedEnvelope {
  signed: string
  signatures: Array<{ key_id: string; sig: string }>
}

export interface TrustRole { keys: string[]; threshold: number }

export interface RootDocument {
  _type: 'acb-root'
  version: number
  expires: string
  /** key id → canonical base64 of the OpenSSH public key blob. */
  keys: Record<string, string>
  roles: Record<TrustRoleName, TrustRole>
}

export interface TargetsPackage {
  id: string
  version: string
  /** Plugin fingerprint v2 (`plugin-fingerprint.ts`) of the package as its tag holds it. */
  fingerprint: string
  /** The reviewed commit the tag points at. */
  commit: string
  /** `<id>@<version>`. */
  tag: string
  min_app_version?: string
  checker_api?: number
  facts_version?: number
  ui_bridge?: number | null
}

export interface TargetsDocument {
  _type: 'acb-targets'
  /** `company:<id>`: the one company this list is for. */
  scope: string
  /** The server's public URL, compared exactly. */
  server: string
  version: number
  issued: string
  expires: string
  packages: TargetsPackage[]
  /** Package id → the oldest version that may run. */
  floors: Record<string, string>
}

export interface FreshnessDocument {
  _type: 'acb-freshness'
  scope: string
  server: string
  version: number
  issued: string
  expires: string
  targets: { version: number; sha256: string }
}

/** A root whose shape passed, with its keys decoded (the identities every comparison uses). */
export interface ParsedRoot {
  document: RootDocument
  keys: Map<string, SshPublicKey>
}

// ---------------------------------------------------------------- small readers

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const APP_VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/
const SERVER_RE = /^https?:\/\/[^\s/?#]+$/

/** A UTC time written `YYYY-MM-DDTHH:MM:SS(.mmm)Z` → epoch ms; anything else → null. */
export function parseTrustTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return null
  const ms = Date.parse(value)
  // Date.parse rolls 2026-02-30 over to March 2 and 24:00 to the next day: only a real calendar time passes.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
/**
 * The first key `allowed` does not name, as an object (never a bare string: a key named `""` is
 * falsy and would read as "none"), or null.
 */
const unknownKey = (o: Record<string, unknown>, allowed: readonly string[]): { name: string } | null => {
  const name = Object.keys(o).find(k => !allowed.includes(k))
  return name === undefined ? null : { name }
}

// ---------------------------------------------------------------- envelope

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function parseEnvelope(value: unknown): SignedEnvelope | null {
  if (!isRecord(value) || unknownKey(value, ['signed', 'signatures'])) return null
  const { signed, signatures } = value
  if (typeof signed !== 'string' || signed.length === 0 || signed.length > PLUGIN_TRUST_POLICY.maxSignedLength) return null
  if (LONE_SURROGATE_RE.test(signed)) return null // two such strings can encode to the same UTF-8 bytes
  if (!Array.isArray(signatures) || signatures.length > PLUGIN_TRUST_POLICY.maxSignatures) return null
  for (const s of signatures) {
    if (!isRecord(s) || unknownKey(s, ['key_id', 'sig']) || typeof s.key_id !== 'string' || typeof s.sig !== 'string') return null
  }
  return { signed, signatures: signatures as SignedEnvelope['signatures'] }
}

/**
 * Open an envelope for one role: count the signatures that verify, under `namespace`, by keys the
 * role lists — **one per distinct decoded key**, however many ids name it — and require the
 * role's threshold. Then the signed text's JSON.
 */
export function openEnvelope(
  value: unknown,
  namespace: string,
  keys: ReadonlyMap<string, SshPublicKey>,
  role: TrustRole,
  crypto: PluginTrustCrypto,
): TrustResult<{ envelope: SignedEnvelope; payload: unknown }> {
  const envelope = parseEnvelope(value)
  if (!envelope) return refuse('envelope')
  const message = utf8(envelope.signed)
  const signers = new Set<string>()
  for (const { key_id, sig } of envelope.signatures) {
    const key = role.keys.includes(key_id) ? keys.get(key_id) : undefined
    if (!key) continue
    if (verifySshSig(sig, message, namespace, key, crypto)) signers.add(key.identity)
  }
  if (signers.size < role.threshold) return refuse('threshold', `${signers.size} of ${role.threshold}`)
  try {
    return { ok: true, envelope, payload: JSON.parse(envelope.signed) }
  } catch {
    return refuse('signed-json')
  }
}

/** The `version` of a root envelope's text, without trusting anything else in it (sorting, conflicts). */
export function rootVersionOf(value: unknown): number | null {
  const envelope = parseEnvelope(value)
  if (!envelope) return null
  try {
    const p: unknown = JSON.parse(envelope.signed)
    return isRecord(p) && isInt(p.version, 1, PLUGIN_TRUST_POLICY.maxVersion) ? p.version : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- root

/** A root's shape and its decoded keys, or the first problem (`.claude/rules/plugin-trust.md` "Root"). */
export function parseRoot(value: unknown): { ok: true; root: ParsedRoot } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem })
  if (!isRecord(value)) return bad('not an object')
  const extra = unknownKey(value, ['_type', 'version', 'expires', 'keys', 'roles'])
  if (extra) return bad(`unknown key ${JSON.stringify(extra.name)}`)
  if (value._type !== 'acb-root') return bad('_type')
  if (!isInt(value.version, 1, PLUGIN_TRUST_POLICY.maxVersion)) return bad('version')
  if (parseTrustTime(value.expires) === null) return bad('expires')
  if (!isRecord(value.keys) || !isRecord(value.roles)) return bad('keys / roles')

  const keys = new Map<string, SshPublicKey>()
  const idOfIdentity = new Map<string, string>()
  for (const [id, b64] of Object.entries(value.keys)) {
    if (!KEY_ID_RE.test(id)) return bad(`key id ${id}`)
    const key = parseRootKey(b64)
    if (!key.ok) return bad(`key ${id}: ${key.error}`)
    const other = idOfIdentity.get(key.key.identity)
    if (other !== undefined) return bad(`one public key under two ids (${other}, ${id})`)
    idOfIdentity.set(key.key.identity, id)
    keys.set(id, key.key)
  }

  const extraRole = unknownKey(value.roles, TRUST_ROLES)
  if (extraRole) return bad(`unknown role ${JSON.stringify(extraRole.name)}`)
  const roleOf = new Map<string, TrustRoleName>()
  for (const name of TRUST_ROLES) {
    const r = value.roles[name]
    if (!isRecord(r) || unknownKey(r, ['keys', 'threshold']) || !Array.isArray(r.keys) || r.keys.length === 0) return bad(`role ${name}`)
    const ids = r.keys as unknown[]
    if (ids.some(k => typeof k !== 'string' || !keys.has(k)) || new Set(ids).size !== ids.length) return bad(`role ${name}: keys`)
    if (!isInt(r.threshold, name === 'root' ? PLUGIN_TRUST_POLICY.minRootThreshold : 1, ids.length)) return bad(`role ${name}: threshold`)
    for (const id of ids as string[]) {
      const key = keys.get(id) as SshPublicKey
      if (!ROLE_KEY_TYPES[name].includes(key.type)) return bad(`role ${name}: key type ${key.type}`)
      const before = roleOf.get(key.identity)
      if (before !== undefined && before !== name) return bad(`one key in two roles (${before}, ${name})`)
      roleOf.set(key.identity, name)
    }
  }
  return { ok: true, root: { document: value as unknown as RootDocument, keys } }
}

/**
 * A role's **generation**: its threshold and the decoded identities of its keys. Records of what
 * was accepted (versions, times) belong to one generation; when root replaces the keys of a role,
 * the old generation's records no longer apply (a stolen key's huge version cannot block recovery).
 */
export function roleGeneration(root: ParsedRoot, role: TrustRoleName): string {
  const r = root.document.roles[role]
  const ids = r.keys.map(k => (root.keys.get(k) as SshPublicKey).identity).sort()
  return `${role}/${r.threshold}/${ids.join(',')}`
}

// ---------------------------------------------------------------- targets and freshness

const PACKAGE_KEYS = ['id', 'version', 'fingerprint', 'commit', 'tag', 'min_app_version', 'checker_api', 'facts_version', 'ui_bridge'] as const

function packageProblem(p: unknown, i: number): string | null {
  if (!isRecord(p)) return `packages[${i}]`
  const extra = unknownKey(p, PACKAGE_KEYS)
  if (extra) return `packages[${i}]: unknown key ${JSON.stringify(extra.name)}`
  if (typeof p.id !== 'string' || !PLUGIN_ID_RE.test(p.id)) return `packages[${i}].id`
  if (typeof p.version !== 'string' || !PLUGIN_VERSION_RE.test(p.version)) return `packages[${i}].version`
  if (typeof p.fingerprint !== 'string' || !SHA256_HEX_RE.test(p.fingerprint)) return `packages[${i}].fingerprint`
  if (typeof p.commit !== 'string' || !COMMIT_RE.test(p.commit)) return `packages[${i}].commit`
  if (p.tag !== `${p.id}@${p.version}`) return `packages[${i}].tag`
  if (own(p, 'min_app_version') && (typeof p.min_app_version !== 'string' || !APP_VERSION_RE.test(p.min_app_version))) return `packages[${i}].min_app_version`
  if (own(p, 'checker_api') && !isInt(p.checker_api, 1, 1000)) return `packages[${i}].checker_api`
  if (own(p, 'facts_version') && !isInt(p.facts_version, 1, 1000)) return `packages[${i}].facts_version`
  if (own(p, 'ui_bridge') && p.ui_bridge !== null && !isInt(p.ui_bridge, 1, 1000)) return `packages[${i}].ui_bridge`
  return null
}

const scopeOk = (scope: unknown): scope is string =>
  typeof scope === 'string' && scope.startsWith('company:') && COMPANY_ID_RE.test(scope.slice('company:'.length))
const serverOk = (server: unknown): server is string => typeof server === 'string' && server.length <= 200 && SERVER_RE.test(server)

/** A company's list, shape only (closed at every level: a key this app does not know refuses the list). */
export function parseTargets(value: unknown): { ok: true; document: TargetsDocument } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem })
  if (!isRecord(value)) return bad('not an object')
  const extra = unknownKey(value, ['_type', 'scope', 'server', 'version', 'issued', 'expires', 'packages', 'floors'])
  if (extra) return bad(`unknown key ${JSON.stringify(extra.name)}`)
  if (value._type !== 'acb-targets') return bad('_type')
  if (!scopeOk(value.scope)) return bad('scope')
  if (!serverOk(value.server)) return bad('server')
  if (!isInt(value.version, 1, PLUGIN_TRUST_POLICY.maxVersion)) return bad('version')
  if (parseTrustTime(value.issued) === null || parseTrustTime(value.expires) === null) return bad('issued / expires')
  if (!Array.isArray(value.packages) || value.packages.length > PLUGIN_TRUST_POLICY.maxPackages) return bad('packages')
  for (let i = 0; i < value.packages.length; i++) {
    const problem = packageProblem(value.packages[i], i)
    if (problem) return bad(problem)
  }
  const floors = own(value, 'floors') ? value.floors : {}
  if (!isRecord(floors)) return bad('floors')
  for (const [id, v] of Object.entries(floors)) {
    if (!PLUGIN_ID_RE.test(id) || typeof v !== 'string' || !PLUGIN_VERSION_RE.test(v)) return bad(`floors.${id}`)
  }
  return { ok: true, document: { ...(value as unknown as TargetsDocument), floors: floors as Record<string, string> } }
}

/** A freshness document, shape only: closed, so it can never carry packages, floors or keys. */
export function parseFreshness(value: unknown): { ok: true; document: FreshnessDocument } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem })
  if (!isRecord(value)) return bad('not an object')
  const extra = unknownKey(value, ['_type', 'scope', 'server', 'version', 'issued', 'expires', 'targets'])
  if (extra) return bad(`unknown key ${JSON.stringify(extra.name)}`)
  if (value._type !== 'acb-freshness') return bad('_type')
  if (!scopeOk(value.scope)) return bad('scope')
  if (!serverOk(value.server)) return bad('server')
  if (!isInt(value.version, 1, PLUGIN_TRUST_POLICY.maxVersion)) return bad('version')
  if (parseTrustTime(value.issued) === null || parseTrustTime(value.expires) === null) return bad('issued / expires')
  const t = value.targets
  if (!isRecord(t) || unknownKey(t, ['version', 'sha256']) || !isInt(t.version, 1, PLUGIN_TRUST_POLICY.maxVersion)
    || typeof t.sha256 !== 'string' || !SHA256_HEX_RE.test(t.sha256)) return bad('targets')
  return { ok: true, document: value as unknown as FreshnessDocument }
}
