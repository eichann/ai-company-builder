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
import { BROWSER_WORK_LIMITS, BROWSER_WORK_TOOL, BROWSER_WORK_WORDS as KW, workHeading } from '../../shared/browser-frame-writes'
import { browserSkillRef } from '../../../shared/core/browser-skill'
import { createBrowserSkillDraftTool, type BrowserSkillDraftPlans } from './skill-draft-tool'

export { BROWSER_INSPECT_TOOL, BROWSER_WRITE_TOOL, BROWSER_BROWSE_TOOL, BROWSER_WORK_TOOL }

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
  /**
   * `browser_work` (redesign step ⑤b, agent-browser.md "Writes within frames, in the app"): a write task on a registered
   * domain — a company Skill's or one the member approves on the card. Given only with its wiring and the switch on. Fixed
   * words only; it waits for the card's ［任せる］ (or a pre-approved Skill) and the work, then answers.
   */
  work?: { description: string; execute(args: unknown): Promise<string> }
  /**
   * `browser_skill_draft` (agent-browser.md "A Skill's draft from a recording", PR 2): the member's own Skill draft made
   * from their own recordings — read it and change it (the server refuses anything wider than the recordings gave). Given
   * with `browser_work` only.
   */
  draft?: { description: string; execute(args: unknown): Promise<string> }
}

export const browserWorkSchema = z.object({
  site: z.string().describe('サイトのドメイン（下の一覧のどれか）。The registered domain, as listed in the description.'),
  task: z.string().describe('サイトでしてほしい作業を一文で（1000字まで。カードに出る。Skill を使うときは係の AI には渡らない）。The task in one sentence; with a Skill it is shown on the card only.'),
  skill: z.string().optional().describe('会社の Skill を使うときだけ、その名前、または Skill のパス（全社は .claude/skills/<名前>、部署は <部署のフォルダ>/.claude/skills/<名前>）。同じ名前の Skill が全社と部署や複数の部署にあるときはパスで。The company or department Skill to follow, if any: its name, or its path when the name is not unique.'),
  said: z.array(z.string()).optional().describe('ユーザー本人がはっきり言った禁止・制約だけ、本人の言葉のまま（例：既存のものは変えない、登録の前で止めて）。10個まで、各300字まで。あなたの考えた手順や止まる条件は書かない。The prohibitions and limits the user said, in their words; never your own steps or stop conditions.'),
  values: z.array(z.object({ label: z.string(), value: z.string() })).optional().describe('ユーザー本人が言った値（名前・日付・番号など）。16個まで、label 40字・value 200字まで。The values the user gave.'),
  items: z.array(z.string()).optional().describe('読み取ってほしいものの見出し（10個まで、各40字まで）。読めなかったものは見出しで返る。'),
})

/** The work tool's description for one turn: the shared words, then the domains this company registered. */
export function browserWorkDescription(domains: readonly string[]): string {
  return 'ユーザーにはっきり頼まれたとき、会社が登録したサイトで、書く作業（保存・作成など）を別の係の AI にしてもらう。' +
    '会社や部署の Skill があれば skill にその名前（同じ名前がほかの部署にもあるときは Skill のパス）を入れる（Skill の手順と、管理者が承認した送り先の枠の中だけで書く）。Skill がなければ、係の AI が下見して計画を作り、ユーザーがカードで［任せる］を押したときだけ書く。' +
    '係の AI が手本にするのは、said（ユーザーがはっきり言った禁止・制約）と values（ユーザーが言った値）、Skill の手順だけ。Skill を使うときは、手順や止まる条件を足さない（task も係の AI には渡らない）。ユーザーが言っていない禁止や確認を said に書かない。' +
    'ユーザーがこのパソコンでそのサイトの窓を開いてログインしていて、そのサイトを「変えてよい」になっている必要がある。結果はカードとして相談に出て、ユーザーだけが見る。' +
    'あなたに返るのは決まった言葉（済みました／止まりました／分からない書き込みがあります／読めなかったもの：見出し）だけ。サイトの内容は見えないので推測して書かない。済んだら、相談や作業の次の段に進む。' +
    '1回に数分かかる（カードの承認を待つ間も）。\n' +
    'Ask a separate operator AI to do a writing task on a domain the company registered (within a company Skill\'s approved frames, ' +
    'or a plan the member approves on the card). You get fixed words only.\n' +
    `頼めるサイト（Registered domains）:
${domains.length > 0 ? domains.map(d => `- ${d}`).join('\n') : BROWSER_CATALOG_NONE}`
}

