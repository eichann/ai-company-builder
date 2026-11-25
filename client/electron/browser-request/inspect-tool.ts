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
 *
 * The words here are every company's: no site, job or field word (agent-browser.md "The tools' words"). What can be
 * asked — which site, which line, which values — is the catalog the wiring builds from the site data this build carries
 * (`client/shared/browser-tool-catalog.ts`), appended to the description per turn.
 */
import { z } from 'zod'
import { BROWSER_INSPECT_TOOL, BROWSER_INSPECT_WORDS as W } from '../../shared/browser-inspection'
import type { BrowserInspectOutcome } from '../features/browser/inspect'
import { BROWSER_WRITE_TOOL } from '../../shared/browser-inspection'
import { BROWSER_WRITE_WORDS as WW } from '../../shared/browser-line-writes'
import type { BrowserWriteProposeOutcome } from '../features/browser/write-lines'
import { BROWSER_CATALOG_NONE } from '../../shared/browser-tool-catalog'
import { BROWSER_BROWSE_LIMITS, BROWSER_BROWSE_TOOL, BROWSER_BROWSE_WORDS as BW, browseHeading } from '../../shared/browser-browse'
import { normalizeBrowserHost } from '../../../shared/core/browser-operation'
import type { BrowserBrowseOutcome } from '../features/browser/browse'

export { BROWSER_INSPECT_TOOL, BROWSER_WRITE_TOOL, BROWSER_BROWSE_TOOL }

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const VALUE_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
const MAX_VALUES = 10

export const browserInspectSchema = z.object({
  site: z.string().describe('サイトの種類（下の一覧の site）。The site, as listed in the description.'),
  line: z.string().describe('点検の種類（下の一覧の line）。The inspection, as listed in the description.'),
  values: z.record(z.string(), z.string()).describe(
    '点検するものの番号（下の一覧の values の名前ごと）。ユーザーが教えた番号（サイトの画面のアドレスにある数字など）をそのまま入れる。' +
    '分からなければ、呼ぶ前にユーザーに聞く。The numbers of the objects to read, as the user gave them.'),
})

/** The inspection tool's description for one turn: the shared words, then what can be asked (the catalog). */
export function browserInspectDescription(catalog: string): string {
  return 'ユーザーに頼まれたとき、会社が許可したサイトで、許可された点検をする。' +
    'アプリが、このパソコンでユーザーがログインしているサイトの窓から読むだけ（サイトは何も変えない）。結果はカードとして相談に出る。' +
    'あなたに返るのは決まった言葉と、確かめごとの ✓ / ✗ / 「読み取れませんでした」だけ。サイトの値（名前・日付・URL など）はあなたには見えないので、推測して書かない。' +
    '1回に数十秒かかることがある。ユーザーがはっきり頼んだときだけ呼ぶ。\n' +
    'Run an approved read-only inspection on a site the company allowed. The app reads the site; ' +
    'the result is a card in the reply. You get fixed words and each check\'s mark only — never a value the site showed.\n' +
    `頼めるもの（What can be asked）:\n${catalog}`
}

export interface BrowserInspectTools {
  /** The description for this turn (the shared words and the catalog). */
  description: string
  /** The tool's text result (never throws for the AI). */
  execute(args: unknown): Promise<string>
  /**
   * `browser_write` (generalization PR 5c): a proposal of an approved line that writes → a card for the member. Given only
   * with the write wiring and its switch on. It never writes: the member confirms each value and presses ［任せる］ on the
   * card; the AI gets fixed words only.
   */
  write?: { description: string; execute(args: unknown): Promise<string> }
  /**
   * `browser_browse` (redesign step ④, agent-browser.md "The operator's window tools"): a read task on a registered domain,
   * done by the operator in the member's window. Given only with its wiring and the switch on. Fixed words only.
   */
  browse?: { description: string; execute(args: unknown): Promise<string> }
}

export const browserBrowseSchema = z.object({
  site: z.string().describe('サイトのドメイン（下の一覧のどれか）。The registered domain, as listed in the description.'),
  task: z.string().describe('サイトでしてほしいことを文で（読むだけ。1000字まで）。The read task in words (1000 characters at most).'),
  items: z.array(z.string()).optional().describe('読んでほしいものの見出し（10個まで、各40字まで）。読めなかったものは見出しで返る。Headings of what to read; the unread ones come back by heading.'),
})

/** The browse tool's description for one turn: the shared words, then the domains this company registered. */
export function browserBrowseDescription(domains: readonly string[]): string {
  return 'ユーザーに頼まれたとき、会社が登録したサイトの画面を、別の係の AI に読んでもらう（読むだけ。サイトは何も変えない。保存や送信はアプリが止める）。' +
    'ユーザーがこのパソコンでそのサイトの窓を開いてログインしている必要がある。読み取った内容はカードとして相談に出て、ユーザーだけが見る。' +
    'あなたに返るのは決まった言葉（済みました／止まりました／読めなかったもの：あなたが渡した見出し）だけ。サイトの内容はあなたには見えないので、推測して書かない。' +
    '1回に数分かかることがある。ユーザーがはっきり頼んだときだけ呼ぶ。\n' +
    'Ask a separate operator AI to read pages of a domain the company registered, in the member\'s logged-in window (read only). ' +
    'The result is a card for the member; you get fixed words only.\n' +
    `頼めるサイト（Registered domains）:\n${domains.length > 0 ? domains.map(d => `- ${d}`).join('\n') : BROWSER_CATALOG_NONE}`
}

