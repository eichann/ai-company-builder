/**
 * Wire shape of 見られる人 (who can see a record or a file; the phrase is
 * shared/core/viewers.ts).
 *
 *   POST /api/companies/:id/viewers { records?: string[], files?: string[] }   (any member)
 *     → ViewersAnswer. At most 200 of each (400 beyond). A record the caller
 *       cannot read is left out of `records`; a file path is answered from the
 *       folders the caller can see (an unreadable private folder is as if it did
 *       not exist).
 *     With `linked: { record: string, paths: string[] }` (≤ 200 paths) it also
 *       answers `cannotOpen`: for that record, if the caller reads it, per path
 *       the caller reads, how many members read the record but cannot open the
 *       path (counts > 0 only; never names). 「〇人はこのファイルを開けません」.
 */
import type { ViewersKind, ViewersLabel } from '../core/viewers'

export type { ViewersKind, ViewersLabel }

export interface ViewersAnswer {
  /** Record id → its phrase (only records the caller reads). */
  records: Record<string, ViewersLabel>
  /** Company path (as sent) → its phrase. */
  files: Record<string, ViewersLabel>
  /** With `linked`: company path (as sent) → how many who see the record cannot open it (> 0 only). */
  cannotOpen?: Record<string, number>
}
