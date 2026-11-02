/**
 * 「もう一方の AI に聞く」 as a company setting (owner decision 2026-11-02; chat-and-agents.md
 * "Asking the other AI"): whether a consultation may ask the other AI vendor at all.
 *
 * - Not allowed unless set: a company created after the setting existed has no row. The
 *   companies that existed when it shipped got `allowed` once (db/schema/agents.ts
 *   `migrateSecondOpinionSetting`).
 * - Owners and admins read and change it (like the other AI settings); every member's app
 *   receives it in its policy (`/me/agent-policy`, services/agent-policy.ts) and enforces it:
 *   the other AI runs on the member's computer, so the server only keeps and hands it out.
 */
import type { SecondOpinionView } from '../../shared/types/second-opinion'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import { requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const SECOND_OPINION_FORBIDDEN = 'Only owners and admins can change whether the other AI may be asked'
export const SECOND_OPINION_BAD_BODY = 'Expected { allowed: boolean }'

export interface SecondOpinionSettingDeps {
  companyData: CompanyDataSource
  accounts: AccountDirectory
  clock: Clock
}

export function createSecondOpinionSettingService(deps: SecondOpinionSettingDeps) {
  const { companyData, accounts, clock } = deps

  function view(companyId: string): SecondOpinionView {
    const stored = companyData.forCompany(companyId).secondOpinion.get()
    if (!stored) return { allowed: false, updatedAt: null, updatedByName: null }
    // The migration's rows (updatedBy null) count as the starting value of that company.
    if (!stored.updatedBy) return { allowed: stored.allowed, updatedAt: null, updatedByName: null }
    const name = accounts.byIds([stored.updatedBy]).get(stored.updatedBy)?.name ?? null
    return { allowed: stored.allowed, updatedAt: stored.updatedAt, updatedByName: name }
  }

  return {
    /** Whether this company's apps may offer the tool (the policy's `secondOpinion.allowed`). */
    allowedFor(companyId: string): boolean {
      return companyData.forCompany(companyId).secondOpinion.get()?.allowed === true
    },

    /** GET …/second-opinion (owner/admin). */
    get(member: Member): Outcome<SecondOpinionView> {
      const role = requireFullAccess(member, SECOND_OPINION_FORBIDDEN)
      if (!role.ok) return role
      return ok(view(member.companyId))
    },

    /** PUT …/second-opinion (owner/admin): `{ allowed }`. `changed` = the apps must be told. */
    update(member: Member, body: unknown): Outcome<{ view: SecondOpinionView; changed: boolean }> {
      const role = requireFullAccess(member, SECOND_OPINION_FORBIDDEN)
      if (!role.ok) return role
      const value = (body as { allowed?: unknown } | null)?.allowed
      if (typeof value !== 'boolean') return refuse('bad-request', SECOND_OPINION_BAD_BODY)
      const repo = companyData.forCompany(member.companyId).secondOpinion
      const changed = (repo.get()?.allowed === true) !== value
      if (changed) repo.save({ allowed: value, updatedAt: clock.now(), updatedBy: member.userId })
      return ok({ view: view(member.companyId), changed })
    },
  }
}

export type SecondOpinionSettingService = ReturnType<typeof createSecondOpinionSettingService>
