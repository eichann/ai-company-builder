/**
 * The words of scheduled jobs (shared/core/job-words.ts, jobs.md "The screens"): every occurrence state
 * and outcome code the server can write has a plain sentence (a code added later without words would
 * reach a person's screen raw), and the sentences describe the trigger as it runs.
 */
import { describe, expect, it } from 'vitest'
import { JOB_OCCURRENCE_STATES, JOB_OUTCOME_CODES, JOB_PAUSE_REASONS } from '../../shared/core/jobs'
import { jobOccurrenceText, jobPauseReasonText, jobTriggerText } from '../../shared/core/job-words'

describe('job words', () => {
  it('every occurrence state and outcome code has words, never the code itself', () => {
    for (const state of JOB_OCCURRENCE_STATES) expect(jobOccurrenceText(state, null).label).not.toBe(state)
    for (const code of JOB_OUTCOME_CODES) {
      const why = jobOccurrenceText('held', code).why
      expect(why, code).toBeTruthy()
      expect(why).not.toContain(code)
    }
    for (const reason of JOB_PAUSE_REASONS) expect(jobPauseReasonText(reason)).not.toBe(jobPauseReasonText(null))
  })

  it('the trigger reads as it runs', () => {
    expect(jobTriggerText({ every: 'week', weekday: 'tue', at: '09:00', businessDaysBefore: 1 })).toBe('毎週火曜の1営業日前 09:00')
    expect(jobTriggerText({ every: 'day', at: '08:30', businessDaysOnly: true })).toBe('毎営業日 08:30')
    expect(jobTriggerText({ every: 'month', day: 'last', at: '17:00', ifHoliday: 'before' })).toBe('毎月末日 17:00（休みの日なら前の営業日）')
  })
})
