/**
 * Matching people and companies (名寄せ, `.claude/rules/identity.md`, stage 3
 * B1): the core's cross-service layer. An identity (背番号) gathers the 相手
 * records (types implementing `counterpart`) that are one company or person.
 *
 * - Automatic (shared/core/identity.ts `autoMatch`): the same address → the
 *   same 相手; the same company domain → the same company, never a free-mail
 *   domain. New 相手 are caught up on every call (`catchUp`).
 * - Anything else: the AI (or a person) proposes, a person approves; approving
 *   merges the two identities.
 * - Split: a person takes a record out into an identity of its own; it is
 *   held, so automatic matching never puts it back.
 * - History is append-only.
 *
 * No leaks (records.md "No leaks"): a record the caller cannot read is a
 * record that does not exist here too — left out of members, proposals and
 * history, and naming one gets exactly the answer of a missing record.
 * Answers carry record ids, types and titles of readable records only, never
 * a folder.
 */
import {
  autoMatch, companyDomainOfAddress, identityKeysOf, readIdentityProposal,
  type IdentityHistoryView, type IdentityKeys, type IdentityMemberView, type IdentityProposalView, type IdentityView,
} from '../../shared/core/identity'
import { normalizeEmail } from '../../shared/core/mail'
import { RECORD_ID_RE } from '../../shared/core/records'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { IdentityMemberRow, IdentityProposalRow } from '../ports/identities'
import type { RecordRow } from '../ports/records'
import type { Transactions } from '../ports/transactions'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader, type RecordReader } from './record-access'
import { currentTypes } from './record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from './records'

export const IDENTITY_PROPOSAL_NOT_FOUND = { error: '提案が見つかりません', code: 'IDENTITY_PROPOSAL_NOT_FOUND' }

/** How many 相手 one catch-up looks at (a company's whole list of customers, in practice). */
const CATCH_UP_LIMIT = 20_000

export interface IdentityDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

export type IdentityActor = { kind: 'human' } | { kind: 'ai' }

interface Ctx {
  handle: CompanyData
  reader: RecordReader
  counterparts: Set<string>
}

