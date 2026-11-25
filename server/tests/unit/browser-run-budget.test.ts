/**
 * The operator runs' budgets and a write run's frames times agree (shared/core/browser-run-budget.ts; agent-browser.md
 * "Room for a Skill run"). Guards: only an open, approved company Skill's write run gets the larger budget (the one rule);
 * the server's lock outlives the app's operating by enough for the last write and the finish; a Skill run's preview, card
 * and work fit in its frames run's life; the log keeps every step a budget allows.
 */
import { describe, expect, it } from 'vitest'
import { BROWSER_FRAME_RUN_TIMES, BROWSER_RUN_BUDGETS, browserRunBudget, browserRunBudgetFor } from '../../../shared/core/browser-run-budget'
import { BROWSER_RUN_LIMITS } from '../../../shared/core/browser-run-log'
import { BROWSER_FRAME_TIMES } from '../../src/services/browser-frames'

/** What the app may still do after it stops operating: a write on its way (≤ 45 s), the window given back, the finish. */
const AFTER_OPERATING_MS = 60_000

describe('which budget a run gets', () => {
  it('only a write task\'s run naming an open company Skill\'s frames run gets `skill`', () => {
    expect(browserRunBudgetFor({ write: true, frameRun: { source: 'skill', state: 'open' } })).toBe('skill')
    expect(browserRunBudgetFor({ write: true, frameRun: { source: 'skill', state: 'waiting' } })).toBe('standard')
    expect(browserRunBudgetFor({ write: true, frameRun: { source: 'skill', state: 'locked' } })).toBe('standard')
    expect(browserRunBudgetFor({ write: true, frameRun: { source: 'adhoc', state: 'open' } })).toBe('standard')
    expect(browserRunBudgetFor({ write: false, frameRun: { source: 'skill', state: 'open' } })).toBe('standard')
    expect(browserRunBudgetFor({ write: true, frameRun: null })).toBe('standard')
  })

  it('an answer without a budget, or with one this app does not know, is standard', () => {
    expect(browserRunBudget(undefined)).toBe(BROWSER_RUN_BUDGETS.standard)
    expect(browserRunBudget('large')).toBe(BROWSER_RUN_BUDGETS.standard)
    expect(browserRunBudget('skill')).toBe(BROWSER_RUN_BUDGETS.skill)
  })
})

describe('the times agree', () => {
  it('the server holds the lock past the app\'s operating, by enough for the last write and the finish', () => {
    for (const b of Object.values(BROWSER_RUN_BUDGETS)) expect(b.runMs - b.operateMs).toBeGreaterThanOrEqual(AFTER_OPERATING_MS)
  })

  it('a Skill run (frames made before its preview) fits: the card by `approve`, then the work\'s whole lock, before the frames run ends', () => {
    expect(BROWSER_FRAME_RUN_TIMES.approve + BROWSER_RUN_BUDGETS.skill.runMs + AFTER_OPERATING_MS).toBeLessThanOrEqual(BROWSER_FRAME_RUN_TIMES.run)
    // Its preview is standard and ends before the card's time does.
    expect(BROWSER_RUN_BUDGETS.standard.runMs).toBeLessThan(BROWSER_FRAME_RUN_TIMES.approve)
    // The server's frames service uses these very times.
    expect([BROWSER_FRAME_TIMES.approve, BROWSER_FRAME_TIMES.run]).toEqual([BROWSER_FRAME_RUN_TIMES.approve, BROWSER_FRAME_RUN_TIMES.run])
  })

  it('the run log keeps every step a budget allows', () => {
    for (const b of Object.values(BROWSER_RUN_BUDGETS)) expect(b.steps).toBeLessThanOrEqual(BROWSER_RUN_LIMITS.steps)
  })

  it('today\'s numbers (stated in the PR): standard 20 steps / 5 min / 6 min, skill 60 / 15 / 17, frames 10 / 30 min', () => {
    expect(BROWSER_RUN_BUDGETS).toEqual({
      standard: { steps: 20, operateMs: 300_000, runMs: 360_000 },
      skill: { steps: 60, operateMs: 900_000, runMs: 1_020_000 },
    })
    expect(BROWSER_FRAME_RUN_TIMES).toEqual({ approve: 600_000, run: 1_800_000 })
  })
})
