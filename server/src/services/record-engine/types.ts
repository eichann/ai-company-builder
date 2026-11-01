import type { LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import type { Clock, IdGenerator } from '../../ports/clock'
import type { CompanyDataSource } from '../../ports/company-data'
import type { RecordFileWriter } from '../../ports/record-files'
import type { Transactions } from '../../ports/transactions'

export interface RecordEngineDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  files: RecordFileWriter
  /** Department folders the member manages (`dept_manager` in `who`). */
  managedFolders: (companyId: string, userId: string) => string[]
  isMember: (companyId: string, userId: string) => boolean
  /** The member's role in the company, or null (an assignee must be able to read the record). */
  roleOf: (companyId: string, userId: string) => string | null
  /**
   * Tell these members their 「あなたの番」 may have changed (push channel; kind + version only).
   * `change` says which ledger entry it was, for the notices (services/notifications.ts), which
   * keep only kind, record, version and actor — never a value — and push nothing but a version.
   */
  notify: (companyId: string, userIds: string[], change?: RecordChange) => void
}

/** The entry a notify is about (the record's type and its server fields after the entry). */
export interface RecordChange {
  type: string
  entry: LedgerEntry
  fields: Record<string, LedgerValue>
}

/**
 * Who is acting, decided by the route from the credential (records.md "Who
 * is acting"): the member's session → human; a record token → their AI. A
 * body field saying otherwise is ignored.
 */
export interface ActorInput {
  kind: 'human' | 'ai'
  /** For an AI: which one (the agent the token was issued for). */
  source?: string
  /**
   * Provenance, recorded in the ledger and NEVER used to authorize anything:
   * for a person, what their app reports (it can say anything); for the AI,
   * the conversation of its token. `proposedBy: 'ai'` only for a person.
   */
  conversationId?: string | null
  proposedBy?: 'ai' | null
}
