/**
 * Erasing content (中身の箱, `.claude/rules/records.md` "The content store"):
 * the operator's procedure and the retention run. Owner decision 2026-11-01:
 * no delete in the product — no route, screen or AI reaches this; the
 * operator runs src/cli/erase-content.ts and keeps its output (the erased
 * ids) in the erasure log outside the product, and the future server clock
 * calls `eraseExpired`.
 *
 * Erasing a record's content also clears the text of its fixed content
 * (an approval's payload, a mail's body: `fixed_payloads`, approvals.md /
 * outbound-mail.md), which already keeps only its hash once cleared.
 */
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordContentEraser, RecordContentInfo } from '../ports/record-contents'
import type { Transactions } from '../ports/transactions'

export interface RecordContentErasureDeps {
  eraser: RecordContentEraser
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  companyIds: () => string[]
}

/** The reason stored with an erasure: a short word, never personal data (the erasure log outside holds the request). */
export const ERASE_REASON_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/

export function createRecordContentErasure(deps: RecordContentErasureDeps) {
  return {
    list(companyId: string, recordId: string): RecordContentInfo[] {
      return deps.eraser.list(companyId, recordId)
    },

    /** Every content of one record, and its fixed content's text. */
    eraseRecord(companyId: string, recordId: string, reason: string): { erased: string[]; fixedPayloadsCleared: number } {
      if (!ERASE_REASON_RE.test(reason)) throw new Error('reason: a short word (a-z, 0-9, _ . : -)')
      const at = deps.clock.now()
      const handle = deps.companyData.forCompany(companyId)
      return deps.transactions.run(() => {
        const erased = deps.eraser.eraseRecord(companyId, recordId, reason, at)
        let fixedPayloadsCleared = handle.fixedPayloads.clearBodies('approval', [recordId], at)
        const mail = handle.fixedPayloads.clearBodies('outbound_message', [recordId], at)
        if (mail > 0) handle.outbound.markBodyDeleted(recordId, at)
        fixedPayloadsCleared += mail
        return { erased, fixedPayloadsCleared }
      })
    },

    /** These contents only (e.g. re-applying an erasure log after a restore). */
    eraseContents(companyId: string, ids: string[], reason: string): { erased: string[] } {
      if (!ERASE_REASON_RE.test(reason)) throw new Error('reason: a short word (a-z, 0-9, _ . : -)')
      return { erased: deps.eraser.eraseContents(companyId, ids, reason, deps.clock.now()) }
    },

    /** Contents whose retention ended (incoming summaries after 3 years), every company. */
    eraseExpired(): { erased: Array<{ companyId: string; id: string }> } {
      const now = deps.clock.now()
      const erased: Array<{ companyId: string; id: string }> = []
      for (const companyId of deps.companyIds()) {
        for (const id of deps.eraser.eraseExpired(companyId, now)) erased.push({ companyId, id })
      }
      return { erased }
    },
  }
}

export type RecordContentErasure = ReturnType<typeof createRecordContentErasure>
