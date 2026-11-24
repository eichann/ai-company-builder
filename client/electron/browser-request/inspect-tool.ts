/**
 * The consultation AI's 「ブラウザ操作」 inspection (`browser_inspect` on the app's MCP server `acb_browser`;
 * agent-browser.md "The inspection in the chat"; generalization PR 5b). The AI names an approved read-only line and the
 * numbers of the objects to read; main asks the server for the plan, reads the site through the member's own window
 * (GET only) and puts the card into the reply. The AI gets back fixed words and each check's mark: never a value the
 * site showed (owner decision, the PC-registration memo v2).
 *
 * Given only while the switch is on (off unless this PC's opt-in: the tool does not exist), only to an agent with
 * `capabilities.browserOperator` (Claude Code, in process; agents/claude.ts) and never in an unattended step — the same
 * gates as `browser_request`.
 */
import { z } from 'zod'
import { BROWSER_INSPECT_TOOL, BROWSER_INSPECT_WORDS as W } from '../../shared/browser-inspection'
import type { BrowserInspectOutcome } from '../features/browser/inspect'
import { BROWSER_WRITE_TOOL } from '../../shared/browser-inspection'
import { BROWSER_WRITE_WORDS as WW } from '../../shared/browser-line-writes'
import type { BrowserWriteProposeOutcome } from '../features/browser/write-lines'

export { BROWSER_INSPECT_TOOL, BROWSER_WRITE_TOOL }

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const VALUE_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
const MAX_VALUES = 10

export const browserInspectSchema = z.object({
  site: z.string().describe('サイトの種類。いまは "lstep"（Lステップ）だけ。The site: "lstep" only for now.'),
  line: z.string().describe('点検の種類。いまは "landing_inspect"（流入経路を点検する：複製した流入経路が、複製元と比べて正しく直されているか）だけ。The inspection.'),
  values: z.record(z.string(), z.string()).describe(
    '点検するものの番号。landing_inspect では {"landing": 点検する流入経路の番号, "source": 複製元の流入経路の番号}。' +
    'ユーザーが教えた番号（Lステップの流入経路の画面のアドレスにある数字）をそのまま入れる。分からなければ、呼ぶ前にユーザーに聞く。' +
    'The numbers of the objects to read, as the user gave them.'),
})

export const browserInspectDescription =
  'ユーザーに頼まれたとき、会社が許可したサイト（いまは Lステップ）で、許可された点検（いまは「流入経路を点検する」）をする。' +
  'アプリが、このパソコンでユーザーがログインしているサイトの窓から読むだけ（サイトは何も変えない）。結果はカードとして相談に出る。' +
  'あなたに返るのは決まった言葉と、確かめごとの ✓ / ✗ / 「読み取れませんでした」だけ。サイトの値（名前・日付・URL など）はあなたには見えないので、推測して書かない。' +
  '1回に数十秒かかることがある。ユーザーがはっきり頼んだときだけ呼ぶ。\n' +
  'Run an approved read-only inspection on a site the company allowed (today: Lステップ, landing_inspect). The app reads the site; ' +
  'the result is a card in the reply. You get fixed words and each check\'s mark only — never a value the site showed.'

export interface BrowserInspectTools {
  /** The tool's text result (never throws for the AI). */
  execute(args: unknown): Promise<string>
  /**
   * `browser_write` (generalization PR 5c): a proposal of an approved line that writes → a card for the member. Given only
   * with the write wiring and its switch on. It never writes: the member confirms each value and presses ［任せる］ on the
   * card; the AI gets fixed words only.
   */
  write?: { execute(args: unknown): Promise<string> }
}

export const browserWriteSchema = z.object({
  site: z.string().describe('サイトの種類。いまは "lstep"（Lステップ）だけ。The site: "lstep" only for now.'),
  line: z.string().describe('書き込みの種類（会社が許可した行の名前）。The approved line that writes.'),
  values: z.record(z.string(), z.string()).describe(
    'その行の値。対象の番号はユーザーが教えた番号をそのまま、書く値（名前・日付・時刻など）はあなたの案。案はカードでユーザーが1つずつ確かめる。' +
    'The line\'s values: the numbers as the user gave them, and your suggestion for each value to write (the member confirms each on the card).'),
})