/** `browser_browse`'s tool: checks the input's shape, runs the read task, puts the card's reference into the reply. */
export function createBrowserBrowseTool(
  run: (input: { site: string; task: string; items: string[] }) => Promise<BrowserBrowseOutcome>,
  onCard: (runId: string) => void,
  domains: readonly string[] = [],
): { description: string; execute(args: unknown): Promise<string> } {
  return {
    description: browserBrowseDescription(domains),
    async execute(args) {
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      if (typeof a.site !== 'string' || normalizeBrowserHost(a.site) !== a.site) return BW.badInput
      if (typeof a.task !== 'string' || a.task.trim() === '' || a.task.length > BROWSER_BROWSE_LIMITS.task) return BW.badInput
      const given = a.items === undefined ? [] : a.items
      if (!Array.isArray(given) || given.length > BROWSER_BROWSE_LIMITS.items) return BW.badInput
      const items: string[] = []
      for (const h of given) {
        const heading = browseHeading(h)
        if (!heading) return BW.badInput
        items.push(heading)
      }
      let outcome: BrowserBrowseOutcome
      try {
        outcome = await run({ site: a.site, task: a.task, items })
      } catch {
        return BW.failed
      }
      if (outcome.kind === 'card') onCard(outcome.runId)
      return outcome.words
    },
  }
}

/** The browse wiring's side the tool needs (features/browser/browse.ts). */
export interface BrowserBrowsePlans {
  available(): boolean
  /** The domains this company registered (its current valid policy): the only ones the tool names. */
  domains(companyId: string): string[]
  browse(input: { companyId: string; conversationId: string | null; site: string; task: string; items: readonly string[]; signal: AbortSignal }): Promise<BrowserBrowseOutcome>
}

export const browserWriteSchema = z.object({
  site: z.string().describe('サイトの種類（下の一覧の site）。The site, as listed in the description.'),
  line: z.string().describe('書き込みの種類（下の一覧の line）。The approved line that writes, as listed in the description.'),
  values: z.record(z.string(), z.string()).describe(
    'その行の値。対象の番号はユーザーが教えた番号をそのまま、書く値（名前・日付・時刻など）はあなたの案。案はカードでユーザーが1つずつ確かめる。' +
    'The line\'s values: the numbers as the user gave them, and your suggestion for each value to write (the member confirms each on the card).'),
})

/** The write tool's description for one turn: the shared words, then what can be asked (the catalog). */
export function browserWriteDescription(catalog: string): string {
  return 'ユーザーにはっきり頼まれたとき、会社が許可したサイトで、許可された書き込みの計画をカードにする。このツールは何も書かない。' +
    'ユーザーがカードで書く値を1つずつ確かめると、アプリがサイトを読んで計画を作り、ユーザーが［任せる］を押したときだけアプリが書く。' +
    'あなたには決まった言葉だけが返る（サイトの値も結果も届かない）ので、推測して書かない。\n' +
    'Propose an approved write line as a card. Nothing is written by this tool: the member confirms each value and presses ［任せる］. You get fixed words only.\n' +
    `頼めるもの（What can be asked）:\n${catalog}`
}

/** The tool for one turn: `run` inspects; `onCard` puts the card's reference into the reply. */
export function createBrowserInspectTools(
  run: (input: { site: string; line: string; values: Record<string, string> }) => Promise<BrowserInspectOutcome>,
  onCard: (planId: string) => void,
  catalog = BROWSER_CATALOG_NONE,
): BrowserInspectTools {
  return {
    description: browserInspectDescription(catalog),
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
  /** What can be inspected in this company, from the site data this build carries (`browserLineCatalog`). */
  catalog?(companyId: string): string
  inspect(input: { companyId: string; conversationId: string | null; site: string; line: string; values: Record<string, string>; signal: AbortSignal }): Promise<BrowserInspectOutcome>
}

/** The write wiring's side the tool needs (features/browser/write-lines.ts). */
export interface BrowserWritePlans {
  writeAvailable(): boolean
  /** What can be proposed in this company, from the site data this build carries (`browserLineCatalog`). */
  catalog?(companyId: string): string
  propose(input: { companyId: string; conversationId: string | null; site: string; line: string; values: Record<string, string> }): Promise<BrowserWriteProposeOutcome>
}

/** `browser_write`'s tool: checks the input's shape, proposes, puts the card's reference into the reply. Fixed words only. */
export function createBrowserWriteTool(
  run: (input: { site: string; line: string; values: Record<string, string> }) => Promise<BrowserWriteProposeOutcome>,
  onCard: (cardId: string) => void,
  catalog = BROWSER_CATALOG_NONE,
): { description: string; execute(args: unknown): Promise<string> } {
  return {
    description: browserWriteDescription(catalog),
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
  browses?: BrowserBrowsePlans,
): BrowserInspectTools | undefined {
  if (!plans || !plans.inspectAvailable()) return undefined
  const inspect = createBrowserInspectTools(input => plans.inspect({
    companyId: turn.companyId, conversationId: turn.conversationId, signal: turn.signal, site: input.site, line: input.line, values: input.values,
  }), turn.onCard, plans.catalog?.(turn.companyId))
  // The read task on a registered domain: the same switch, the turn's signal (closing or stopping the consultation stops it).
  const tools: BrowserInspectTools = browses && browses.available() ? {
    ...inspect,
    browse: createBrowserBrowseTool(input => browses.browse({
      companyId: turn.companyId, conversationId: turn.conversationId, signal: turn.signal, site: input.site, task: input.task, items: input.items,
    }), turn.onCard, browses.domains(turn.companyId)),
  } : inspect
  if (!writes || !writes.writeAvailable()) return tools
  return {
    ...tools,
    write: createBrowserWriteTool(input => writes.propose({
      companyId: turn.companyId, conversationId: turn.conversationId, site: input.site, line: input.line, values: input.values,
    }), turn.onCard, writes.catalog?.(turn.companyId)),
  }
}
