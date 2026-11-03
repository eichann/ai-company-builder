/**
 * One company's execution runs of 「AI の番」 and their outside operations
 * (stage 2 S10b, records.md "Execution runs"), from its handle (`CompanyData`,
 * ports/company-data.ts). Every method is limited to that company: another
 * company's run id finds and changes nothing. Rules: services/ai-runs.ts;
 * states and classes: shared/core/ai-runs.ts.
 */
import type { AiRunFailureClass, AiRunOperationState, AiRunState } from '../../shared/core/ai-runs'

export interface AiRunRow {
  id: string
  recordId: string
  step: string
  /** The member under whose authority the AI runs. */
  userId: string
  state: AiRunState
  generation: number
  /** The app instance holding the claim (null when nobody holds it). */
  deviceId: string | null
  conversationId: string | null
  claimExpiresAt: string | null
  failureClass: AiRunFailureClass | null
  failureCode: string | null
  retryAt: string | null
  /** Temporary failures in a row. */
  attempts: number
  pluginVersion: string | null
  stepsVersion: string | null
  /** JSON of AiRunProcedure as of the latest claim (records.md "Which procedure"); null on runs claimed before. */
  procedure: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type { AiRunOperationState }

export interface AiRunOperationRow {
  runId: string
  key: string
  fingerprint: string
  /** What kind of operation (`plugin-operation`, `record-create`, `mail-draft`…). */
  kind: string
  state: AiRunOperationState
  /** The claim generation that sent it. */
  generation: number
  /** What it made (`plugin-operation` / `record` / `approval` / `outbound`, its id), once done. */
  refKind: string | null
  refId: string | null
  /** The HTTP status of the answer, once there was one. */
  status: number | null
  reconciledBy: string | null
  createdAt: string
  updatedAt: string
}

export interface AiRunRepository {
  byId(runId: string): AiRunRow | null
  /** The open (not closed) run of a record's step, if any. */
  openRun(recordId: string, step: string): AiRunRow | null
  /** Whether another step of the record has a run claimed now (running, its claim not expired at `nowIso`). */
  liveOtherStep(recordId: string, step: string, nowIso: string): boolean
  /** Runs of the member not closed yet, newest first. */
  openOf(userId: string): AiRunRow[]
  insert(row: AiRunRow): void
  /**
   * Replace the run's row if its generation and state are still the ones read
   * (a compare-and-set). false = someone changed it first (nothing written).
   */
  update(row: AiRunRow, expected: { generation: number; state: AiRunState }): boolean

  operation(runId: string, key: string): AiRunOperationRow | null
  operations(runId: string): AiRunOperationRow[]
  /** false when the key is already there (nothing written). */
  insertOperation(row: AiRunOperationRow): boolean
  /** Change an operation if it is still in `from` (one of them). false = it was not. */
  updateOperation(runId: string, key: string, from: AiRunOperationState[], change: Partial<Pick<AiRunOperationRow,
    'state' | 'refKind' | 'refId' | 'status' | 'reconciledBy' | 'generation' | 'fingerprint'>>, at: string): boolean
  /** Remove an operation that had no effect (a refused request): the key may be used again. */
  deleteOperation(runId: string, key: string, state: AiRunOperationState): boolean
}
