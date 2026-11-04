/** 「部署に出す」: an owner-only record shared to a folder (records.md "Owner-only records"). */
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { bad, conflict } from './refusals'
import type { ActorInput } from './types'
import { NOTE_MAX, provenance } from './values'

/** The ledger action of sharing an owner-only record to a folder. */
export const SHARE_ACTION = 'share'

export function sharing(ctx: EngineContext) {
  const { transactions, clock, open, placeFolder, stateOf, summaryOf, changed } = ctx
  return {
    /**
     * 「部署に出す／案件につなぐ」 (records.md "Owner-only records"): an owner-only
     * record becomes visible to the readers of `folder` (a department folder
     * the owner reads, never a private one). Only its owner — nobody else can
     * even find it — and only the person, with their session (the route has no
     * AI twin). A ledger entry `share` with `place.personal_owner` /
     * `place.folder` before / after; never undone.
     */
    share(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      // Readable and owner-only means it is the member's own (the reader shows it to nobody else).
      if (row.personalOwner !== member.userId) return conflict('この記録はもうほかの人にも見えています', 'NOT_PERSONAL')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)
      if (b.folder === undefined || b.folder === null) return bad('folder: the department folder whose readers will see it', 'FOLDER_REQUIRED')
      const folder = placeFolder(member, row.type, b.folder, reader)
      if (typeof folder !== 'string') return folder
      const current = stateOf(records, row, def)
      const expected = b.expectedVersion as number
      if (expected !== current.version) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: current.version })
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: SHARE_ACTION, fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [
          { field: 'place.personal_owner', before: member.userId, after: null },
          { field: 'place.folder', before: row.folder, after: folder },
        ],
        attachments: [], decision: null, isDecision: false, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
      }
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) return false
        records.setPlace(row.id, { folder, personalOwner: null }, at)
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT')
      changed(member.companyId, row.id)
      return ok({ record: summaryOf(records, row.id), entry })
    },
  }
}
