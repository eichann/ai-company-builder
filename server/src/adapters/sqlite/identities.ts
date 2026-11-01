/**
 * SQLite storage of matching people and companies (名寄せ, ports/identities.ts),
 * limited to one company: every statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import type { IdentityHow, IdentityHistoryAction, IdentityKind } from '../../../shared/core/identity'
import type { IdentityHistoryRow, IdentityMemberRow, IdentityProposalRow, IdentityRepository } from '../../ports/identities'

type MemberRow = {
  record_id: string; identity_id: string; kind: string | null; email: string | null; domain: string | null
  held: number; how: string; joined_at: string; joined_by: string | null
}
type ProposalRow = {
  id: string; a_record: string; b_record: string; reason: string; confidence: number | null
  proposed_by_kind: string; proposed_by: string; status: string; created_at: string; decided_by: string | null; decided_at: string | null
}
type HistoryRow = {
  identity_id: string; record_id: string; action: string; how: string | null; proposal_id: string | null
  actor_kind: string; actor_id: string | null; at: string
}

const MEMBER_COLS = 'record_id, identity_id, kind, email, domain, held, how, joined_at, joined_by'
const MEMBER_ORDER = 'ORDER BY joined_at, record_id'
const PROPOSAL_COLS = 'id, a_record, b_record, reason, confidence, proposed_by_kind, proposed_by, status, created_at, decided_by, decided_at'

const member = (r: MemberRow): IdentityMemberRow => ({
  recordId: r.record_id, identityId: r.identity_id, kind: r.kind as IdentityKind | null, email: r.email, domain: r.domain,
  held: r.held === 1, how: r.how as IdentityHow, joinedAt: r.joined_at, joinedBy: r.joined_by,
})
const proposal = (r: ProposalRow): IdentityProposalRow => ({
  id: r.id, a: r.a_record, b: r.b_record, reason: r.reason, confidence: r.confidence,
  proposedByKind: r.proposed_by_kind as 'human' | 'ai', proposedBy: r.proposed_by,
  status: r.status as IdentityProposalRow['status'], createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
})
const history = (r: HistoryRow): IdentityHistoryRow => ({
  identityId: r.identity_id, recordId: r.record_id, action: r.action as IdentityHistoryAction, how: r.how as IdentityHow | null,
  proposalId: r.proposal_id, actorKind: r.actor_kind as IdentityHistoryRow['actorKind'], actorId: r.actor_id, at: r.at,
})

export function sqliteIdentityRepository(conn: Database.Database, companyId: string): IdentityRepository {
  return {
    memberRecordIds() {
      return (conn.prepare('SELECT record_id FROM identity_members WHERE company_id = ?').all(companyId) as Array<{ record_id: string }>).map(r => r.record_id)
    },
    member(recordId) {
      const r = conn.prepare(`SELECT ${MEMBER_COLS} FROM identity_members WHERE company_id = ? AND record_id = ?`).get(companyId, recordId) as MemberRow | undefined
      return r ? member(r) : null
    },
    members(identityId) {
      return (conn.prepare(`SELECT ${MEMBER_COLS} FROM identity_members WHERE company_id = ? AND identity_id = ? ${MEMBER_ORDER}`)
        .all(companyId, identityId) as MemberRow[]).map(member)
    },
    withKeys(email, domain) {
      if (email === null && domain === null) return []
      return (conn.prepare(`SELECT ${MEMBER_COLS} FROM identity_members
          WHERE company_id = ? AND ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND domain = ?)) ${MEMBER_ORDER}`)
        .all(companyId, email, email, domain, domain) as MemberRow[]).map(member)
    },
    identityKind(identityId) {
      const r = conn.prepare('SELECT kind FROM identities WHERE company_id = ? AND id = ?').get(companyId, identityId) as { kind: string | null } | undefined
      return (r?.kind ?? null) as IdentityKind | null
    },
    createIdentity(identityId, kind, at) {
      conn.prepare('INSERT INTO identities (company_id, id, kind, created_at) VALUES (?, ?, ?, ?)').run(companyId, identityId, kind, at)
    },
    putMember(row) {
      conn.prepare(`INSERT INTO identity_members (company_id, ${MEMBER_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (company_id, record_id) DO UPDATE SET identity_id = excluded.identity_id, kind = excluded.kind,
            email = excluded.email, domain = excluded.domain, held = excluded.held, how = excluded.how,
            joined_at = excluded.joined_at, joined_by = excluded.joined_by`)
        .run(companyId, row.recordId, row.identityId, row.kind, row.email, row.domain, row.held ? 1 : 0, row.how, row.joinedAt, row.joinedBy)
    },
    moveAll(from, to) {
      conn.prepare('UPDATE identity_members SET identity_id = ? WHERE company_id = ? AND identity_id = ?').run(to, companyId, from)
    },

    proposal(id) {
      const r = conn.prepare(`SELECT ${PROPOSAL_COLS} FROM identity_proposals WHERE company_id = ? AND id = ?`).get(companyId, id) as ProposalRow | undefined
      return r ? proposal(r) : null
    },
    pairProposals(a, b) {
      return (conn.prepare(`SELECT ${PROPOSAL_COLS} FROM identity_proposals
          WHERE company_id = ? AND ((a_record = ? AND b_record = ?) OR (a_record = ? AND b_record = ?)) ORDER BY created_at DESC, id`)
        .all(companyId, a, b, b, a) as ProposalRow[]).map(proposal)
    },
    pendingProposals() {
      return (conn.prepare(`SELECT ${PROPOSAL_COLS} FROM identity_proposals WHERE company_id = ? AND status = 'pending' ORDER BY created_at, id`)
        .all(companyId) as ProposalRow[]).map(proposal)
    },
    insertProposal(row) {
      conn.prepare(`INSERT INTO identity_proposals (company_id, ${PROPOSAL_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.id, row.a, row.b, row.reason, row.confidence, row.proposedByKind, row.proposedBy, row.status, row.createdAt, row.decidedBy, row.decidedAt)
    },
    decideProposal(id, status, by, at) {
      return conn.prepare(`UPDATE identity_proposals SET status = ?, decided_by = ?, decided_at = ?
          WHERE company_id = ? AND id = ? AND status = 'pending'`).run(status, by, at, companyId, id).changes === 1
    },

    appendHistory(row) {
      conn.prepare(`INSERT INTO identity_history (company_id, identity_id, record_id, action, how, proposal_id, actor_kind, actor_id, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.identityId, row.recordId, row.action, row.how, row.proposalId, row.actorKind, row.actorId, row.at)
    },
    historyOf(recordIds) {
      if (recordIds.length === 0) return []
      const out: IdentityHistoryRow[] = []
      for (let i = 0; i < recordIds.length; i += 500) {
        const part = recordIds.slice(i, i + 500)
        out.push(...(conn.prepare(`SELECT identity_id, record_id, action, how, proposal_id, actor_kind, actor_id, at, seq FROM identity_history
            WHERE company_id = ? AND record_id IN (${part.map(() => '?').join(', ')}) ORDER BY seq`)
          .all(companyId, ...part) as Array<HistoryRow & { seq: number }>).map(r => ({ ...history(r), seq: r.seq })))
      }
      return (out as Array<IdentityHistoryRow & { seq: number }>).sort((x, y) => x.seq - y.seq).map(({ seq: _seq, ...r }) => { void _seq; return r })
    },
  }
}
