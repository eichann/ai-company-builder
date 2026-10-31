/**
 * Fixed content (固定した中身, milestone 4 design §3-2 / §4-3,
 * `.claude/rules/approvals.md` "Fixed content"): the one way the approvals
 * service (G6) and outbound mail (G8) store what a person approves or sends.
 *
 * - `fix` hashes the canonical text (`lib/content-hash.ts`, the server's one
 *   hashing helper) and stores it as the owner's next version; rows are never
 *   rewritten (trigger `fixed_payloads_immutable`).
 * - `matches` is the check before acting: the hash the person was shown must
 *   equal the hash of the owner's newest version, and its text must still be
 *   there — a difference of one space is a different content (§4-3).
 * - `clearBodies` is retention (mail bodies after 30 days, design §9 q9): the
 *   text goes, the hash and version stay.
 */
import { CONTENT_HASH_RE } from '../../shared/core/fixed-content'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { FixedPayloadOwnerKind, FixedPayloadRow } from '../ports/fixed-payloads'
import { hashCanonical } from '../lib/content-hash'

export interface FixedPayloadDeps {
  companyData: CompanyDataSource
  clock: Clock
}

export type FixedPayloadMatch =
  | { ok: true; row: FixedPayloadRow & { canonical: string } }
  | { ok: false; reason: 'none' | 'bad-hash' | 'changed' | 'body-deleted' }

export function createFixedPayloads(deps: FixedPayloadDeps) {
  const repo = (companyId: string) => deps.companyData.forCompany(companyId).fixedPayloads
  return {
    /**
     * Store `canonical` as the owner's next version. Null when another writer
     * stored that version at the same moment (nothing written; ask again).
     * Run it inside the caller's transaction when the owner record is created
     * with it, so neither is left without the other.
     */
    fix(companyId: string, ownerKind: FixedPayloadOwnerKind, ownerId: string, canonical: string): { version: number; hash: string } | null {
      const r = repo(companyId)
      const version = (r.latest(ownerKind, ownerId)?.version ?? 0) + 1
      const hash = hashCanonical(canonical)
      return r.insert({ ownerKind, ownerId, version, canonical, hash, createdAt: deps.clock.now() }) ? { version, hash } : null
    },
    /** The newest version, or null. */
    current(companyId: string, ownerKind: FixedPayloadOwnerKind, ownerId: string): FixedPayloadRow | null {
      return repo(companyId).latest(ownerKind, ownerId)
    },
    /** The newest version of each owner. */
    currentOf(companyId: string, ownerKind: FixedPayloadOwnerKind, ownerIds: string[]): FixedPayloadRow[] {
      return repo(companyId).latestOf(ownerKind, ownerIds)
    },
    /** Is `shownHash` the hash of the owner's newest version, with its text still kept? */
    matches(companyId: string, ownerKind: FixedPayloadOwnerKind, ownerId: string, shownHash: unknown): FixedPayloadMatch {
      if (typeof shownHash !== 'string' || !CONTENT_HASH_RE.test(shownHash)) return { ok: false, reason: 'bad-hash' }
      const row = repo(companyId).latest(ownerKind, ownerId)
      if (!row) return { ok: false, reason: 'none' }
      if (row.hash !== shownHash) return { ok: false, reason: 'changed' }
      if (row.canonical === null) return { ok: false, reason: 'body-deleted' }
      return { ok: true, row: row as FixedPayloadRow & { canonical: string } }
    },
    /** Retention: clear the texts of these owners (hash and version stay). */
    clearBodies(companyId: string, ownerKind: FixedPayloadOwnerKind, ownerIds: string[]): number {
      return repo(companyId).clearBodies(ownerKind, ownerIds, deps.clock.now())
    },
  }
}

export type FixedPayloadService = ReturnType<typeof createFixedPayloads>
