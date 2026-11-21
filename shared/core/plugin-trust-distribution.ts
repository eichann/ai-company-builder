/**
 * Plugin trust, part 4 (P2): handing the signed documents out and taking them in
 * (`.claude/rules/plugin-trust.md` "P2"; design 署名の検証 v3 §5, §13 P2 + v3.1 §2–§4). Pure, like
 * parts 1–3: the server, the operator's tools and the app all judge with these functions and the
 * same state machine (`plugin-trust.ts`), over an injected clock and crypto.
 *
 * - **Where the operator puts them** (`<PLUGINS_DIR>/trust/`, read only to the server):
 *   `root/<version>.json`, `targets/company-<id>.json`, `freshness/company-<id>.json` — one list
 *   and one freshness document per company. A file name is only ever built from a company id the
 *   core accepts (`companyTrustFiles`).
 * - **What the server hands a member** (`companyTrustToServe`): the root chain it can authenticate
 *   and **only that company's** list and freshness document, and only when they pass the same
 *   checks the app makes (signatures, shape, scope = this company, server = this server, times by
 *   the server's clock, the freshness bound to that list). Nothing else, never another company's.
 *   The server keeps no record (it is not the authority): it filters so an app is not handed what
 *   it would refuse, and it tells the operator what it withheld and when the documents run out.
 * - **What the app takes in** (`takeCompanyTrust`): the roots (the chain grows, or a conflict
 *   halts), then the list against its own record, then the freshness. The app's clock and record
 *   decide; nothing the server says about time is used.
 */
import { COMPANY_ID_RE } from './plugin-declaration-rules'
import { isTrustServer, parseEnvelope, rootVersionOf, type SignedEnvelope, type TrustRefusalCode } from './plugin-trust-documents'
import {
  acceptFreshness, acceptTargets, bakedRoot, codeMayRunUntil, startTrust, updateTrustRoot,
  type AcceptedFreshness, type AcceptedList, type TrustContext, type TrustState,
} from './plugin-trust'
import type { PluginTrustCrypto } from './plugin-trust-sshsig'

/** A root file's name in `trust/root/`: its version. */
export const TRUST_ROOT_FILE_RE = /^([1-9][0-9]{0,9})\.json$/
/** At most this many roots are read or handed out (a root lives a year; this is decades). */
export const MAX_TRUST_ROOTS = 64
/** The operator is told when what lets a company's code run ends within this time (v3.1 §4). */
export const TRUST_NOTICE_BEFORE_MS = 48 * 3_600_000

/**
 * The server as the signed documents name it, from a configured URL: trailing slashes removed, and
 * then it must be `http(s)://host[:port]` exactly (else null: a URL with a path cannot be signed for).
 */
export function trustServerOf(url: string): string | null {
  const s = url.trim().replace(/\/+$/, '')
  return isTrustServer(s) ? s : null
}

/** A company's two files inside `trust/` (relative, `/`), or null for an id that cannot name a file. */
export function companyTrustFiles(companyId: string): { targets: string; freshness: string } | null {
  if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) return null
  return { targets: `targets/company-${companyId}.json`, freshness: `freshness/company-${companyId}.json` }
}

/** The answer of `GET /api/companies/:companyId/plugin-trust` (and what the app parses). */
export interface PluginTrustDocuments {
  /** Authenticated roots, oldest first. */
  roots: SignedEnvelope[]
  /** This company's list, or null (none, or the server withheld it). */
  targets: SignedEnvelope | null
  /** Its freshness document, or null. */
  freshness: SignedEnvelope | null
}

export const NO_TRUST_DOCUMENTS: PluginTrustDocuments = Object.freeze({ roots: [], targets: null, freshness: null }) as PluginTrustDocuments

/** The answer's shape, strictly: exactly these three keys, envelopes only. Anything else → null (the app changes nothing). */
export function parsePluginTrustDocuments(value: unknown): PluginTrustDocuments | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => k !== 'roots' && k !== 'targets' && k !== 'freshness')) return null
  if (!Array.isArray(v.roots) || v.roots.length > MAX_TRUST_ROOTS) return null
  const roots: SignedEnvelope[] = []
  for (const r of v.roots) {
    const env = parseEnvelope(r)
    if (!env) return null
    roots.push(env)
  }
  const one = (x: unknown): SignedEnvelope | null | undefined => (x === null ? null : parseEnvelope(x) ?? undefined)
  const targets = one(v.targets)
  const freshness = one(v.freshness)
  if (targets === undefined || freshness === undefined) return null
  if (targets === null && freshness !== null) return null
  return { roots, targets, freshness }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

// ---------------------------------------------------------------- the server

/** A company's files as read from `trust/` (texts; null = no such file). */
export interface CompanyTrustTexts {
  roots: string[]
  targets: string | null
  freshness: string | null
}

export interface ServedCompanyTrust {
  documents: PluginTrustDocuments
  /** For the operator's log: what was withheld and why (codes only, never a document's content), or that it runs out soon. */
  notes: string[]
  /** Until when, by the server's clock, the handed list and freshness let code run; null when they do not. */
  until: number | null
}

