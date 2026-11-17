/**
 * After a restore (`.claude/rules/deployment.md` "After a restore: automatic work stays stopped"): a
 * database put back from a backup or an archive no longer remembers what was done outside after that copy
 * was taken — a scheduled job's occurrence, an AI run's operation key, a Drive put's receipt. The UNIQUE
 * keys only protect rows that exist, so the same slot or operation could be made and sent outside again.
 * Nothing automatic may run until a person has looked at the outside results:
 *
 * 1. 「定期の仕事をすべて止める」 (`ai_job_settings.stopped`) with every waiting or running occurrence
 *    held (`COMPANY_STOPPED`, jobs.md "Held") — lifting it later holds the slot that passed meanwhile, so
 *    nothing from before is made again;
 * 2. the company-wide emergency stop of the whole AI (agent-stop.md): the server refuses every AI run's
 *    claim and token, and every relay call, until an owner / admin releases it;
 * 3. a notice to every owner / admin (`company_restored`) saying what to check before resuming.
 *
 * All in one transaction. A person's own send (mail) is not stopped: a person decides it. Running it again
 * adds no second stop (an existing company-wide stop is kept as is) and tells again.
 */
import type { NotificationRow } from '../ports/notifications'
import type { AgentStopRepository } from '../ports/agent-stops'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess } from './access'

/** Who stopped it (the jobs setting's `updated_by`, the stop's `stopped_by`): not a person. */
export const RESTORE_ACTOR = 'acb:restore'

/** The emergency stop's reason (shown on the admin console's stop page; ≤ 500 characters). */
export const RESTORE_STOP_REASON = 'バックアップから戻したため、自動で止めました。戻す前にもう済んでいた仕事（送ったメール・Google Drive に置いたファイル・HubSpot への書き込みなど）を確かめてから、止めるのをやめてください。'

export interface RestorePauseDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  memberships: Pick<MembershipRepository, 'listByCompany'>
  agentStops: Pick<AgentStopRepository, 'active' | 'insert'>
  /** jobs.md "Held": every `due` / `running` occurrence of the company → `held` `COMPANY_STOPPED` (in the caller's transaction). */
  holdDue: (companyId: string) => void
  /** Push signals after the change (never fail it): owners' notices, every member's AI policy. */
  noticesChanged?: (companyId: string, userIds: string[]) => void
  stopsChanged?: (companyId: string) => void
}

export interface RestorePauseResult {
  /** A company-wide stop of the whole AI was added now (false: one was already in force). */
  aiStopAdded: boolean
  /** Owners / admins told. */
  told: number
}

export function createRestorePause(deps: RestorePauseDeps) {
  return {
    /** Stop the company's automatic work after its data was restored, and tell its owners / admins. */
    pauseAfterRestore(companyId: string): RestorePauseResult {
      const handle = deps.companyData.forCompany(companyId)
      const at = deps.clock.now()
      const admins = deps.memberships.listByCompany(companyId).filter(m => hasFullAccess(m.role)).map(m => m.user_id)
      const result = deps.transactions.run((): RestorePauseResult => {
        handle.jobs.setStopped(true, RESTORE_ACTOR, at)
        deps.holdDue(companyId)
        const stopped = deps.agentStops.active(companyId).some(s => s.userId === null && s.tool === null)
        if (!stopped) {
          deps.agentStops.insert(companyId, {
            id: deps.ids.newId(), userId: null, tool: null, reason: RESTORE_STOP_REASON,
            stoppedAt: at, stoppedBy: RESTORE_ACTOR, releasedAt: null, releasedBy: null,
          })
        }
        const rows: NotificationRow[] = admins.map(userId => ({
          id: deps.ids.newId(), userId, kind: 'company_restored', recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
          dedupeKey: `company_restored:${at}`, createdAt: at, readAt: null,
        }))
        handle.notifications.insert(rows)
        return { aiStopAdded: !stopped, told: admins.length }
      })
      try { deps.stopsChanged?.(companyId) } catch { /* the apps' own policy check catches up */ }
      try { deps.noticesChanged?.(companyId, admins) } catch { /* their own check catches up */ }
      return result
    },
  }
}

export type RestorePause = ReturnType<typeof createRestorePause>
