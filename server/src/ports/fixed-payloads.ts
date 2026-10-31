/**
 * Fixed content (固定した中身, milestone 4 design §3-2 / §4-3,
 * `.claude/rules/approvals.md`): what a person approves (an approval request)
 * or sends (an outbound mail), one row per version, never rewritten. The hash
 * is computed by the server (`lib/content-hash.ts` `hashCanonical`) over the
 * canonical text (`shared/core/fixed-content.ts` `canonicalJson`, or the mail's
 * own canonical form). Bound to one company (the company handle).
 */
export type FixedPayloadOwnerKind = 'approval' | 'outbound_message'

export interface FixedPayloadRow {
  ownerKind: FixedPayloadOwnerKind
  ownerId: string
  version: number
  /** null once retention cleared the text (`bodyDeletedAt`); the hash stays. */
  canonical: string | null
  hash: string
  createdAt: string
  bodyDeletedAt: string | null
}

export interface FixedPayloadRepository {
  /** Add a version; false when that version of the owner already exists (two writers at once: one wins). */
  insert(row: { ownerKind: FixedPayloadOwnerKind; ownerId: string; version: number; canonical: string; hash: string; createdAt: string }): boolean
  /** The newest version of an owner, or null. */
  latest(ownerKind: FixedPayloadOwnerKind, ownerId: string): FixedPayloadRow | null
  /** The newest version of each owner listed (owners without one are left out). */
  latestOf(ownerKind: FixedPayloadOwnerKind, ownerIds: string[]): FixedPayloadRow[]
  /** Retention: clear the text of every version of these owners (hash, owner and version stay). Returns rows cleared. */
  clearBodies(ownerKind: FixedPayloadOwnerKind, ownerIds: string[], at: string): number
}
