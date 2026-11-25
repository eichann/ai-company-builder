/**
 * One company's 「ブラウザ操作」 recordings (agent-browser.md "Recording") — from its handle (`CompanyData`), every method
 * limited to that company. Rows past their `deleteAt` are never returned (`now` given by the service). Rules:
 * services/browser-recordings.ts.
 */
export interface BrowserRecordingRow {
  id: string
  userId: string
  domain: string
  lines: number
  /** The stored JSON (checked before it was stored). */
  content: string
  createdAt: string
  deleteAt: string
}

export type BrowserRecordingHead = Omit<BrowserRecordingRow, 'content'>

export interface BrowserRecordingRepository {
  insert(row: BrowserRecordingRow): void
  /** The row, unless it is past its `deleteAt` at `now`. */
  byId(id: string, now: string): BrowserRecordingRow | null
  /** Newest first, at most `limit`, not past `deleteAt` at `now`; only this sender's (sent at or after `since`) when `userId` is given. */
  list(now: string, limit: number, only?: { userId: string; since: string }): BrowserRecordingHead[]
  /** True when the row was there (and is gone now, content included). */
  delete(id: string): boolean
  /** Every row whose `deleteAt` is at or before `now` is deleted; how many. */
  deleteExpired(now: string): number
}
