/** Reading a record's ledger and its server values at a version (§13.11). */
import { ledgerCause, replayRecordState, type LedgerCause, type LedgerEntry, type ReplayedState, type VersionOrigin } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { personalPathsSeen, scrubLedger, scrubLinkValue } from './personal-links'

export function ledgerReading(ctx: EngineContext) {
  const { open } = ctx
  return {
    history(member: Member, recordId: string): Outcome<{ entries: Array<LedgerEntry & { cause: LedgerCause }> }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const row = RECORD_ID_RE.test(recordId) ? opened.records.byIds([recordId]).find(r => opened.reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      // Who caused each change: a person, their AI in a consultation, an automated run, the server, outside (records.md).
      const ledger = opened.records.ledger(row.id)
      // Another member's `.personal/` links are not there for this one (records.md "Links into .personal/").
      const seen = personalPathsSeen(member.userId, row, ledger, opened.records.linksFrom([row.id]))
      return ok({ entries: scrubLedger(ledger, seen).map(e => ({ ...e, runId: e.runId ?? null, cause: ledgerCause(e) })) })
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
      const replayed = replayRecordState(ledger, n)
      const seen = personalPathsSeen(member.userId, row, ledger, opened.records.linksFrom([row.id]))
      const fields = Object.fromEntries(Object.entries(replayed.fields).map(([k, v]) => [k, k.startsWith('links.') ? scrubLinkValue(v, seen) : v]))
      return ok({ ...replayed, fields, origin })
    },
  }
}
