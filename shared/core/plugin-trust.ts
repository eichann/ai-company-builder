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
 *   from the version before it, = the root keys were misused. The record keeps `halted`; nothing
 *   is accepted and no code may run, across restarts, until an app that carries a newer root
 *   (Codex's P1 condition 3). A text that does not authenticate is noise and changes nothing.
 * - **Records per server × company × generation** (condition 2): the last accepted list's version,
 *   text hash and `issued`, and the same for freshness, keyed by server and company; a record is
 *   used only while its role's generation (`roleGeneration`) is the current root's.
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

export interface ListMark {
  generation: string
  version: number
  /** sha256 (hex) of the signed text. */
  sha256: string
  /** `issued`, epoch ms. */
  issued: number
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
  /** Why the stored record was not used (unreadable, a chain that did not authenticate): trust is "unknown", not "empty". */
  problem: string | null
}

export interface TrustContext {
  /** The server this app is connected to (its public URL, compared exactly with the signed `server`). */
  server: string
  companyId: string
  now: number
}

/** A list this state accepted, for one server and company. */
export interface AcceptedList {
  server: string
  companyId: string
  document: TargetsDocument
  /** sha256 (hex) of its signed text: what a freshness document is bound to. */
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

/**
 * Extend `chain` with the offered root envelopes (any order). Same text as a known version:
 * nothing. Another text for a known version that is itself a valid step from the version before
 * it: halt. Older than what the chain starts with: ignored. A step that fails: stop there, keep
 * what authenticated so far.
 */
function extendChain(chain: TrustedRoot[], offered: readonly unknown[], crypto: PluginTrustCrypto): ChainOutcome {
  const out = [...chain]
  const byVersion = new Map(out.map(r => [r.document.version, r]))
  const sorted = offered
    .map(env => ({ env, version: rootVersionOf(env) }))
    .filter((e): e is { env: unknown; version: number } => e.version !== null)
    .sort((a, b) => a.version - b.version)
  for (const { env, version } of sorted) {
    const known = byVersion.get(version)
    if (known) {
      if (parseEnvelope(env)?.signed === known.envelope.signed) continue
      const before = byVersion.get(version - 1)
      if (before && stepRoot(before, env, crypto).ok) {
        return { chain: out, halted: { version, reason: `two different signed roots for version ${version}` }, error: null }
      }
      continue
    }
    const newest = out[out.length - 1]
    if (version <= newest.document.version) continue
    const step = stepRoot(newest, env, crypto)
    if (!step.ok) return { chain: out, halted: null, error: `root v${version}: ${step.code}${step.detail ? ` (${step.detail})` : ''}` }
    out.push(step.root)
    byVersion.set(version, step.root)
  }
  return { chain: out, halted: null, error: null }
}

export const rootIsFresh = (state: TrustState, now: number): boolean => time(state.root.document.expires) > now

// ---------------------------------------------------------------- the record: start, store, update

const STATE_FORMAT = 1

/** What is stored (P2 writes it): the chain's envelopes, the records and a halt. */
export function serializeTrustState(state: TrustState): string {
  return JSON.stringify({
    format: STATE_FORMAT,
    chain: state.chain.map(r => r.envelope),
    marks: state.marks,
    freshMarks: state.freshMarks,
    halted: state.halted,
  })
}

const isMark = (m: unknown): m is ListMark => {
  if (typeof m !== 'object' || m === null) return false
  const v = m as Record<string, unknown>
  return typeof v.generation === 'string' && Number.isInteger(v.version) && typeof v.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(v.sha256) && typeof v.issued === 'number' && Number.isFinite(v.issued)
}
const marksOf = (v: unknown): Record<string, ListMark> | null => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const entries = Object.entries(v as Record<string, unknown>)
  return entries.every(([, m]) => isMark(m)) ? Object.fromEntries(entries) as Record<string, ListMark> : null
}

/**
 * Start from the app's own root and what was stored (v3 §3 「始まり」):
 * - nothing stored → the app's root, no records;
 * - unreadable, or a stored chain that does not authenticate from the app's root → the same, with
 *   `problem` set (unknown, not "empty");
 * - a stored halt for a version the app's root has not passed → halted;
 * - otherwise the stored chain re-authenticated from the app's root (only versions above it; a
 *   stored root of the app's own version with another text loses to the app's), with the records.
 */
export function startTrust(bakedEnvelope: unknown, stored: string | null | undefined, crypto: PluginTrustCrypto): TrustState {
  const baked = bakedRoot(bakedEnvelope, crypto)
  const base: TrustState = { root: baked, chain: [baked], marks: {}, freshMarks: {}, halted: null, problem: null }
  if (stored === null || stored === undefined) return base
  const parsed = safeJson(stored) as Record<string, unknown> | undefined
  const marks = marksOf(parsed?.marks)
  const freshMarks = marksOf(parsed?.freshMarks)
  const halted = parsed?.halted as TrustHalt | null | undefined
  const haltOk = halted === null || (typeof halted === 'object' && Number.isInteger(halted?.version) && typeof halted?.reason === 'string')
  if (!parsed || parsed.format !== STATE_FORMAT || !Array.isArray(parsed.chain) || !marks || !freshMarks || !haltOk) {
    return { ...base, problem: 'the stored trust record could not be read: started from the app\'s root' }
  }
  if (halted && halted.version >= baked.document.version) return { ...base, halted }
  const extended = extendChain([baked], parsed.chain, crypto)
  if (extended.halted) return { ...base, halted: extended.halted }
  if (extended.error) return { ...base, problem: `the stored chain did not authenticate (${extended.error}): started from the app's root` }
  const chain = extended.chain
  return { root: chain[chain.length - 1], chain, marks, freshMarks, halted: null, problem: null }
}

/** Offer root envelopes the server handed out (all versions it has). A halt is final for this state. */
export function updateTrustRoot(state: TrustState, envelopes: readonly unknown[], crypto: PluginTrustCrypto): TrustState {
  if (state.halted) return state
  const extended = extendChain(state.chain, envelopes, crypto)
  if (extended.halted) return { ...state, halted: extended.halted }
  const chain = extended.chain
  return { ...state, root: chain[chain.length - 1], chain, problem: extended.error }
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
  const timing = timeProblem(issued, time(doc.expires), PLUGIN_TRUST_POLICY.maxTargetsLifetimeMs, ctx.now)
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
    state: { ...state, marks: { ...state.marks, [key]: { generation, version: doc.version, sha256, issued } } },
    list: { server: ctx.server, companyId: ctx.companyId, document: doc, sha256 },
  }
}

