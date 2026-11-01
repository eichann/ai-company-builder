/**
 * Matching people and companies (名寄せ, `.claude/rules/identity.md`) behind
 * the company handle: every method is limited to the handle's company.
 *
 * An identity (背番号) gathers the 相手 records that are the same company or
 * person. A record is in at most one identity; its matching keys are kept as
 * they were when it joined.
 */
import type { IdentityHow, IdentityHistoryAction, IdentityKind } from '../../shared/core/identity'

export interface IdentityMemberRow {
  recordId: string
  identityId: string
  kind: IdentityKind | null
  email: string | null
  domain: string | null
  /** Split off by a person: never a target of automatic matching. */
  held: boolean
  how: IdentityHow
  joinedAt: string
  /** The member who approved or split; null for automatic matching. */
  joinedBy: string | null
}

export interface IdentityProposalRow {
  id: string
  a: string
  b: string
  reason: string
  confidence: number | null
  proposedByKind: 'human' | 'ai'
  proposedBy: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedBy: string | null
  decidedAt: string | null
}

export interface IdentityHistoryRow {
  identityId: string
  recordId: string
  action: IdentityHistoryAction
  how: IdentityHow | null
  proposalId: string | null
  actorKind: 'auto' | 'human' | 'ai'
  actorId: string | null
  at: string
}

export interface IdentityRepository {
  /** Every record that is a member of some identity (catching up new 相手). */
  memberRecordIds(): string[]
  member(recordId: string): IdentityMemberRow | null
  /** Members of an identity, oldest first. */
  members(identityId: string): IdentityMemberRow[]
  /** Members with this address or this company domain, oldest first (automatic matching and resolving). */
  withKeys(email: string | null, domain: string | null): IdentityMemberRow[]
  identityKind(identityId: string): IdentityKind | null
  createIdentity(identityId: string, kind: IdentityKind | null, at: string): void
  /** Adds or replaces the record's membership. */
  putMember(row: IdentityMemberRow): void
  /** Moves every member of `from` into `to` (merging two identities). */
  moveAll(from: string, to: string): void

  proposal(id: string): IdentityProposalRow | null
  /** A proposal about this pair (either order), the latest first. */
  pairProposals(a: string, b: string): IdentityProposalRow[]
  pendingProposals(): IdentityProposalRow[]
  insertProposal(row: IdentityProposalRow): void
  /** Decides a pending proposal; false when it is no longer pending. */
  decideProposal(id: string, status: 'approved' | 'rejected', by: string, at: string): boolean

  appendHistory(row: IdentityHistoryRow): void
  /** History entries about these records, oldest first. */
  historyOf(recordIds: string[]): IdentityHistoryRow[]
}
