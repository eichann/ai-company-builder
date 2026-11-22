/**
 * The consultation AI's 「ブラウザ操作」 request (`browser_request` on the app's MCP server `acb_browser`;
 * agent-browser.md "The card, the IPC and the request tool"; design 6b-2 §3 step 1, decision 7). The AI
 * hands a typed request only — the site's type and the names it knows —; main makes the plan (the
 * operator chooses, the checker reads the facts, the server fixes it) and the card goes into the reply.
 * The AI gets back the plan's number and fixed words: never a fact, a hash, the page's text, and never
 * the result of a run (it cannot approve, claim, permit, report or confirm: no such tool exists).
 *
 * Given only while the switch is on (off unless this PC's opt-in: the tool does not exist) and only to an agent
 * with `capabilities.browserOperator` (Claude Code, in process; agents/claude.ts).
 */
import { z } from 'zod'
import { BROWSER_REQUEST_SERVER, BROWSER_REQUEST_TOOL, BROWSER_REQUEST_WORDS as W } from '../../shared/browser-plans'
import { BROWSER_OPERATOR_LIMITS } from '../../shared/browser-operator'
import type { BrowserRegistrationResult } from '../features/browser/register'

export { BROWSER_REQUEST_SERVER, BROWSER_REQUEST_TOOL }

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const HINT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/

export const browserRequestSchema = z.object({
  site: z.string().describe('サイトの種類。いまは "lstep"（Lステップ）だけ。The site: "lstep" only for now.'),
  operation: z.string().describe('操作の種類。いまは "reminder_step_add_template"（リマインダの段にテンプレートを足す）だけ。The operation type.'),
  target_hints: z.record(z.string(), z.string()).describe('どこに：ユーザーが言った名前（例：{"reminder": "11月のリマインダ", "step": "当日"}）。Where: names as the user said them.'),
  change_hints: z.record(z.string(), z.string()).describe('何を：ユーザーが言った名前（例：{"template": "前日のご案内"}）。What: names as the user said them.'),
  reason: z.string().describe('なぜ頼まれたか（200文字以内）。Why (≤ 200 characters).'),
})

export const browserRequestDescription =
  'ユーザーに頼まれた、会社が許可したサイトでの操作（いまは Lステップの「リマインダの段にテンプレートを足す」だけ）の計画を作り、相談に承認のカードを出す。' +
  'あなたはサイトを見たり操作したりできない。アプリの別の役がサイトの中を探し、サイトから事実を読み取って計画にする。送るのは、ユーザーがカードで確かめて［任せる］を押したときだけ。' +
  '返ってくるのは計画の番号と決まった言葉だけ。結果をあなたが知ることはなく、承認・実行・確認もできない。ユーザーがはっきり頼んだときだけ呼ぶ。1回に数分かかることがある。\n' +
  'Make a plan for an operation the user asked for on a site the company allowed (today: Lステップ, add a template to a reminder step) and put the approval card in the reply. ' +
  'You cannot see or operate the site; the app reads the facts itself. Nothing is sent until the user presses ［任せる］ on the card. You get back a plan number and fixed words only. Call it only when the user asked.'

/** One request turned into a plan (features/browser/register.ts through the wiring), or why not. */
export type BrowserRequestRun = (input: {
  site: string
  operation: string
  targetHints: Record<string, string>
  changeHints: Record<string, string>
  reason: string
}) => Promise<BrowserRegistrationResult>

export interface BrowserRequestTools {
  /** The tool's text result (never throws for the AI). */
  execute(args: unknown): Promise<string>
}

function hints(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 10) return null
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (!HINT_KEY_RE.test(k) || typeof v !== 'string') return null
    out[k] = v.slice(0, BROWSER_OPERATOR_LIMITS.hint)
  }
  return out
}

/** The tool for one turn: `run` makes the plan; `onPlan` puts the card's reference into the reply. */
export function createBrowserRequestTools(run: BrowserRequestRun, onPlan: (planId: string) => void): BrowserRequestTools {
  return {
    async execute(args) {
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      const targetHints = hints(a.target_hints)
      const changeHints = hints(a.change_hints)
      if (typeof a.site !== 'string' || !NAME_RE.test(a.site) || typeof a.operation !== 'string' || !NAME_RE.test(a.operation)
        || !targetHints || !changeHints || typeof a.reason !== 'string') return W.badInput
      let result: BrowserRegistrationResult
      try {
        result = await run({ site: a.site, operation: a.operation, targetHints, changeHints, reason: a.reason.slice(0, BROWSER_OPERATOR_LIMITS.hint) })
      } catch {
        return W.failed
      }
      if (result.outcome === 'registered') {
        onPlan(result.planId)
        return W.registered(result.planId)
      }
      // The operator's own question is not passed on (it read the site's names): fixed words only.
      if (result.outcome === 'not-found') return W.notFound
      const word = W[result.why]
      return typeof word === 'string' ? word : W.failed
    },
  }
}

/** The wiring's side the tool needs (features/browser/wire.ts). */
export interface BrowserRequestPlans {
  /** The switch (this PC's opt-in): off = the tool does not exist this turn. */
  requestAvailable(): boolean
  request(input: {
    companyId: string; conversationId: string | null; site: string; operation: string
    hints: { targetHints: Record<string, string>; changeHints: Record<string, string>; reason: string }; signal: AbortSignal
  }): Promise<BrowserRegistrationResult>
}

/** The tool for one consultation turn, or undefined (no wiring, or the switch off: no tool at all). */
export function browserRequestForTurn(
  plans: BrowserRequestPlans | undefined,
  turn: { companyId: string; conversationId: string | null; signal: AbortSignal; onPlan: (planId: string) => void },
): BrowserRequestTools | undefined {
  if (!plans || !plans.requestAvailable()) return undefined
  return createBrowserRequestTools(input => plans.request({
    companyId: turn.companyId, conversationId: turn.conversationId, site: input.site, operation: input.operation, signal: turn.signal,
    hints: { targetHints: input.targetHints, changeHints: input.changeHints, reason: input.reason },
  }), turn.onPlan)
}