/** The list is the one this state's record holds now for its server and company, under the current targets generation. */
function listIsCurrent(state: TrustState, list: AcceptedList, ctx: TrustContext): ListMark | null {
  if (list.server !== ctx.server || list.companyId !== ctx.companyId) return null
  const mark = markOf(state.marks, markKey(ctx.server, ctx.companyId), roleGeneration(state.root, 'targets'))
  return mark && mark.version === list.document.version && mark.sha256 === list.sha256 ? mark : null
}

// ---------------------------------------------------------------- freshness

/** Accept a freshness document for the current list (v3.1 §2). */
export function acceptFreshness(
  state: TrustState, envelope: unknown, list: AcceptedList, ctx: TrustContext, crypto: PluginTrustCrypto,
): TrustResult<{ state: TrustState; freshness: AcceptedFreshness }> {
  if (state.halted) return refuse('halted', state.halted.reason)
  if (!rootIsFresh(state, ctx.now)) return refuse('root-expired')
  if (!listIsCurrent(state, list, ctx)) return refuse('list-not-current')
  const opened = openEnvelope(envelope, TRUST_NAMESPACES.freshness, state.root.keys, state.root.document.roles.freshness, crypto)
  if (!opened.ok) return opened
  const parsed = parseFreshness(opened.payload)
  if (!parsed.ok) return refuse('freshness-shape', parsed.problem)
  const doc = parsed.document
  if (doc.scope !== `company:${ctx.companyId}`) return refuse('other-company')
  if (doc.server !== ctx.server) return refuse('other-server')
  if (doc.targets.version !== list.document.version || doc.targets.sha256 !== list.sha256) return refuse('other-list')
  const issued = time(doc.issued)
  const timing = timeProblem(issued, time(doc.expires), PLUGIN_TRUST_POLICY.maxFreshnessLifetimeMs, ctx.now)
  if (timing) return timing as TrustResult<never>
  const sha256 = sha256Hex(opened.envelope.signed, crypto)
  const key = markKey(ctx.server, ctx.companyId)
  const generation = roleGeneration(state.root, 'freshness')
  const against = markProblem(markOf(state.freshMarks, key, generation), doc.version, sha256, issued, ctx.now)
  if (against) return against as TrustResult<never>
  return {
    ok: true,
    state: { ...state, freshMarks: { ...state.freshMarks, [key]: { generation, version: doc.version, sha256, issued } } },
    freshness: { server: ctx.server, companyId: ctx.companyId, document: doc, sha256 },
  }
}

// ---------------------------------------------------------------- may code run now?

/**
 * Until when the company's plugin code may run (v3.1 §2): min(newest root, list, freshness)
 * expiry — needing the list **and** its freshness, both still the current records of their
 * generations (a root that replaced either key revokes them), and a clock not behind what was seen.
 * P1 only answers; P4 closes frames and engines with it.
 */
export function codeMayRunUntil(state: TrustState, list: AcceptedList | null, freshness: AcceptedFreshness | null, ctx: TrustContext): TrustResult<{ until: number }> {
  if (state.halted) return refuse('halted', state.halted.reason)
  const mark = list ? listIsCurrent(state, list, ctx) : null
  if (!list || !mark) return refuse('list-not-current')
  if (!freshness) return refuse('no-freshness')
  const fresh = markOf(state.freshMarks, markKey(ctx.server, ctx.companyId), roleGeneration(state.root, 'freshness'))
  if (!fresh || fresh.sha256 !== freshness.sha256 || freshness.server !== ctx.server || freshness.companyId !== ctx.companyId
    || freshness.document.targets.sha256 !== list.sha256) return refuse('freshness-not-current')
  if (ctx.now < Math.max(mark.issued, fresh.issued) - PLUGIN_TRUST_POLICY.clockSkewMs) return refuse('clock-went-back')
  const until = Math.min(time(state.root.document.expires), time(list.document.expires), time(freshness.document.expires))
  if (until <= ctx.now) return refuse('expired')
  return { ok: true, until }
}
