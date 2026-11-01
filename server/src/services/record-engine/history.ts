/** Reading a record's ledger and its server values at a version (§13.11). */
import { replayRecordState, type LedgerEntry, type ReplayedState, type VersionOrigin } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'

export function ledgerReading(ctx: EngineContext) {
  const { open } = ctx
  return {
    history(member: Member, recordId: string): Outcome<{ entries: LedgerEntry[] }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const row = RECORD_ID_RE.test(recordId) ? opened.records.byIds([recordId]).find(r => opened.reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      return ok({ entries: opened.records.ledger(row.id) })
    },

    /** The record's server values as they were at `version` (§13.11). */
    atVersion(member: Member, recordId: string, version: string): Outcome<ReplayedState & { origin: VersionOrigin }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const row = RECORD_ID_RE.test(recordId) ? opened.records.byIds([recordId]).find(r => opened.reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const n = /^\d{1,10}$/.test(version) ? Number(version) : NaN
      const ledger = opened.records.ledger(row.id)
      const latest = ledger.length > 0 ? ledger[ledger.length - 1].version : 0
      if (!Number.isInteger(n) || n < 1 || n > latest) return refuse('not-found', 'その版はありません', { code: 'VERSION_NOT_FOUND' })
      const entry = ledger.find(e => e.version === n) as LedgerEntry
      const origin: VersionOrigin = {
        action: entry.action, actorId: entry.actorId, actorKind: entry.actorKind, at: entry.at,
        proposedBy: entry.proposedBy, conversationId: entry.conversationId,
      }
      return ok({ ...replayRecordState(ledger, n), origin })
    },
  }
}
