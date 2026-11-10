/**
 * Records as runs' subjects (services/run-subjects.ts, ai-turns.md "The run's subject"):
 * - a `__` step name that is no registered business plugin step (or with the plugins lane not
 *   bound) is nobody's turn — 409 NOT_AI_TURN — and is never judged as a core step or by the lane;
 * - a built-in step answers synchronously, so a claim's turn check and its write stay in one
 *   synchronous stretch (no await before the transaction: no race window between them).
 */
import { describe, expect, it } from 'vitest'
import type { Member } from '../../src/services/access'
import { ok } from '../../src/services/outcome'
import { createRecordRunSubjects, type AiTurnCheck, type PluginStepRuns } from '../../src/services/run-subjects'

const member: Member = { companyId: 'co-a', userId: 'u-alice', role: 'member' }
const subject = { kind: 'record' as const, id: 'task-0001' }

/** Every lookup answers "yes, and pinned": a step that reached one would be claimable. */
function world() {
  const asked: string[] = []
  const subjects = createRecordRunSubjects({
    aiTurnOf: (_m, _r, step): AiTurnCheck => { asked.push(`aiTurnOf:${step}`); return 'yes' },
  })
  const lane: PluginStepRuns = {
    isPluginStep: step => step === 'sales__prepare',
    turnOf: (_m, _r, step) => { asked.push(`turnOf:${step}`); return 'yes' },
    pinForRun: async (_m, _r, step) => { asked.push(`pinForRun:${step}`); return ok({ source: 'plugin', version: '1.0.0', fingerprint: 'f' } as never) },
  }
  return { subjects, lane, asked }
}

describe('records as runs\' subjects', () => {
  it('a `__` step that is no registered plugin step is NOT_AI_TURN, never judged as a core step or by the lane', async () => {
    const { subjects, lane, asked } = world()
    // The lane not bound yet.
    const unbound = await subjects.resolve(member, subject, 'sales__prepare')
    expect(unbound).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'NOT_AI_TURN' } })
    subjects.usePluginSteps(lane)
    for (const step of ['sales__unknown', 'x__', '__y', 'a__b__c']) {
      expect(await subjects.resolve(member, subject, step)).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'NOT_AI_TURN' } })
    }
    expect(asked).toEqual([])
    // A registered one goes to the lane (the control: the fakes would have answered yes).
    expect(await subjects.resolve(member, subject, 'sales__prepare')).toMatchObject({ ok: true })
    expect(asked).toEqual(['turnOf:sales__prepare', 'pinForRun:sales__prepare'])
  })

  it('a built-in step answers synchronously (no Promise), with no pin', () => {
    const { subjects, lane } = world()
    subjects.usePluginSteps(lane)
    const answer = subjects.resolve(member, subject, 'minutes-reading')
    expect(answer).not.toBeInstanceOf(Promise)
    expect(answer).toEqual({ ok: true, value: { pin: null } })
  })
})