/** `browser_work`'s tool: checks the input's shape, runs the write task (one per turn), puts the card's reference into the reply. */
export function createBrowserWorkTool(
  run: (input: { site: string; task: string; skill: string | null; said: string[]; values: Array<{ label: string; value: string }>; items: string[] }) => Promise<{ words: string }>,
  domains: readonly string[] = [],
): { description: string; execute(args: unknown): Promise<string> } {
  let calls = 0
  return {
    description: browserWorkDescription(domains),
    async execute(args) {
      if (calls >= BROWSER_WORK_LIMITS.callsPerTurn) return KW.tooMany
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
      if (typeof a.site !== 'string' || normalizeBrowserHost(a.site) !== a.site) return KW.badInput
      if (typeof a.task !== 'string' || a.task.trim() === '' || a.task.length > BROWSER_BROWSE_LIMITS.task) return KW.badInput
      const skill = a.skill === undefined ? null : browserSkillRef(a.skill)
      if (a.skill !== undefined && skill === null) return KW.badInput
      const given = a.items === undefined ? [] : a.items
      if (!Array.isArray(given) || given.length > BROWSER_BROWSE_LIMITS.items) return KW.badInput
      const items: string[] = []
      for (const h of given) {
        const heading = workHeading(h)
        if (!heading) return KW.badInput
        items.push(heading)
      }
      const person = workPersonOf(a.said, a.values)
      if (!person) return KW.badInput
      calls++
      try {
        return (await run({ site: a.site, task: a.task, skill, said: person.said, values: person.values, items })).words
      } catch {
        return KW.failed
      }
    },
  }
}

/** A string of the person's words: within its cap, no control character (a line break is kept as said). */
// eslint-disable-next-line no-control-regex
const PERSON_TEXT_BAD_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/
const personText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max && !PERSON_TEXT_BAD_RE.test(v)

/** The person's words as the tool takes them (`said`, `values`), each as given, or null when off their shape. */
export function workPersonOf(said: unknown, values: unknown): { said: string[]; values: Array<{ label: string; value: string }> } | null {
  const s = said === undefined ? [] : said
  const v = values === undefined ? [] : values
  if (!Array.isArray(s) || s.length > BROWSER_WORK_LIMITS.said || !s.every(x => personText(x, BROWSER_WORK_LIMITS.saidChars))) return null
  if (!Array.isArray(v) || v.length > BROWSER_WORK_LIMITS.personValues) return null
  const out: Array<{ label: string; value: string }> = []
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(k => k !== 'label' && k !== 'value')) return null
    const { label, value } = x as Record<string, unknown>
    if (!personText(label, BROWSER_WORK_LIMITS.personLabel) || typeof value !== 'string' || value.length > BROWSER_WORK_LIMITS.personValue || PERSON_TEXT_BAD_RE.test(value)) return null
    out.push({ label, value })
  }
  return { said: [...s as string[]], values: out }
}

/** The work wiring's side the tool needs (features/browser/work.ts). */
export interface BrowserWorkPlans {
  available(): boolean
  work(input: { companyId: string; conversationId: string | null; companyRoot: string | null; site: string; task: string; skill: string | null; said: readonly string[]; values: ReadonlyArray<{ label: string; value: string }>; items: readonly string[]; signal: AbortSignal; onCard(runId: string): void }): Promise<{ words: string }>
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
  // A few read tasks per turn (independent review): the done / stop words and unread numbers are a channel of a few bits
  // whose questions the chat AI writes, so the number of answers it can collect in one turn is bounded.
  let calls = 0
  return {
    description: browserBrowseDescription(domains),
    async execute(args) {
      if (calls >= BROWSER_BROWSE_LIMITS.callsPerTurn) return BW.tooMany
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
      calls++
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
  turn: { companyId: string; conversationId: string | null; signal: AbortSignal; onCard: (planId: string) => void; companyRoot?: string | null },
  writes?: BrowserWritePlans,
  browses?: BrowserBrowsePlans,
  works?: BrowserWorkPlans,
  drafts?: BrowserSkillDraftPlans,
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
  // A write task on a registered domain (step ⑤b): the same switch and turn signal; the domains are the browse wiring's.
  if (works && works.available() && browses) {
    tools.work = createBrowserWorkTool(input => works.work({
      companyId: turn.companyId, conversationId: turn.conversationId, companyRoot: turn.companyRoot ?? null, signal: turn.signal,
      site: input.site, task: input.task, skill: input.skill, said: input.said, values: input.values, items: input.items, onCard: turn.onCard,
    }), browses.domains(turn.companyId))
    // The member's own Skill draft from their own recordings: beside the write task it is made for.
    if (drafts && drafts.available()) tools.draft = createBrowserSkillDraftTool(drafts, turn.companyId)
  }
  if (!writes || !writes.writeAvailable()) return tools
  return {
    ...tools,
    write: createBrowserWriteTool(input => writes.propose({
      companyId: turn.companyId, conversationId: turn.conversationId, site: input.site, line: input.line, values: input.values,
    }), turn.onCard, writes.catalog?.(turn.companyId)),
  }
}
