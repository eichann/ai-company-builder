/**
 * The consultation AI's tool for a Skill's draft (`browser_skill_draft` on the app's MCP server `acb_browser`;
 * agent-browser.md "A Skill's draft from a recording", PR 2): read and change the member's own draft made from their own
 * recordings. Given with `browser_work` (the same switch, an agent with `capabilities.browserOperator`, never an
 * unattended step: `browserInspectForTurn`). Main calls the server with the member's session; the server answers the
 * member's own drafts and recordings only and refuses a `browser.yaml` wider than the recordings gave.
 */
import { z } from 'zod'
import {
  BROWSER_SKILL_DRAFT_ACTIONS, BROWSER_SKILL_DRAFT_AI_WORDS as W, BROWSER_SKILL_DRAFT_DESCRIPTION, BROWSER_SKILL_DRAFT_TOOL,
  BROWSER_SKILL_DRAFT_TOOL_LIMITS, browserSkillDraftInput, draftDetailWords, draftsListWords,
} from '../../shared/browser-skill-drafts'
import type { BrowserSkillDraftDetail, BrowserSkillDraftsList } from '../../../shared/types/browser-skill-drafts'
import type { DraftsAnswer } from '../features/browser/skill-drafts'

export { BROWSER_SKILL_DRAFT_TOOL }

export const browserSkillDraftSchema = z.object({
  action: z.enum(BROWSER_SKILL_DRAFT_ACTIONS).describe('list（一覧）／ show（中身を読む）／ save（直す）／ remake（記録から作り直す）'),
  draft: z.string().optional().describe('下書きの id（bd_ で始まる）。show と save で使う。'),
  version: z.string().optional().describe('save のとき：show で読んだ版（sha256: で始まる）。'),
  name: z.string().optional().describe('Skill の名前（半角の小文字・数字・-・_、64字まで）。save と remake で使える。'),
  steps: z.string().optional().describe('save のとき：SKILL.md の全文。'),
  declaration: z.string().optional().describe('save のとき：browser.yaml の全文（狭める直しだけ）。'),
  recordings: z.array(z.string()).optional().describe('remake のとき：本人の記録の id（br_ で始まる、5つまで、作った順）。'),
})

type Answer<T> = DraftsAnswer<T>

/** What the tool needs from main (features/browser/skill-drafts.ts over the member's session). */
export interface BrowserSkillDraftPlans {
  /** The switch: off = no tool this turn. */
  available(): boolean
  list(companyId: string): Promise<Answer<BrowserSkillDraftsList>>
  get(companyId: string, draftId: string): Promise<Answer<BrowserSkillDraftDetail>>
  save(companyId: string, draftId: string, body: { expectedVersion: string; name?: string; steps?: string; declaration?: string }): Promise<Answer<BrowserSkillDraftDetail>>
  remake(companyId: string, body: { recordingIds: string[]; name?: string }): Promise<Answer<BrowserSkillDraftDetail>>
}

function refusedWords(a: Exclude<Answer<unknown>, { kind: 'ok' }>): string {
  if (a.kind === 'no-answer') return W.failed
  if (a.code === 'BROWSER_SKILL_DRAFT_CHANGED' && a.extra.version) return W.changed(a.extra.version)
  if (a.code === 'BROWSER_SKILL_DRAFT_WIDER') return W.wider(a.extra.problem ?? 'not-covered', a.extra.write ?? null)
  return W.refused(a.error ?? W.failed)
}

/** The tool for one turn of one company. Never throws for the AI. */
export function createBrowserSkillDraftTool(plans: BrowserSkillDraftPlans, companyId: string): { description: string; execute(args: unknown): Promise<string> } {
  let calls = 0
  return {
    description: BROWSER_SKILL_DRAFT_DESCRIPTION,
    async execute(args) {
      if (calls >= BROWSER_SKILL_DRAFT_TOOL_LIMITS.callsPerTurn) return W.tooMany
      const input = browserSkillDraftInput(args)
      if (!input) return W.badInput
      calls++
      try {
        switch (input.action) {
          case 'list': {
            const a = await plans.list(companyId)
            return a.kind === 'ok' ? draftsListWords(a.value) : refusedWords(a)
          }
          case 'show': {
            const a = await plans.get(companyId, input.draft)
            return a.kind === 'ok' ? draftDetailWords(a.value) : refusedWords(a)
          }
          case 'save': {
            const change = {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.steps !== undefined ? { steps: input.steps } : {}),
              ...(input.declaration !== undefined ? { declaration: input.declaration } : {}),
            }
            const a = await plans.save(companyId, input.draft, { expectedVersion: input.version, ...change })
            return a.kind === 'ok' ? `${W.saved(a.value.version)}\n\n${draftDetailWords(a.value)}` : refusedWords(a)
          }
          case 'remake': {
            const a = await plans.remake(companyId, { recordingIds: input.recordings, ...(input.name !== undefined ? { name: input.name } : {}) })
            return a.kind === 'ok' ? draftDetailWords(a.value) : refusedWords(a)
          }
        }
      } catch {
        return W.failed
      }
    },
  }
}