export const browserWriteDescription =
  'ユーザーにはっきり頼まれたとき、会社が許可したサイトで、許可された書き込みの計画をカードにする。このツールは何も書かない。' +
  'ユーザーがカードで書く値を1つずつ確かめると、アプリがサイトを読んで計画を作り、ユーザーが［任せる］を押したときだけアプリが書く。' +
  'あなたには決まった言葉だけが返る（サイトの値も結果も届かない）ので、推測して書かない。\n' +
  'Propose an approved write line as a card. Nothing is written by this tool: the member confirms each value and presses ［任せる］. You get fixed words only.'

/** The tool for one turn: `run` inspects; `onCard` puts the card's reference into the reply. */
export function createBrowserInspectTools(
  run: (input: { site: string; line: string; values: Record<string, string> }) => Promise<BrowserInspectOutcome>,
  onCard: (planId: string) => void,
): BrowserInspectTools {
  return {
    async execute(args) {
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      const v = a.values
      if (typeof a.site !== 'string' || !NAME_RE.test(a.site) || typeof a.line !== 'string' || !NAME_RE.test(a.line)
        || !v || typeof v !== 'object' || Array.isArray(v)) return W.badInput
      const entries = Object.entries(v as Record<string, unknown>)
      if (entries.length === 0 || entries.length > MAX_VALUES || !entries.every(([k, x]) => VALUE_KEY_RE.test(k) && typeof x === 'string' && x.length <= 64)) return W.badInput
      let outcome: BrowserInspectOutcome
      try {
        outcome = await run({ site: a.site, line: a.line, values: Object.fromEntries(entries) as Record<string, string> })
      } catch {
        return W.failed
      }
      if (outcome.kind === 'card') onCard(outcome.planId)
      return outcome.words
    },
  }
}

/** The wiring's side the tool needs (features/browser/inspect.ts). */
export interface BrowserInspectPlans {
  /** The switch (this PC's opt-in): off = the tool does not exist this turn. */
  inspectAvailable(): boolean
  inspect(input: { companyId: string; conversationId: string | null; site: string; line: string; values: Record<string, string>; signal: AbortSignal }): Promise<BrowserInspectOutcome>
}

/** The write wiring's side the tool needs (features/browser/write-lines.ts). */
export interface BrowserWritePlans {
  writeAvailable(): boolean
  propose(input: { companyId: string; conversationId: string | null; site: string; line: string; values: Record<string, string> }): Promise<BrowserWriteProposeOutcome>
}

/** `browser_write`'s tool: checks the input's shape, proposes, puts the card's reference into the reply. Fixed words only. */
export function createBrowserWriteTool(
  run: (input: { site: string; line: string; values: Record<string, string> }) => Promise<BrowserWriteProposeOutcome>,
  onCard: (cardId: string) => void,
): { execute(args: unknown): Promise<string> } {
  return {
    async execute(args) {
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      const v = a.values
      if (typeof a.site !== 'string' || !NAME_RE.test(a.site) || typeof a.line !== 'string' || !NAME_RE.test(a.line)
        || !v || typeof v !== 'object' || Array.isArray(v)) return WW.badInput
      const entries = Object.entries(v as Record<string, unknown>)
      if (entries.length === 0 || entries.length > MAX_VALUES || !entries.every(([k, x]) => VALUE_KEY_RE.test(k) && typeof x === 'string' && x.length <= 200)) return WW.badInput
      let outcome: BrowserWriteProposeOutcome
      try {
        outcome = await run({ site: a.site, line: a.line, values: Object.fromEntries(entries) as Record<string, string> })
      } catch {
        return WW.failed
      }
      if (outcome.kind === 'card') onCard(outcome.cardId)
      return outcome.words
    },
  }
}

/** The tool for one consultation turn, or undefined (no wiring, or the switch off: no tool at all). */
export function browserInspectForTurn(
  plans: BrowserInspectPlans | undefined,
  turn: { companyId: string; conversationId: string | null; signal: AbortSignal; onCard: (planId: string) => void },
  writes?: BrowserWritePlans,
): BrowserInspectTools | undefined {
  if (!plans || !plans.inspectAvailable()) return undefined
  const tools = createBrowserInspectTools(input => plans.inspect({
    companyId: turn.companyId, conversationId: turn.conversationId, signal: turn.signal, site: input.site, line: input.line, values: input.values,
  }), turn.onCard)
  if (!writes || !writes.writeAvailable()) return tools
  return {
    ...tools,
    write: createBrowserWriteTool(input => writes.propose({
      companyId: turn.companyId, conversationId: turn.conversationId, site: input.site, line: input.line, values: input.values,
    }), turn.onCard),
  }
}
