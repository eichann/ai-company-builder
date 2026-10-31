/** A push the pre-receive hook rejected (parsed by lib/push-rejections.ts), one row per marker section. */
export interface PushRejectionRow {
  id: string
  userId: string
  marker: string
  paths: string[]
  createdAt: string
}

export interface PushRejectionQuery {
  userId?: string
  marker?: string
  limit?: number
  offset?: number
}

export interface PushRejectionRepository {
  /** Newest first, optionally filtered by member and/or marker; `total` counts every match. */
  query(companyId: string, q?: PushRejectionQuery): { rows: PushRejectionRow[]; total: number }
  /** The newest `limit` rejections. */
  recent(companyId: string, limit: number): PushRejectionRow[]
  /** Every marker the company has rows for, sorted. */
  markers(companyId: string): string[]
  /** One row per section of one rejected push, in one transaction. */
  record(companyId: string, userId: string, rejections: Array<{ marker: string; paths: string[] }>): void
}
