/**
 * Which company Skill a consultation used (`.claude/rules/records.md` "Which
 * Skill", shared/core/skill-uses.ts). The member's app reports, with the
 * member's session, each Skill the AI loaded in one of the member's
 * consultations: its folder name, the git tree id of the folder at the
 * member's HEAD and whether it had local changes. Never a path or content.
 *
 * Informational, like a ledger entry's conversationId: the app can report
 * anything for the member's own consultations, so nothing authorizes on it.
 * It is copied onto what the AI then writes in that consultation (ledger
 * entries, Google Drive put receipts) by those adapters, at write time.
 */
import { readSkillUseReport, SKILL_USES_PER_CONSULTATION } from '../../shared/core/skill-uses'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export interface SkillUseDeps {
  companyData: CompanyDataSource
  clock: Clock
}

export function createSkillUseService(deps: SkillUseDeps) {
  return {
    /**
     * POST …/me/skill-uses { conversationId, name, tree, dirty } — the member's own
     * consultation. The first report of a (name, tree, dirty) keeps the server's time as
     * its first use; a repeat changes nothing. Past SKILL_USES_PER_CONSULTATION distinct
     * ones the consultation records no more (`recorded: false`).
     */
    report(member: Member, body: unknown): Outcome<{ recorded: boolean }> {
      const report = readSkillUseReport(body)
      if (typeof report === 'string') return refuse('bad-request', report)
      const result = deps.companyData.forCompany(member.companyId).skillUses
        .record(member.userId, report.conversationId, report, deps.clock.now(), SKILL_USES_PER_CONSULTATION)
      return ok({ recorded: result !== 'full' })
    },
  }
}