export function createIdentityService(deps: IdentityDeps) {
  function fieldsOf(handle: CompanyData, id: string): Record<string, unknown> {
    const s = handle.records.states([id])[0]
    try { return s ? JSON.parse(s.fields) as Record<string, unknown> : {} } catch { return {} }
  }

  function counterpartTypes(handle: CompanyData): Set<string> {
    const out = new Set<string>()
    for (const [name, t] of currentTypes(handle.records)) if (t.definition.implements.includes('counterpart')) out.add(name)
    return out
  }

  /** Join `recordId` (keys `keys`) to the identity automatic matching finds, or a new one. */
  function join(handle: CompanyData, recordId: string, keys: IdentityKeys, at: string): void {
    const found = autoMatch(keys, handle.identities.withKeys(keys.email, keys.domain))
    const identityId = found?.identityId ?? deps.ids.newId()
    if (!found) handle.identities.createIdentity(identityId, keys.kind, at)
    const how = found?.how ?? 'new'
    handle.identities.putMember({ recordId, identityId, ...keys, held: false, how, joinedAt: at, joinedBy: null })
    handle.identities.appendHistory({ identityId, recordId, action: 'joined', how, proposalId: null, actorKind: 'auto', actorId: null, at })
  }

  /**
   * Every live 相手 not yet in an identity joins one (oldest record id first,
   * so the result does not depend on the order they changed in). A record's
   * keys are those it had when it joined (identity.md "Not yet").
   */
  function catchUp(handle: CompanyData, counterparts: Set<string>): void {
    if (counterparts.size === 0) return
    const known = new Set(handle.identities.memberRecordIds())
    const fresh = handle.records.candidates({ types: [...counterparts] }, CATCH_UP_LIMIT)
      .map(r => r.id).filter(id => !known.has(id)).sort()
    if (fresh.length === 0) return
    const at = deps.clock.now()
    deps.transactions.run(() => {
      for (const id of fresh) {
        if (handle.identities.member(id)) continue
        join(handle, id, identityKeysOf(fieldsOf(handle, id)), at)
      }
    })
  }

  function context(member: Member): Outcome<Ctx> {
    const handle = deps.companyData.forCompany(member.companyId)
    if (!handle.records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
    const counterparts = counterpartTypes(handle)
    catchUp(handle, counterparts)
    return ok({ handle, reader: recordReader(member, handle.scopes.listWithRules()), counterparts })
  }

  const notFound = () => refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })

  /** Live, readable rows of these records, by id. */
  function readable(ctx: Ctx, ids: string[]): Map<string, RecordRow> {
    const unique = [...new Set(ids)]
    return new Map(ctx.handle.records.byIds(unique).filter(r => r.removedAt === null && ctx.reader.record(r)).map(r => [r.id, r]))
  }

  /** A readable 相手 that is in an identity, or null (the same for missing, unreadable, another company's, not a 相手). */
  function readableMember(ctx: Ctx, recordId: unknown): { row: RecordRow; member: IdentityMemberRow } | null {
    if (typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) return null
    const row = readable(ctx, [recordId]).get(recordId)
    if (!row || !ctx.counterparts.has(row.type)) return null
    const member = ctx.handle.identities.member(recordId)
    return member ? { row, member } : null
  }

  function proposalView(p: IdentityProposalRow): IdentityProposalView {
    return {
      id: p.id, a: p.a, b: p.b, reason: p.reason, confidence: p.confidence,
      proposedBy: { kind: p.proposedByKind, userId: p.proposedBy },
      status: p.status, createdAt: p.createdAt, decidedBy: p.decidedBy, decidedAt: p.decidedAt,
    }
  }

  /** Pending proposals both of whose records the caller can read. */
  function visibleProposals(ctx: Ctx, about?: Set<string>): IdentityProposalView[] {
    const pending = ctx.handle.identities.pendingProposals().filter(p => !about || about.has(p.a) || about.has(p.b))
    const rows = readable(ctx, pending.flatMap(p => [p.a, p.b]))
    return pending.filter(p => rows.has(p.a) && rows.has(p.b)).map(proposalView)
  }

  function view(ctx: Ctx, identityId: string): IdentityView {
    const all = ctx.handle.identities.members(identityId)
    const rows = readable(ctx, all.map(m => m.recordId))
    const members: IdentityMemberView[] = all.filter(m => rows.has(m.recordId)).map(m => {
      const r = rows.get(m.recordId)!
      return { recordId: m.recordId, type: r.type, title: r.title, how: m.how, held: m.held, joinedAt: m.joinedAt }
    })
    const visibleIds = new Set(members.map(m => m.recordId))
    const history: IdentityHistoryView[] = ctx.handle.identities.historyOf([...visibleIds]).map(h => ({
      at: h.at, action: h.action, recordId: h.recordId, how: h.how, proposalId: h.proposalId,
      actor: { kind: h.actorKind, userId: h.actorId },
    }))
    return { identityId, kind: ctx.handle.identities.identityKind(identityId), members, proposals: visibleProposals(ctx, visibleIds), history }
  }

  return {
    /** GET …/identities/records/:recordId — the 相手's identity, as far as the caller can read. */
    ofRecord(member: Member, recordId: string): Outcome<IdentityView> {
      const c = context(member)
      if (!c.ok) return c
      const found = readableMember(c.value, recordId)
      if (!found) return notFound()
      return ok(view(c.value, found.member.identityId))
    },

    /** GET …/identities/proposals — pending proposals the caller can read both sides of. */
    proposals(member: Member): Outcome<{ proposals: IdentityProposalView[] }> {
      const c = context(member)
      if (!c.ok) return c
      return ok({ proposals: visibleProposals(c.value) })
    },

    /**
     * Propose that two 相手 are the same (the AI through its record token, or a
     * person). Both must be readable 相手 of the same kind, not already one
     * identity, not rejected before. The same pending pair again returns it.
     */
    propose(member: Member, actor: IdentityActor, body: unknown): Outcome<{ proposal: IdentityProposalView; created: boolean }> {
      const input = readIdentityProposal(body)
      if (typeof input === 'string') return refuse('bad-request', input, { code: 'INVALID_PROPOSAL' })
      const c = context(member)
      if (!c.ok) return c
      const ctx = c.value
      const a = readableMember(ctx, input.a)
      const b = readableMember(ctx, input.b)
      if (!a || !b) return notFound()
      if (a.member.kind !== b.member.kind) {
        return refuse('bad-request', '会社と人は同じとみなせません', { code: 'IDENTITY_KIND_MISMATCH' })
      }
      if (a.member.identityId === b.member.identityId) return refuse('conflict', 'すでに同じ相手としてまとまっています', { code: 'IDENTITY_ALREADY_SAME' })
      const before = ctx.handle.identities.pairProposals(input.a, input.b)
      const pending = before.find(p => p.status === 'pending')
      if (pending) return ok({ proposal: proposalView(pending), created: false })
      if (before.some(p => p.status === 'rejected')) {
        return refuse('conflict', 'この組み合わせは前に「違う」と判断されています', { code: 'IDENTITY_REJECTED_BEFORE' })
      }
      const at = deps.clock.now()
      const row: IdentityProposalRow = {
        id: deps.ids.newId(), a: input.a, b: input.b, reason: input.reason, confidence: input.confidence,
        proposedByKind: actor.kind, proposedBy: member.userId, status: 'pending', createdAt: at, decidedBy: null, decidedAt: null,
      }
      deps.transactions.run(() => {
        ctx.handle.identities.insertProposal(row)
        for (const m of [a.member, b.member]) {
          ctx.handle.identities.appendHistory({ identityId: m.identityId, recordId: m.recordId, action: 'proposed', how: null, proposalId: row.id, actorKind: actor.kind, actorId: member.userId, at })
        }
      })
      return ok({ proposal: proposalView(row), created: true })
    },

    /**
     * POST …/identities/proposals/:id/approve|reject — a person decides. A
     * proposal one of whose records the caller cannot read is a proposal that
     * does not exist. Approving merges b's identity into a's.
     */
    decide(member: Member, proposalId: string, decision: 'approve' | 'reject'): Outcome<{ proposal: IdentityProposalView; identity: IdentityView | null }> {
      const c = context(member)
      if (!c.ok) return c
      const ctx = c.value
      const missing = () => refuse('not-found', IDENTITY_PROPOSAL_NOT_FOUND.error, { code: IDENTITY_PROPOSAL_NOT_FOUND.code })
      const p = typeof proposalId === 'string' && proposalId.length <= 64 ? ctx.handle.identities.proposal(proposalId) : null
      if (!p) return missing()
      const a = readableMember(ctx, p.a)
      const b = readableMember(ctx, p.b)
      if (!a || !b) return missing()
      if (p.status !== 'pending') return refuse('conflict', 'この提案はもう判断されています', { code: 'IDENTITY_PROPOSAL_DECIDED' })
      const at = deps.clock.now()
      const done = deps.transactions.run(() => {
        if (!ctx.handle.identities.decideProposal(p.id, decision === 'approve' ? 'approved' : 'rejected', member.userId, at)) return false
        if (decision === 'reject') {
          for (const m of [a.member, b.member]) {
            ctx.handle.identities.appendHistory({ identityId: m.identityId, recordId: m.recordId, action: 'rejected', how: null, proposalId: p.id, actorKind: 'human', actorId: member.userId, at })
          }
          return true
        }
        const into = a.member.identityId
        const moved = a.member.identityId === b.member.identityId ? [] : ctx.handle.identities.members(b.member.identityId)
        if (moved.length > 0) ctx.handle.identities.moveAll(b.member.identityId, into)
        // The two named records are now a person's decision: not held, `approved`.
        for (const m of [a.member, b.member]) {
          ctx.handle.identities.putMember({ ...m, identityId: into, held: false, how: 'approved', joinedAt: at, joinedBy: member.userId })
        }
        const touched = new Set([a.member.recordId, b.member.recordId, ...moved.map(m => m.recordId)])
        for (const recordId of touched) {
          ctx.handle.identities.appendHistory({ identityId: into, recordId, action: 'approved', how: 'approved', proposalId: p.id, actorKind: 'human', actorId: member.userId, at })
        }
        return true
      })
      if (!done) return refuse('conflict', 'この提案はもう判断されています', { code: 'IDENTITY_PROPOSAL_DECIDED' })
      const decided = ctx.handle.identities.proposal(p.id)!
      return ok({ proposal: proposalView(decided), identity: decision === 'approve' ? view(ctx, a.member.identityId) : null })
    },

    /**
     * POST …/identities/records/:recordId/split — take the record out into an
     * identity of its own (undoing a wrong match). Always a new identity, even
     * when it seemed alone (the caller may not see every member). Held: automatic
     * matching never puts it back; only an approved proposal does.
     */
    split(member: Member, recordId: string): Outcome<IdentityView> {
      const c = context(member)
      if (!c.ok) return c
      const ctx = c.value
      const found = readableMember(ctx, recordId)
      if (!found) return notFound()
      const at = deps.clock.now()
      const identityId = deps.ids.newId()
      deps.transactions.run(() => {
        ctx.handle.identities.createIdentity(identityId, found.member.kind, at)
        ctx.handle.identities.putMember({ ...found.member, identityId, held: true, how: 'split', joinedAt: at, joinedBy: member.userId })
        ctx.handle.identities.appendHistory({ identityId, recordId: found.row.id, action: 'split', how: 'split', proposalId: null, actorKind: 'human', actorId: member.userId, at })
      })
      return ok(view(ctx, identityId))
    },

    /**
     * Who a mail address is (for the inbox, B2): the 相手 records of the same
     * person (by address) and of the same company (by the address's domain,
     * never a free-mail one), each with its whole identity — readable ones only.
     */
    resolveAddress(member: Member, address: string): Outcome<{ person: string[]; company: string[] }> {
      const c = context(member)
      if (!c.ok) return c
      const ctx = c.value
      const email = normalizeEmail(address)
      if (!email) return ok({ person: [], company: [] })
      const domain = companyDomainOfAddress(email)
      const ids = ctx.handle.identities
      const gather = (rows: IdentityMemberRow[]) => {
        const identities = [...new Set(rows.map(r => r.identityId))]
        const all = identities.flatMap(i => ids.members(i).map(m => m.recordId))
        const live = readable(ctx, all)
        return all.filter(id => live.has(id) && ctx.counterparts.has(live.get(id)!.type))
      }
      const byEmail = ids.withKeys(email, null).filter(m => m.email === email)
      const byDomain = domain ? ids.withKeys(null, domain).filter(m => m.kind === 'company' && m.domain === domain) : []
      return ok({
        person: gather(byEmail.filter(m => m.kind !== 'company')),
        company: [...new Set([...gather(byEmail.filter(m => m.kind === 'company')), ...gather(byDomain)])],
      })
    },
  }
}

export type IdentityService = ReturnType<typeof createIdentityService>