/**
 * What the server hands one company's members (v3 §5, §13 P2: "the server verifies with the same
 * code and hands out nothing it does not accept"). Roots: the server starts from the lowest root
 * file that carries its own threshold and hands the chain it can authenticate from there (an app
 * re-checks it from its own root). A root conflict → nothing at all. Then the company's list
 * (`acceptTargets` on a fresh record: scope, server, signatures, times by `ctx.now`) and its
 * freshness (bound to that list); either refused → withheld, with a note.
 */
export function companyTrustToServe(texts: CompanyTrustTexts, ctx: TrustContext, crypto: PluginTrustCrypto): ServedCompanyTrust {
  const notes: string[] = []
  const envelopes = texts.roots.slice(0, MAX_TRUST_ROOTS).map(t => parseEnvelope(safeJson(t)))
  if (envelopes.some(e => e === null)) notes.push('a root file is not a signed envelope (skipped)')
  const roots = (envelopes.filter(e => e !== null) as SignedEnvelope[])
    .sort((a, b) => (rootVersionOf(a) ?? 0) - (rootVersionOf(b) ?? 0))
  let start: SignedEnvelope | null = null
  for (const env of roots) {
    try { bakedRoot(env, crypto); start = env; break } catch { /* not a root on its own: try the next */ }
  }
  if (!start) return { documents: NO_TRUST_DOCUMENTS, notes: [...notes, 'no root file carries its own root threshold: nothing is handed out'], until: null }
  const state = updateTrustRoot(startTrust(start, null, crypto), roots, crypto)
  if (state.halted) return { documents: NO_TRUST_DOCUMENTS, notes: [...notes, `halted: ${state.halted.reason}; nothing is handed out`], until: null }
  if (state.problem) notes.push(state.problem)
  const chain = state.chain.map(r => r.envelope)
  const withheld = (what: string, code: TrustRefusalCode | string): ServedCompanyTrust['documents'] => {
    notes.push(`${what} withheld: ${code}`)
    return { roots: chain, targets: null, freshness: null }
  }
  if (texts.targets === null) return { documents: { roots: chain, targets: null, freshness: null }, notes, until: null }
  const targetsEnvelope = parseEnvelope(safeJson(texts.targets))
  if (!targetsEnvelope) return { documents: withheld('list', 'envelope'), notes, until: null }
  const t = acceptTargets(state, targetsEnvelope, ctx, crypto)
  if (!t.ok) return { documents: withheld('list', t.code), notes, until: null }
  const listOnly = { roots: chain, targets: targetsEnvelope, freshness: null }
  if (texts.freshness === null) {
    notes.push('no freshness document: code of this company cannot run')
    return { documents: listOnly, notes, until: null }
  }
  const freshEnvelope = parseEnvelope(safeJson(texts.freshness))
  const f = freshEnvelope ? acceptFreshness(t.state, freshEnvelope, t.list, ctx, crypto) : null
  if (!freshEnvelope || !f || !f.ok) {
    notes.push(`freshness withheld: ${f && !f.ok ? f.code : 'envelope'}`)
    return { documents: listOnly, notes, until: null }
  }
  const run = codeMayRunUntil(f.state, t.list, f.freshness, ctx)
  const until = run.ok ? run.until : null
  if (until !== null && until - ctx.now < TRUST_NOTICE_BEFORE_MS) {
    notes.push(`runs out in ${Math.max(0, Math.floor((until - ctx.now) / 3_600_000))} h: plugin code of this company stops then unless a new freshness document (or list / root) arrives`)
  }
  return { documents: { roots: chain, targets: targetsEnvelope, freshness: freshEnvelope }, notes, until }
}

// ---------------------------------------------------------------- the app

export interface TakenCompanyTrust {
  state: TrustState
  /** The list and freshness accepted now (null = not accepted now; an earlier handle may still be the record's). */
  list: AcceptedList | null
  freshness: AcceptedFreshness | null
  /** What was refused (codes only). */
  notes: string[]
}

/**
 * Take what the server handed for one company into the app's state (v3 §4, v3.1 §2): roots first
 * (the chain grows; two authentic texts for one version halt for good), then the list against the
 * record of this server × company × generation, then the freshness bound to it. Every judgment is
 * the app's: its own root and record, its own clock (`ctx.now`).
 */
export function takeCompanyTrust(state: TrustState, documents: PluginTrustDocuments, ctx: TrustContext, crypto: PluginTrustCrypto): TakenCompanyTrust {
  const notes: string[] = []
  const rooted = documents.roots.length > 0 ? updateTrustRoot(state, documents.roots, crypto) : state
  if (rooted.halted) return { state: rooted, list: null, freshness: null, notes: [`halted: ${rooted.halted.reason}`] }
  if (!documents.targets) return { state: rooted, list: null, freshness: null, notes: ['no list handed out'] }
  const t = acceptTargets(rooted, documents.targets, ctx, crypto)
  if (!t.ok) return { state: rooted, list: null, freshness: null, notes: [`list refused: ${t.code}`] }
  if (!documents.freshness) return { state: t.state, list: t.list, freshness: null, notes: ['no freshness handed out'] }
  const f = acceptFreshness(t.state, documents.freshness, t.list, ctx, crypto)
  if (!f.ok) return { state: t.state, list: t.list, freshness: null, notes: [`freshness refused: ${f.code}`] }
  return { state: f.state, list: t.list, freshness: f.freshness, notes }
}
