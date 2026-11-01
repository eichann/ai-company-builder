import type { LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import type { Clock, IdGenerator } from '../../ports/clock'
import type { CompanyDataSource } from '../../ports/company-data'
import type { RecordFileWriter } from '../../ports/record-files'
import type { Transactions } from '../../ports/transactions'
import type { AcceptanceQuestion } from '../task-acceptance'

/** Who holds a business role on a record (plan C3; services/plugin-roles.ts implements it). */
export interface RoleHolders {
  holdsOnRecord(companyId: string, type: string, recordId: string, role: string, userId: string): boolean
}

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
  /**
   * The absent members this member covers today (代わりの人, services/absences.ts,
   * the one resolution point): `who` may then also be met as one of them. None without it.
   */
  actsFor?: (companyId: string, userId: string) => string[]
  /**
   * Acceptance (引き受け, records.md "Acceptance"; services/task-acceptance.ts): is a request
   * someone else was asked to do accepted by itself (the company's setting)? Without it every
   * request is accepted at once (as before version 7 of the task type).
   */
  autoAccepts?: (companyId: string, q: AcceptanceQuestion) => boolean
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
  /** For the AI: the execution run its token is bound to (S10b; from the token, never the body). */
  runId?: string | null
}
