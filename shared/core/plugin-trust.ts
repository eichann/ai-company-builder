/**
 * Plugin trust, part 3: the root chain and the trust record (`.claude/rules/plugin-trust.md`;
 * design 署名の検証 v3 §3–§4, §8 + v3.1 §2). Pure functions over a serialisable state, an injected
 * clock (`now`, epoch ms, passed in) and the injected crypto. **P1: nothing calls this yet** — no
 * storage, no distribution, no enforcement (P2 stores the record, P4 enforces).
 *
 * - **History vs freshness of root**: a root N+1 is authentic when the threshold of root N's root
 *   keys **and** of its own root keys signed it and its version is exactly N+1 — an intermediate
 *   root's expiry is not looked at. Only the newest root's expiry decides whether anything is
 *   usable now.
 * - **Root conflict halts for good**: two different texts for one root version, each a valid step
 *   from the version before it, = the root keys were misused. The halt is its own stored value
 *   (and is also kept in the record): nothing is accepted and no code may run, across restarts and
 *   a damaged record, until an app that carries a newer root (Codex's P1 condition 3). A text that
 *   does not authenticate is noise and changes nothing.
 * - **Records per server × company × generation** (condition 2): of the last accepted list and
 *   freshness document, only what was read from the verified text (version, hash, issued,
 *   expires, and the list a freshness document is bound to), keyed by server and company; a record
 *   is used only while its role's generation (`roleGeneration`) is the current root's.
 */
import {
  openEnvelope, parseEnvelope, parseFreshness, parseRoot, parseTargets, parseTrustTime, refuse, roleGeneration, rootVersionOf,
  PLUGIN_TRUST_POLICY, TRUST_NAMESPACES,
  type FreshnessDocument, type ParsedRoot, type SignedEnvelope, type TargetsDocument, type TrustResult,
} from './plugin-trust-documents'
import { toHex, utf8, type PluginTrustCrypto } from './plugin-trust-sshsig'

/** An authenticated root and the envelope it came in (kept so the chain can be stored and checked again). */
export interface TrustedRoot extends ParsedRoot {
  envelope: SignedEnvelope
}

/** What the record keeps of an accepted document: only values read from its verified text. */
export interface ListMark {
  generation: string
  version: number
  /** sha256 (hex) of the signed text. */
  sha256: string
  /** `issued` and `expires`, epoch ms. */
  issued: number
  expires: number
  /** Freshness only: sha256 of the list it is bound to. */
  boundTo?: string
}

export interface TrustHalt { version: number; reason: string }

export interface TrustState {
  /** The newest authenticated root. */
  root: TrustedRoot
  /** Authenticated roots, oldest first: the app's own root (or one reached from it) up to `root`. */
  chain: TrustedRoot[]
  /** Last accepted list per `markKey(server, company)`. */
  marks: Record<string, ListMark>
  /** Last accepted freshness document per `markKey(server, company)`. */
  freshMarks: Record<string, ListMark>
  halted: TrustHalt | null
  /** Why the stored record was not (fully) used, or why a root update stopped: trust is "unknown", not "empty". */
  problem: string | null
  /**
   * P2: the records were lost once (an unreadable record, or a stored chain that did not
   * authenticate) — what the record holds since is not a full history. Stored with the record, so
   * it survives later writes and restarts, until `clearTrustUnknown` (a deliberate step).
   */
  unknown?: string | null
}

/** The deliberate step that ends "unknown" (P2 never takes it by itself). */
export const clearTrustUnknown = (state: TrustState): TrustState => ({ ...state, unknown: null })

/** What P2 stores: the record and, in its own small file, a halt. Either may be missing or damaged. */
export interface StoredTrust {
  record?: string | null
  halt?: string | null
}

export interface TrustContext {
  /** The server this app is connected to (its public URL, compared exactly with the signed `server`). */
  server: string
  companyId: string
  now: number
}

/** A list this state accepted, for one server and company: a handle; its times are read from the record. */
export interface AcceptedList {
  server: string
  companyId: string
  document: TargetsDocument
  /** sha256 (hex) of its signed text: what identifies it in the record and binds a freshness document. */
  sha256: string
}

export interface AcceptedFreshness {
  server: string
  companyId: string
  document: FreshnessDocument
  sha256: string
}

/** The record's key: server × company (JSON, so no separator inside a value can make two keys meet). */
export const markKey = (server: string, companyId: string): string => JSON.stringify([server, companyId])

const sha256Hex = (text: string, crypto: PluginTrustCrypto): string => toHex(crypto.sha256(utf8(text)))
const time = (iso: string): number => parseTrustTime(iso) as number

