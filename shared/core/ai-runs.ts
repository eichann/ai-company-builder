/**
 * Execution runs of 「AI の番」 (stage 2 S10b, owner decision 2026-11-01:
 * conversations stay on the PC, the execution state lives on the server).
 * `.claude/rules/records.md` "Execution runs".
 *
 * One run per AI step of a record. The server keeps who claimed it (which
 * app instance, under which member's authority), until when (a claim that is
 * renewed while running), and a **claim generation**: a re-claim raises it and
 * every write of an older generation is refused (fencing). Each outside
 * operation within a run carries an idempotency key (the same key never repeats
 * the effect); an operation whose result is unknown blocks resuming until a
 * person has reconciled it. Failures are classified and each class has its own
 * destination — never silently back to 「AI の番」.
 *
 * Pure (shared/core): the server decides with it, the app shows its words.
 */

/** How long a claim lasts without renewal (the app renews about every minute while running). */
export const AI_RUN_CLAIM_TTL_MS = 5 * 60_000
/** Temporary failures in a row before the run goes to a person instead of retrying again. */
export const AI_RUN_TEMPORARY_LIMIT = 3

export const AI_RUN_STATES = [
  'running', // claimed by one app instance (until its claim expires)
  'open', // may be claimed (new, or given back by 「もう一度」 / reconciliation)
  'retry_later', // a temporary failure: claimable again from `retryAt`
  'waiting_setup', // a permission is missing: an admin / the member sets it up, then 「もう一度」
  'waiting_person', // bad input or missing information: a person looks, then 「もう一度」 or takes it over
  'waiting_reconcile', // an outside result is unknown: a person reconciles before anything resumes
  'done', // finished (closed)
] as const
export type AiRunState = typeof AI_RUN_STATES[number]

/**
 * An outside operation of a run, by its idempotency key: in_progress (sent, no
 * answer yet), done, unknown (the effect may or may not have happened — a
 * person reconciles), not_done (a person said it did not happen: the key may run again).
 */
export type AiRunOperationState = 'in_progress' | 'done' | 'unknown' | 'not_done'

export const AI_RUN_FAILURE_CLASSES = ['temporary', 'permission', 'bad-input', 'unknown-result'] as const
export type AiRunFailureClass = typeof AI_RUN_FAILURE_CLASSES[number]

/** Where a failure of each class goes (the owner's table, 現行の仕様 §5-2). */
export function failureDestination(cls: AiRunFailureClass): AiRunState {
  switch (cls) {
    case 'temporary': return 'retry_later'
    case 'permission': return 'waiting_setup'
    case 'bad-input': return 'waiting_person'
    case 'unknown-result': return 'waiting_reconcile'
  }
}

/** Wait before the next try after the `attempt`-th temporary failure in a row: 5, 10, 20 … minutes, at most 60. */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(60 * 60_000, 5 * 60_000 * 2 ** (n - 1))
}

/**
 * The class of a failed HTTP answer (ACB's own API or what it reports of an
 * outside system): null when it did not fail. A lost answer (`status` 0) and a
 * 5xx of a write are `unknown-result` — the effect may have happened.
 */
export function classifyFailure(answer: { status: number; code?: string | null; write?: boolean }): AiRunFailureClass | null {
  const { status, code } = answer
  if (status >= 200 && status < 300) return null
  if (status === 0) return answer.write === false ? 'temporary' : 'unknown-result'
  if (status === 429 || code === 'GOOGLE_UNAVAILABLE' || code === 'VERSION_CONFLICT' || code === 'RUN_CLAIMED') return 'temporary'
  if (status === 401 || status === 403 || code === 'GOOGLE_CONSENT_NEEDED' || code === 'MISSING_SCOPES') return 'permission'
  if (status >= 500) return answer.write === false || status === 503 ? 'temporary' : 'unknown-result'
  return 'bad-input'
}

/** An idempotency key: chosen by the caller, unique within its run (e.g. `log-meeting-1`). */
export const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{1,100}$/
/** A failure's reason as a short code (never free text: a reason could carry a customer's name). */
export const FAILURE_CODE_RE = /^[A-Z0-9_]{1,60}$/
/** An app instance's id (random, kept by the app). */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,100}$/
/** A step's name (`minutes-reading`, `task-prep`). */
/**
 * Which procedure an automated AI turn used (owner decision 2026-11-01 「流れを測れる記録」,
 * records.md "Which procedure"): kept on the run at each claim and copied onto every ledger
 * entry written in it. `step` is the app's step (its tools and instructions); `app` the desktop
 * app build that ran it (`X-ACB-Client-Version`: version + commit — the step's definition and
 * first message are that build's code); `plugins` the business / connector plugins turned on
 * for the company then, with their versions (read by the server, not reported by the app).
 * No company Skill: an unattended step loads none (ai-turns.md, `settingSources: []`).
 */
export interface AiRunProcedure {
  step: string
  app: string | null
  plugins: Array<{ id: string; version: string }>
}

/** A stored procedure read back (null when absent or not one). */
export function parseAiRunProcedure(raw: string | null | undefined): AiRunProcedure | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<AiRunProcedure>
    if (typeof v?.step !== 'string' || !Array.isArray(v.plugins)) return null
    return {
      step: v.step,
      app: typeof v.app === 'string' ? v.app : null,
      plugins: v.plugins.filter((p): p is { id: string; version: string } => typeof p?.id === 'string' && typeof p?.version === 'string'),
    }
  } catch {
    return null
  }
}

export const AI_RUN_STEP_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** What a person sees for each state (plain Japanese, no machinery). */
export const AI_RUN_STATE_LABELS: Record<AiRunState, string> = {
  running: 'AI が進めています',
  open: 'AI が始めるのを待っています',
  retry_later: '一時的にうまくいかなかったため、少し後にもう一度進めます',
  waiting_setup: '権限が足りないため止まっています。設定を確かめてから「もう一度」を押してください',
  waiting_person: '入力や情報が足りないため止まっています。内容を確かめてください',
  waiting_reconcile: '外への操作の結果が分かりません。相手先で確かめてから続きを進めます',
  done: '終わりました',
}

/** States a run cannot leave without a person (「もう一度」 or reconciliation). */
export const AI_RUN_PERSON_STATES: readonly AiRunState[] = ['waiting_setup', 'waiting_person', 'waiting_reconcile']
