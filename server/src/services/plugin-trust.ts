/**
 * Handing each company's signed plugin trust documents to its members' apps
 * (`.claude/rules/plugin-trust.md` "P2"; design 署名の検証 v3 §5, §13 P2 + v3.1 §3–§4).
 *
 * - `documentsFor(member)`: `GET /api/companies/:companyId/plugin-trust` (any member): the root
 *   chain and **only the member's company's** list and freshness document, and only what
 *   `companyTrustToServe` accepts (the same checks as the app, by this server's clock). The company
 *   is the member's (server-side), never a value from the request; its file name is built by the
 *   core from that id. Nothing is enforced here: P2 only hands documents out.
 * - `digestFor(companyId)`: what the agent policy carries (`pluginTrust`), so a new document reaches
 *   the apps at their next policy refresh without them asking this route every time.
 * - Every call looks at the files' stamp (`lstat` only: the operator's timer swaps them); they are
 *   read and verified again when the stamp changed, else the answer is reused until the earliest
 *   expiry or 5 minutes (policy requests do not read every root file each time).
 * - The operator is told (log, at most hourly per company and note) what was withheld and when the
 *   documents run out within 48 hours (v3.1 §4). Codes and hours only, never a document's content.
 */
import {
  NO_TRUST_DOCUMENTS, companyTrustToServe, trustServerOf,
  type PluginTrustDocuments, type ServedCompanyTrust,
} from '../../shared/core/plugin-trust-distribution'
import { toHex, utf8, type PluginTrustCrypto } from '../../shared/core/plugin-trust-sshsig'
import type { Clock } from '../ports/clock'
import type { PluginTrustFiles } from '../ports/plugin-trust'
import type { Member } from './access'
import { ok, type Outcome } from './outcome'

export interface PluginTrustDeps {
  files: PluginTrustFiles
  crypto: PluginTrustCrypto
  clock: Pick<Clock, 'nowMs'>
  /** This server's public URL (lib/config.ts `publicUrl`), as the signed documents name it. */
  publicUrl: () => string
  log?: Pick<Console, 'warn'>
}

const CACHE_MS = 5 * 60_000
const NOTE_EVERY_MS = 3_600_000

interface Cached { key: string; served: ServedCompanyTrust; until: number }

export function createPluginTrustService(deps: PluginTrustDeps) {
  const log = deps.log ?? console
  const cache = new Map<string, Cached>()
  const stamped = new Map<string, { stamp: string; served: ServedCompanyTrust | null; until: number }>()
  const noted = new Map<string, number>()
  const sha256 = (text: string): string => toHex(deps.crypto.sha256(utf8(text)))

  function note(companyId: string, text: string, now: number): void {
    const key = `${companyId}\0${text.replace(/\d+ h/, 'N h')}`
    if ((noted.get(key) ?? -Infinity) > now - NOTE_EVERY_MS) return
    noted.set(key, now)
    log.warn(`[plugin-trust] company=${companyId}: ${text}`)
  }

  /** What this company's members are handed now, or null when no `trust/` folder is set up. */
  async function served(companyId: string): Promise<ServedCompanyTrust | null> {
    // Nothing changed on disk (same stamp: no file read) and still within the answer's life → reuse it.
    const stamp = `${deps.publicUrl()}\n${await deps.files.stamp(companyId)}`
    const seen = stamped.get(companyId)
    if (seen && seen.stamp === stamp && deps.clock.nowMs() < seen.until) return seen.served
    const result = await readAndServe(companyId)
    stamped.set(companyId, { stamp, served: result, until: Math.min(deps.clock.nowMs() + CACHE_MS, result?.until ?? Infinity) })
    return result
  }

  async function readAndServe(companyId: string): Promise<ServedCompanyTrust | null> {
    const texts = await deps.files.read(companyId)
    if (!texts) return null
    const now = deps.clock.nowMs()
    for (const p of texts.problems) note(companyId, `cannot read trust/${p}`, now)
    const server = trustServerOf(deps.publicUrl())
    if (!server) {
      note(companyId, 'PUBLIC_URL is not http(s)://host[:port]: no trust document can name this server; nothing is handed out', now)
      return { documents: NO_TRUST_DOCUMENTS, notes: [], until: null }
    }
    const key = sha256(JSON.stringify([server, texts.roots, texts.targets, texts.freshness]))
    const hit = cache.get(companyId)
    if (hit && hit.key === key && now < hit.until) return hit.served
    const result = companyTrustToServe(texts, { server, companyId, now }, deps.crypto)
    for (const n of result.notes) note(companyId, n, now)
    cache.set(companyId, { key, served: result, until: Math.min(now + CACHE_MS, result.until ?? Infinity) })
    return result
  }

  return {
    async documentsFor(member: Pick<Member, 'companyId'>): Promise<Outcome<PluginTrustDocuments>> {
      return ok((await served(member.companyId))?.documents ?? NO_TRUST_DOCUMENTS)
    },
    /** The agent policy's `pluginTrust` marker: null when no `trust/` folder is set up. */
    async digestFor(companyId: string): Promise<string | null> {
      const s = await served(companyId)
      return s ? sha256(JSON.stringify(s.documents)).slice(0, 32) : null
    },
  }
}

export type PluginTrustService = ReturnType<typeof createPluginTrustService>