// ---------------------------------------------------------------- root chain

/** The app's own root: its shape and its own root-key threshold. A build that carries a bad one must not start. */
export function bakedRoot(envelope: unknown, crypto: PluginTrustCrypto): TrustedRoot {
  const env = parseEnvelope(envelope)
  if (!env) throw new Error('baked root: not an envelope')
  const parsed = parseRoot(safeJson(env.signed))
  if (!parsed.ok) throw new Error(`baked root: ${parsed.problem}`)
  const opened = openEnvelope(env, TRUST_NAMESPACES.root, parsed.root.keys, parsed.root.document.roles.root, crypto)
  if (!opened.ok) throw new Error('baked root: not signed by its own root keys')
  return { ...parsed.root, envelope: env }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** One step of the history: `next` is authentic after `current` (both thresholds, version +1, shape). Expiry is not looked at. */
export function stepRoot(current: ParsedRoot, envelope: unknown, crypto: PluginTrustCrypto): TrustResult<{ root: TrustedRoot }> {
  const byOld = openEnvelope(envelope, TRUST_NAMESPACES.root, current.keys, current.document.roles.root, crypto)
  if (!byOld.ok) return byOld.code === 'threshold' ? refuse('root-old-keys', byOld.detail) : byOld
  const parsed = parseRoot(byOld.payload)
  if (!parsed.ok) return refuse('root-shape', parsed.problem)
  if (parsed.root.document.version !== current.document.version + 1) return refuse('root-version-step')
  const byNew = openEnvelope(envelope, TRUST_NAMESPACES.root, parsed.root.keys, parsed.root.document.roles.root, crypto)
  if (!byNew.ok) return byNew.code === 'threshold' ? refuse('root-new-keys', byNew.detail) : byNew
  return { ok: true, root: { ...parsed.root, envelope: byOld.envelope } }
}

interface ChainOutcome {
  chain: TrustedRoot[]
  halted: TrustHalt | null
  error: string | null
}

const conflictHalt = (version: number): TrustHalt => ({ version, reason: `two different signed roots for version ${version}` })

/**
 * Extend `chain` with root envelopes a server offered (any order, junk included). Per version,
 * every candidate is tried: one that does not authenticate is skipped, so junk cannot block the
 * real root. A known version: another text that is itself a valid step from the version before
 * halts. A new version: two different texts that both authenticate halt; one moves the chain on;
 * none stops there (reported). Versions at or below the chain's start without a known text are ignored.
 */
function extendChain(chain: TrustedRoot[], offered: readonly unknown[], crypto: PluginTrustCrypto): ChainOutcome {
  const out = [...chain]
  const byVersion = new Map(out.map(r => [r.document.version, r]))
  const candidates = new Map<number, SignedEnvelope[]>()
  for (const value of offered) {
    const env = parseEnvelope(value)
    const version = rootVersionOf(env)
    if (!env || version === null) continue
    // every envelope is a candidate: the same text may come once with too few signatures and once with enough
    candidates.set(version, [...(candidates.get(version) ?? []), env])
  }
  for (const version of [...candidates.keys()].sort((a, b) => a - b)) {
    const envs = candidates.get(version) as SignedEnvelope[]
    const known = byVersion.get(version)
    if (known) {
      const before = byVersion.get(version - 1)
      if (before && envs.some(env => env.signed !== known.envelope.signed && stepRoot(before, env, crypto).ok)) {
        return { chain: out, halted: conflictHalt(version), error: null }
      }
      continue
    }
    const newest = out[out.length - 1]
    if (version <= newest.document.version) continue
    const steps = envs.map(env => stepRoot(newest, env, crypto))
    const good = steps.flatMap(s => (s.ok ? [s.root] : []))
    if (new Set(good.map(r => r.envelope.signed)).size > 1) return { chain: out, halted: conflictHalt(version), error: null }
    if (good.length === 0) {
      const first = steps[0] as { code: string; detail?: string }
      return { chain: out, halted: null, error: `root v${version}: ${first.code}${first.detail ? ` (${first.detail})` : ''}` }
    }
    out.push(good[0])
    byVersion.set(version, good[0])
  }
  return { chain: out, halted: null, error: null }
}

/**
 * Re-authenticate a stored chain from the app's root, strictly: every stored entry must be an
 * envelope, and every entry above the app's version must be the next authentic step. Entries at
 * or below the app's version are the app's own history (a same-version text differing from the
 * app's loses to it). Anything else → null (the caller falls back and says so).
 */
function restoreChain(baked: TrustedRoot, stored: readonly unknown[], crypto: PluginTrustCrypto): TrustedRoot[] | null {
  const chain = [baked]
  for (const value of stored) {
    const env = parseEnvelope(value)
    const version = rootVersionOf(env)
    if (!env || version === null) return null
    if (version <= baked.document.version) continue
    const step = stepRoot(chain[chain.length - 1], env, crypto)
    if (!step.ok) return null
    chain.push(step.root)
  }
  return chain
}

export const rootIsFresh = (state: TrustState, now: number): boolean => time(state.root.document.expires) > now

// ---------------------------------------------------------------- the record: start, store, update

const STATE_FORMAT = 1

/**
 * What is stored (P2 writes both): the record (chain envelopes, records, the halt again) and the
 * halt alone in its own small file — so a damaged record never lifts a halt.
 */
export function serializeTrustState(state: TrustState): { record: string; halt: string | null } {
  return {
    record: JSON.stringify({
      format: STATE_FORMAT, chain: state.chain.map(r => r.envelope), marks: state.marks, freshMarks: state.freshMarks, halted: state.halted,
      ...(state.unknown ? { unknown: state.unknown } : {}),
    }),
    halt: state.halted ? JSON.stringify({ format: STATE_FORMAT, halted: state.halted }) : null,
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isMark = (m: unknown): m is ListMark => {
  if (typeof m !== 'object' || m === null) return false
  const v = m as Record<string, unknown>
  return typeof v.generation === 'string' && Number.isInteger(v.version) && typeof v.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(v.sha256) && isFiniteNumber(v.issued) && isFiniteNumber(v.expires)
    && (v.boundTo === undefined || (typeof v.boundTo === 'string' && /^[0-9a-f]{64}$/.test(v.boundTo)))
}
const marksOf = (v: unknown): Record<string, ListMark> | null => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const entries = Object.entries(v as Record<string, unknown>)
  return entries.every(([, m]) => isMark(m)) ? Object.fromEntries(entries) as Record<string, ListMark> : null
}
const haltOf = (v: unknown): TrustHalt | null => {
  if (typeof v !== 'object' || v === null) return null
  const h = v as Record<string, unknown>
  return Number.isInteger(h.version) && (h.version as number) >= 1 && typeof h.reason === 'string' ? { version: h.version as number, reason: h.reason } : null
}

/**
 * Every halt that can be read from what was stored: the halt file, the record's copy, and — when
 * either text is damaged — a `"version": N` found next to `halted` in the raw text. A halt file
 * that is present but yields nothing is a halt of unknown version (taken as the app's own).
 */
function storedHalts(stored: StoredTrust, bakedVersion: number): TrustHalt[] {
  const halts: TrustHalt[] = []
  const fromFile = stored.halt ? safeJson(stored.halt) as Record<string, unknown> | undefined : undefined
  const fromRecord = stored.record ? safeJson(stored.record) as Record<string, unknown> | undefined : undefined
  for (const h of [haltOf(fromFile?.halted), haltOf(fromRecord?.halted)]) if (h) halts.push(h)
  for (const raw of [stored.halt, stored.record]) {
    const m = raw ? /"halted"\s*:\s*\{\s*"version"\s*:\s*(\d{1,10})/.exec(raw) : null
    if (m) halts.push({ version: Number(m[1]), reason: 'a halt recovered from a damaged trust record' })
  }
  if (stored.halt && stored.halt.trim() !== '' && halts.length === 0) {
    halts.push({ version: bakedVersion, reason: 'the stored halt could not be read' })
  }
  return halts
}

/**
 * Start from the app's own root and what was stored (v3 §3 「始まり」):
 * - a halt readable from the halt file or the record (even a damaged one) for a version the app's
 *   root has not passed → halted, whatever else is stored;
 * - nothing stored → the app's root, no records;
 * - an unreadable record, or a stored chain with any entry that is not an authentic step from the
 *   app's root → the app's root, no records, `problem` set (unknown, not "empty");
 * - otherwise the stored chain (only versions above the app's) with the records.
 */
export function startTrust(bakedEnvelope: unknown, stored: StoredTrust | null | undefined, crypto: PluginTrustCrypto): TrustState {
  const baked = bakedRoot(bakedEnvelope, crypto)
  const base: TrustState = { root: baked, chain: [baked], marks: {}, freshMarks: {}, halted: null, problem: null }
  if (!stored) return base
  const halt = storedHalts(stored, baked.document.version)
    .filter(h => h.version >= baked.document.version)
    .sort((a, b) => b.version - a.version)[0]
  if (halt) return { ...base, halted: halt }
  if (stored.record === null || stored.record === undefined) return base
  const parsed = safeJson(stored.record) as Record<string, unknown> | undefined
  const marks = marksOf(parsed?.marks)
  const freshMarks = marksOf(parsed?.freshMarks)
  if (!parsed || parsed.format !== STATE_FORMAT || !Array.isArray(parsed.chain) || !marks || !freshMarks) {
    const why = 'the stored trust record could not be read: started from the app\'s root'
    return { ...base, problem: why, unknown: why }
  }
  const chain = restoreChain(baked, parsed.chain, crypto)
  if (!chain) {
    const why = 'the stored chain did not authenticate: started from the app\'s root'
    return { ...base, problem: why, unknown: why }
  }
  // "unknown" written by an earlier start stays until cleared deliberately (a later write keeps it).
  const unknown = typeof parsed.unknown === 'string' && parsed.unknown ? parsed.unknown.slice(0, 300) : null
  return { root: chain[chain.length - 1], chain, marks, freshMarks, halted: null, problem: unknown, unknown }
}

/** Offer root envelopes the server handed out (all versions it has). A halt is final for this state. */
export function updateTrustRoot(state: TrustState, envelopes: readonly unknown[], crypto: PluginTrustCrypto): TrustState {
  if (state.halted) return state
  const extended = extendChain(state.chain, envelopes, crypto)
  if (extended.halted) return { ...state, halted: extended.halted }
  const chain = extended.chain
  return { ...state, root: chain[chain.length - 1], chain, problem: extended.error ?? state.problem }
}

// ---------------------------------------------------------------- the company's list

/** Times shared by a list and a freshness document: not issued ahead of the clock, a bounded life, not expired. */
function timeProblem(issued: number, expires: number, maxLifetimeMs: number, now: number): TrustResult<object> | null {
  if (issued > now + PLUGIN_TRUST_POLICY.clockSkewMs) return refuse('issued-in-future')
  if (expires <= issued || expires - issued > maxLifetimeMs) return refuse('lifetime-too-long')
  if (expires <= now) return refuse('expired')
  return null
}

/** Against the last record of the same generation: clock, rollback, same version, jump, issued going back. */
function markProblem(mark: ListMark | null, version: number, sha256: string, issued: number, now: number): TrustResult<object> | null {
  if (!mark) return null
  if (now < mark.issued - PLUGIN_TRUST_POLICY.clockSkewMs) return refuse('clock-went-back')
  if (version < mark.version) return refuse('rollback')
  if (version === mark.version && sha256 !== mark.sha256) return refuse('same-version-other-content')
  if (version > mark.version + PLUGIN_TRUST_POLICY.maxVersionStep) return refuse('version-jump')
  if (version > mark.version && issued < mark.issued) return refuse('issued-went-back')
  return null
}

const markOf = (marks: Record<string, ListMark>, key: string, generation: string): ListMark | null =>
  marks[key]?.generation === generation ? marks[key] : null

/** Accept one company's list (v3 §4): every rule, then the record moves to it. */
export function acceptTargets(state: TrustState, envelope: unknown, ctx: TrustContext, crypto: PluginTrustCrypto): TrustResult<{ state: TrustState; list: AcceptedList }> {
  if (state.halted) return refuse('halted', state.halted.reason)
  if (!rootIsFresh(state, ctx.now)) return refuse('root-expired')
  const opened = openEnvelope(envelope, TRUST_NAMESPACES.targets, state.root.keys, state.root.document.roles.targets, crypto)
  if (!opened.ok) return opened
  const parsed = parseTargets(opened.payload)
  if (!parsed.ok) return refuse('targets-shape', parsed.problem)
  const doc = parsed.document
  if (doc.scope !== `company:${ctx.companyId}`) return refuse('other-company')
  if (doc.server !== ctx.server) return refuse('other-server')
  const issued = time(doc.issued)
  const expires = time(doc.expires)
  const timing = timeProblem(issued, expires, PLUGIN_TRUST_POLICY.maxTargetsLifetimeMs, ctx.now)
  if (timing) return timing as TrustResult<never>
  const seen = new Set<string>()
  for (const p of doc.packages) {
    const id = `${p.id}@${p.version}`
    if (seen.has(id)) return refuse('duplicate-package', id)
    seen.add(id)
  }
  const sha256 = sha256Hex(opened.envelope.signed, crypto)
  const key = markKey(ctx.server, ctx.companyId)
  const generation = roleGeneration(state.root, 'targets')
  const against = markProblem(markOf(state.marks, key, generation), doc.version, sha256, issued, ctx.now)
  if (against) return against as TrustResult<never>
  return {
    ok: true,
    state: { ...state, marks: { ...state.marks, [key]: { generation, version: doc.version, sha256, issued, expires } } },
    list: { server: ctx.server, companyId: ctx.companyId, document: doc, sha256 },
  }
}

/** The record this state holds now for the context's server and company under the current targets generation, if `list` is it. */
function currentListMark(state: TrustState, list: AcceptedList, ctx: TrustContext): ListMark | null {
  if (list.server !== ctx.server || list.companyId !== ctx.companyId) return null
  const mark = markOf(state.marks, markKey(ctx.server, ctx.companyId), roleGeneration(state.root, 'targets'))
  return mark && mark.sha256 === list.sha256 ? mark : null
}

// ---------------------------------------------------------------- freshness

/** Accept a freshness document for the current list (v3.1 §2). The binding is checked against the record, not the handle. */
export function acceptFreshness(
  state: TrustState, envelope: unknown, list: AcceptedList, ctx: TrustContext, crypto: PluginTrustCrypto,
): TrustResult<{ state: TrustState; freshness: AcceptedFreshness }> {
  if (state.halted) return refuse('halted', state.halted.reason)
  if (!rootIsFresh(state, ctx.now)) return refuse('root-expired')
  const listMark = currentListMark(state, list, ctx)
  if (!listMark) return refuse('list-not-current')
  const opened = openEnvelope(envelope, TRUST_NAMESPACES.freshness, state.root.keys, state.root.document.roles.freshness, crypto)
  if (!opened.ok) return opened
  const parsed = parseFreshness(opened.payload)
  if (!parsed.ok) return refuse('freshness-shape', parsed.problem)
  const doc = parsed.document
  if (doc.scope !== `company:${ctx.companyId}`) return refuse('other-company')
  if (doc.server !== ctx.server) return refuse('other-server')
  if (doc.targets.version !== listMark.version || doc.targets.sha256 !== listMark.sha256) return refuse('other-list')
  const issued = time(doc.issued)
  const expires = time(doc.expires)
  const timing = timeProblem(issued, expires, PLUGIN_TRUST_POLICY.maxFreshnessLifetimeMs, ctx.now)
  if (timing) return timing as TrustResult<never>
  const sha256 = sha256Hex(opened.envelope.signed, crypto)
  const key = markKey(ctx.server, ctx.companyId)
  const generation = roleGeneration(state.root, 'freshness')
  const against = markProblem(markOf(state.freshMarks, key, generation), doc.version, sha256, issued, ctx.now)
  if (against) return against as TrustResult<never>
  return {
    ok: true,
    state: { ...state, freshMarks: { ...state.freshMarks, [key]: { generation, version: doc.version, sha256, issued, expires, boundTo: listMark.sha256 } } },
    freshness: { server: ctx.server, companyId: ctx.companyId, document: doc, sha256 },
  }
}

// ---------------------------------------------------------------- may code run now?

/**
 * Until when the company's plugin code may run (v3.1 §2): min(newest root, list, freshness)
 * expiry — needing the list **and** its freshness, both still the current records of their
 * generations (a root that replaced either key revokes them), the freshness bound to that list,
 * and a clock not behind what was seen. Every time and version comes from the record (read from
 * verified text when it was accepted); the handles only say which documents are meant.
 * P1 only answers; P4 closes frames and engines with it.
 */
export function codeMayRunUntil(state: TrustState, list: AcceptedList | null, freshness: AcceptedFreshness | null, ctx: TrustContext): TrustResult<{ until: number }> {
  if (state.halted) return refuse('halted', state.halted.reason)
  const mark = list ? currentListMark(state, list, ctx) : null
  if (!mark) return refuse('list-not-current')
  if (!freshness) return refuse('no-freshness')
  const fresh = markOf(state.freshMarks, markKey(ctx.server, ctx.companyId), roleGeneration(state.root, 'freshness'))
  if (!fresh || fresh.sha256 !== freshness.sha256 || fresh.boundTo !== mark.sha256
    || freshness.server !== ctx.server || freshness.companyId !== ctx.companyId) return refuse('freshness-not-current')
  if (ctx.now < Math.max(mark.issued, fresh.issued) - PLUGIN_TRUST_POLICY.clockSkewMs) return refuse('clock-went-back')
  const until = Math.min(time(state.root.document.expires), mark.expires, fresh.expires)
  if (until <= ctx.now) return refuse('expired')
  return { ok: true, until }
}
