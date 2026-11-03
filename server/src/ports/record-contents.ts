/**
 * Erasing content of the content store (中身の箱, `.claude/rules/records.md`
 * "The content store"). Only the operator's command (src/cli/erase-content.ts)
 * and the retention service (services/record-contents.ts) are given this —
 * never a route (owner decision 2026-11-01: no delete backdoor in the
 * product). Every method is limited to the company it is given. Erasing
 * clears the text; the row, its hash and every reference to it stay, and
 * reading reads 「消去済み」 with the date.
 */
import type { RetentionClass } from '../../shared/core/record-contents'

/** A content row without its text (what the operator sees before erasing). */
export interface RecordContentInfo {
  id: string
  recordId: string
  hash: string
  retention: RetentionClass
  createdAt: string
  expiresAt: string | null
  erasedAt: string | null
  erasedReason: string | null
}

export interface RecordContentEraser {
  list(companyId: string, recordId: string): RecordContentInfo[]
  /** Erase every content of a record; the ids erased now (already erased ones are left as they are). */
  eraseRecord(companyId: string, recordId: string, reason: string, at: string): string[]
  /** Erase these contents (ids of this company only). */
  eraseContents(companyId: string, ids: string[], reason: string, at: string): string[]
  /** Erase the contents whose retention ended at or before `now` (reason `retention`). */
  eraseExpired(companyId: string, now: string): string[]
}
