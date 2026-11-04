/**
 * The `records` push signal for one changed record (`.claude/rules/notifications.md`
 * "The push signal", records.md): every member who can read that record now is
 * told that something changed — not only the people named on it — so a reader's
 * list and open card follow at once (owner 2026-11-04: 「名前の載っていない、見られる
 * だけの人にも」).
 *
 * - Who reads it is exactly `recordReader` (services/record-access.ts): an
 *   owner-only record reaches its owner alone, a private folder's record only
 *   that folder's readers, another company nobody (the channel is per company).
 * - What is sent is `{ kind: 'records', version }` with a fresh version: no
 *   record id, no content. The app only asks the server again.
 * - Cost: only members with an open connection are evaluated (one
 *   `recordReader` each, once per change); the memberships are one query.
 */
import type { CompanyDataSource } from '../ports/company-data'
import type { IdGenerator } from '../ports/clock'
import type { MembershipRepository } from '../ports/memberships'
import type { PushChannel } from './push-channel'
import { recordReaders } from './record-access'

export interface RecordSignalDeps {
  companyData: CompanyDataSource
  memberships: Pick<MembershipRepository, 'listByCompany'>
  push: Pick<PushChannel, 'listeners' | 'notify'>
  ids: Pick<IdGenerator, 'newToken'>
}

export function createRecordSignal(deps: RecordSignalDeps) {
  /** Tell every connected member who reads this record now that it changed. */
  return function recordChanged(companyId: string, recordId: string): void {
    const listening = new Set(deps.push.listeners(companyId))
    if (listening.size === 0) return
    const handle = deps.companyData.forCompany(companyId)
    const row = handle.records.byIds([recordId])[0]
    if (!row) return
    const members = deps.memberships.listByCompany(companyId)
      .filter(m => listening.has(m.user_id))
      .map(m => ({ userId: m.user_id, role: m.role }))
    const to = recordReaders(companyId, row, members, handle.scopes.listWithRules())
    if (to.length > 0) deps.push.notify(companyId, to, { kind: 'records', version: deps.ids.newToken().slice(0, 32) })
  }
}

export type RecordSignal = ReturnType<typeof createRecordSignal>
