/**
 * 出どころの枠 (owner design 2026-11-06 §10; `shared/core/source-slots.ts` holds the pure part):
 * the one place that says what a piece of shared work came from and what earlier work on the
 * same source a person may be told about. Outbound mail (one send per source) and approvals (one
 * pending create per source) use it; the meeting outputs' slot will too.
 *
 * Never reveal what cannot be seen (owner decision B, design §9 rule 4): earlier work counts only
 * when the person reads the source record **and** the earlier work's own record, through the one
 * reader (`recordReader`). Anything else is as if it did not exist — not mentioned, not counted,
 * never a reason to stop them.
 */
import { CLOCK_ACTOR, WAIT_OVER, WAIT_OVER_ACTION } from '../../shared/core/core-types'
import { followUpSourceId, resolveSource, sourceRecordId, type Source } from '../../shared/core/source-slots'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import { recordReader } from './record-access'

/** Earlier work on a source: its own record (what the reader checks), who did it and when. */
export interface SourceClaim {
  recordId: string
  by: string
  at: string
}

export interface SourceSlotsDeps {
  companyData: CompanyDataSource
}

export function createSourceSlots(deps: SourceSlotsDeps) {
  const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

  /**
   * The follow-up round of the first of `recordIds` that is being followed up: a record of a type
   * with a clock (`WAIT_OVER`) whose newest clock `wait_over` is newer than its last move into the
   * waiting state. Null when none is.
   */
  function followUpOf(companyId: string, recordIds: readonly string[]): string | null {
    const records = deps.companyData.forCompany(companyId).records
    for (const row of records.byIds([...new Set(recordIds)])) {
      const rule = own(WAIT_OVER, row.type)
      if (!rule || row.removedAt !== null) continue
      const ledger = records.ledger(row.id)
      let over = -1, wait = -1
      ledger.forEach((e, i) => {
        if (e.action === WAIT_OVER_ACTION && e.actorId === CLOCK_ACTOR.id) over = i
        if (e.toState === rule.from && e.fromState !== rule.from) wait = i
      })
      if (over >= 0 && over > wait) return followUpSourceId(row.id, ledger[over].version)
    }
    return null
  }

  return {
    followUpOf,

    /**
     * The source of a record by its own links (`meeting`, `interaction`; a `bundle` link is not a
     * source) and, for a follow-up, the waiting records it was made for: its `task` link and
     * whatever links it as `prepared` (a 返事のお願い's nudge). `extra` names links a caller keeps elsewhere.
     */
    sourceOfRecord(companyId: string, recordId: string, extra: { meeting?: string | null } = {}): Source | null {
      const records = deps.companyData.forCompany(companyId).records
      const links = records.linksFrom([recordId])
      const first = (name: string) => links.find(l => l.name === name && l.targetId)?.targetId ?? null
      const waiting = [
        ...links.filter(l => l.name === 'task' && l.targetId).map(l => l.targetId as string),
        ...records.linksTo([recordId]).filter(l => l.name === 'prepared').map(l => l.sourceId),
      ]
      return resolveSource({
        followUp: waiting.length > 0 ? followUpOf(companyId, waiting) : null,
        meeting: extra.meeting ?? first('meeting'),
        interaction: first('interaction'),
      })

    },

    /** Whether the member reads the source's own record. */
    readsSource(member: Member, source: Source): boolean {
      const handle = deps.companyData.forCompany(member.companyId)
      const row = handle.records.byIds([sourceRecordId(source)])[0]
      return !!row && row.removedAt === null && recordReader(member, handle.scopes.listWithRules()).record(row)
    },

    /**
     * The earlier work on `source` the member may be told about, oldest first: only when they read
     * the source, and only claims whose record they read. Synchronous, so a caller can check and
     * write in one stretch (no other request runs in between).
     */
    heldBy<C extends SourceClaim>(member: Member, source: Source, claims: readonly C[]): C[] {
      if (claims.length === 0) return []
      const handle = deps.companyData.forCompany(member.companyId)
      const reader = recordReader(member, handle.scopes.listWithRules())
      const sourceRow = handle.records.byIds([sourceRecordId(source)])[0]
      if (!sourceRow || sourceRow.removedAt !== null || !reader.record(sourceRow)) return []
      const rows = new Map(handle.records.byIds(claims.map(c => c.recordId)).map(r => [r.id, r]))
      return claims
        .filter(c => { const r = rows.get(c.recordId); return !!r && r.removedAt === null && reader.record(r) })
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    },
  }
}

export type SourceSlots = ReturnType<typeof createSourceSlots>
