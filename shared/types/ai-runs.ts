/**
 * API contract of execution runs (stage 2 S10b, records.md "Execution runs").
 *
 *   GET  /api/companies/:companyId/ai-runs                                   the member's open runs
 *   POST /api/companies/:companyId/ai-run-claims                             AiRunClaimRequest → 201 { run }
 *   GET  /api/companies/:companyId/ai-runs/:runId                            { run }
 *   POST /api/companies/:companyId/ai-runs/:runId/renew                      { generation } → { run }
 *   POST /api/companies/:companyId/ai-runs/:runId/finish                     AiRunFinishRequest → { run }
 *   POST /api/companies/:companyId/ai-runs/:runId/retry                      「もう一度」 → { run }
 *   POST /api/companies/:companyId/ai-runs/:runId/operations/:key/reconcile  { done } → { run }
 *
 * All with the member's session (their app's main process); a run is only its
 * member's. The AI's calls carry the run through their record token
 * (`POST /me/record-tokens { …, run: { id, generation } }`) and an
 * `Idempotency-Key` header on every outside operation.
 */
import type { AiRunFailureClass, AiRunOperationState, AiRunProcedure, AiRunState } from '../core/ai-runs'

export interface AiRunOperationView {
  key: string
  kind: string
  state: AiRunOperationState
  /** What it made, once done: `plugin-operation`, `approval`, `record`, `outbound`. */
  ref: { kind: string; id: string } | null
  updatedAt: string
}

export interface AiRunView {
  id: string
  recordId: string
  step: string
  state: AiRunState
  /** The state in plain Japanese (AI_RUN_STATE_LABELS). */
  label: string
  generation: number
  /** The app instance holding the claim, while one does. */
  deviceId: string | null
  conversationId: string | null
  claimExpiresAt: string | null
  failure: { class: AiRunFailureClass; code: string | null } | null
  retryAt: string | null
  attempts: number
  pluginVersion: string | null
  stepsVersion: string | null
  /** Which procedure the latest claim runs (step, app build, plugins; records.md "Which procedure"); null on runs claimed before. */
  procedure: AiRunProcedure | null
  /** A person must act before it goes on (「もう一度」 or reconciling). */
  needsPerson: boolean
  operations: AiRunOperationView[]
  createdAt: string
  updatedAt: string
}

export interface AiRunClaimRequest {
  recordId: string
  /** The AI step (`minutes-reading`). */
  step: string
  /** The app instance (random, kept by the app). */
  deviceId: string
  /** The hidden consultation that runs it. */
  conversationId: string
  /** What ran it, for looking back: the plugin's and the steps' versions. */
  pluginVersion?: string
  stepsVersion?: string
}

export interface AiRunFinishRequest {
  generation: number
  outcome: 'done' | 'failed'
  /** Required when failed: the class decides where it goes; `code` a short code (never free text). */
  failure?: { class: AiRunFailureClass; code?: string }
}

/** Answer to an outside operation repeated with a key already done: the effect is not repeated. */
export interface AiRunReplayAnswer {
  replayed: true
  operationKey: string
  ref: { kind: string; id: string } | null
}
