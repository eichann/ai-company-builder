/**
 * Records as the subjects of execution runs (ports/run-subjects.ts; B PR 1): the one resolver
 * today. A core step's run is claimable when the record is in the member's 「AI の番」
 * (`records.aiTurnOf`); a business plugin's step (`<pluginId>__<step>`, plan C5) when the record is
 * at the step for the member (`pluginSteps.turnOf`), and its claim carries the procedure the work
 * is pinned to. The answers (codes, texts, order) are the ones `POST /ai-run-claims` always gave
 * (records.md "Execution runs", plugin-steps.md).
 */
import type { PluginStepProcedurePin } from '../../shared/core/plugins'
import type { RunSubjectRun, RunSubjects } from '../ports/run-subjects'
import type { Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

/** Whether a record is in the member's 「AI の番」 now (services/records.ts `aiTurnOf`). */
export type AiTurnCheck = 'yes' | 'not-ai-turn' | 'not-found' | 'disabled'

/**
 * A business plugin's steps as runs (plan C5, services/plugin-steps.ts; bound
 * once by the plugins lane): a run named `<pluginId>__<step>` is claimable
 * when the record is at the step for the member (instead of a type's AI-only
 * action), and its claim carries the procedure the work is pinned to.
 */
export interface PluginStepRuns {
  isPluginStep(step: string): boolean
  turnOf(member: Member, recordId: string, step: string): AiTurnCheck
  pinForRun(member: Member, recordId: string, step: string): Promise<Outcome<PluginStepProcedurePin>>
  /** A plugin step's run finished as done (a person's step started by itself answers what asked for it). */
  afterDoneRun?(member: Member, run: { recordId: string; step: string; createdAt: string }): void
}

export interface RecordRunSubjectDeps {
  aiTurnOf: (member: Member, recordId: string, step: string) => AiTurnCheck
  /**
   * A run finished as failed: its step may give the record back to 「AI の番」 (minutes reading:
   * still 「読んでいる」 → 「届いた」), recorded as caused by the run, not by the member.
   */
  afterFailedRun?: (member: Member, run: { id: string; recordId: string; step: string }) => void
}

const NOT_AI_TURN = { error: 'この記録はいま AI の番ではありません', code: 'NOT_AI_TURN' }
/** What a run of another kind gets from the records (B PR 2): nothing — the same as a record that does not exist. */
const NOT_A_RECORD = { error: '記録が見つかりません', code: 'RECORD_NOT_FOUND' }

export function createRecordRunSubjects(deps: RecordRunSubjectDeps) {
  let pluginSteps: PluginStepRuns | null = null

  const subjects: RunSubjects<Refusal> = {
    resolve(member, subject, step) {
      // Only a record is a record: another kind's id never reaches aiTurnOf or the plugin steps.
      if (subject.kind !== 'record') return refuse('not-found', NOT_A_RECORD.error, { code: NOT_A_RECORD.code })
      const recordId = subject.id
      // A plugin step's name (`<pluginId>__<step>`) is never a core step's: unbound, it is nobody's turn.
      const steps = step.includes('__') ? pluginSteps : null
      if (step.includes('__') && !steps?.isPluginStep(step)) return refuse('conflict', NOT_AI_TURN.error, { code: NOT_AI_TURN.code })
      const turn = steps ? steps.turnOf(member, recordId, step) : deps.aiTurnOf(member, recordId, step)
      if (turn === 'disabled') return refuse('not-found', 'この会社では記録の機能が有効になっていません', { code: 'RECORDS_DISABLED' })
      if (turn === 'not-found') return refuse('not-found', '記録が見つかりません', { code: 'RECORD_NOT_FOUND' })
      if (turn === 'not-ai-turn') return refuse('conflict', NOT_AI_TURN.error, { code: NOT_AI_TURN.code })
      // The procedure the work runs: pinned at its first run (the operator's stop refuses here).
      if (!steps) return ok({ pin: null })
      return steps.pinForRun(member, recordId, step).then(pinned => (pinned.ok ? ok({ pin: pinned.value }) : pinned))
    },

    afterDone(member, run: RunSubjectRun) {
      if (run.subject.kind !== 'record') return
      if (pluginSteps?.isPluginStep(run.step)) pluginSteps.afterDoneRun?.(member, { recordId: run.subject.id, step: run.step, createdAt: run.createdAt })
    },

    afterFailed(member, run: RunSubjectRun) {
      // The minutes' read-back puts a record back to 「AI の番」: never for a run of another kind.
      if (run.subject.kind !== 'record') return
      deps.afterFailedRun?.(member, { id: run.id, recordId: run.subject.id, step: run.step })
    },
  }

  return {
    ...subjects,
    /** Bound once by the plugins lane (composition/plugins.ts): runs of business plugins' steps. */
    usePluginSteps(r: PluginStepRuns) { pluginSteps = r },
  }
}

export type RecordRunSubjects = ReturnType<typeof createRecordRunSubjects>
