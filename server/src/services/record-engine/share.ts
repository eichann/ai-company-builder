/**
 * 「部署に出す」: an owner-only or members-only record shared to a folder (records.md "Owner-only
 * records", "Members-only records"); 「招待する」: members added to a members-only record.
 */
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { membersList } from './members'
import { bad, conflict } from './refusals'
import type { ActorInput } from './types'
import { NOTE_MAX, provenance } from './values'

/** The ledger action of sharing an owner-only or members-only record to a folder. */
export const SHARE_ACTION = 'share'
/** The ledger action of adding members to a members-only record. */
export const INVITE_ACTION = 'invite'

const STALE = 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください'
/** A list as the ledger keeps it: ids, comma-separated, in list order. */
const listValue = (ids: readonly string[]) => ids.join(',') || null

export function sharing(ctx: EngineContext) {
  const { deps, transactions, clock, open, placeFolder, stateOf, summaryOf, changed } = ctx

  /** The record as the member reads it (else the answer for a record that does not exist). */
  function readable(member: Member, recordId: string) {
    const opened = open(member)
    if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
    const { records, reader } = opened
    const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
    if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
    return { ok: true as const, records, reader, row }
  }

  /** The body's object, `expectedVersion` and `note`, or the refusal. */
  function bodyOf(body: unknown): { b: Record<string, unknown>; expected: number; note: string } | Outcome<never> {
    const b = body as Record<string, unknown> | null
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
    if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
    const note = b.note === undefined ? '' : b.note
    if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)
    return { b, expected: b.expectedVersion as number, note }
  }

  return {
    /**
     * 「部署に出す／案件につなぐ」 (records.md "Owner-only records", "Members-only records"): an
     * owner-only or members-only record becomes visible to the readers of `folder` (a department
     * folder the member reads, never a private one). Only its owner / a listed member — nobody
     * else can even find it — and only the person, with their session (the route has no AI
     * twin). A ledger entry `share` with `place.personal_owner` (or `place.members`) /
     * `place.folder` before / after; never undone.
     */
    share(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry }> {
      const found = readable(member, recordId)
      if (!found.ok) return found
      const { records, reader, row } = found
      // Readable and owner-only means it is the member's own (the reader shows it to nobody else);
      // readable and members-only means the member is on its list.
      if (row.personalOwner !== member.userId && row.members === null) return conflict('この記録はもうほかの人にも見えています', 'NOT_PERSONAL')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const parsed = bodyOf(body)
      if (!('b' in parsed)) return parsed
      const { b, expected, note } = parsed
      if (b.folder === undefined || b.folder === null) return bad('folder: the department folder whose readers will see it', 'FOLDER_REQUIRED')
      const folder = placeFolder(member, row.type, b.folder, reader)
      if (typeof folder !== 'string') return folder
      const current = stateOf(records, row, def)
      if (expected !== current.version) return conflict(STALE, 'VERSION_CONFLICT', { version: current.version })
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: SHARE_ACTION, fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [
          row.members !== null
            ? { field: 'place.members', before: listValue(row.members), after: null }
            : { field: 'place.personal_owner', before: member.userId, after: null },
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
      if (!written) return conflict(STALE, 'VERSION_CONFLICT')
      changed(member.companyId, row.id)
      return ok({ record: summaryOf(records, row.id), entry })
    },

    /**
     * 「招待する」 (records.md "Members-only records"): a member on a members-only record's list
     * adds members to it. Only someone listed (nobody else can find it) and only the person, with
     * their session (no AI route). A ledger entry `invite` with `place.members` before / after;
     * never undone (the added may have seen it). The added hear of it through the `records` signal.
     */
    invite(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry; added: string[] }> {
      const found = readable(member, recordId)
      if (!found.ok) return found
      const { records, row } = found
      if (row.members === null) return conflict('この記録は見る人を選んだ記録ではありません', 'NOT_MEMBERS_ONLY')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const parsed = bodyOf(body)
      if (!('b' in parsed)) return parsed
      const { b, expected, note } = parsed
      const list = membersList(b.add, id => deps.isMember(member.companyId, id))
      if (!Array.isArray(list)) return bad(list.error.replace('members', 'add'), list.code)
      if (list.length === 0) return bad('add: at least one member')
      const current = stateOf(records, row, def)
      if (expected !== current.version) return conflict(STALE, 'VERSION_CONFLICT', { version: current.version })
      const after = [...new Set([...row.members, ...list])]
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: INVITE_ACTION, fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [{ field: 'place.members', before: listValue(row.members), after: listValue(after) }],
        attachments: [], decision: null, isDecision: false, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
      }
      let added: string[] = []
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) return false
        added = records.addMembers(row.id, list, member.userId, at)
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict(STALE, 'VERSION_CONFLICT')
      changed(member.companyId, row.id)
      return ok({ record: summaryOf(records, row.id), entry, added })
    },
  }
}
