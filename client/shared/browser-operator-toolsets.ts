/**
 * The operator's tool sets of 「ブラウザ操作」 (agent-browser.md "The operator's tool sets"; owner 2026-11-28: try a compact
 * set on the real app, chosen per PC). A tool set changes only **what the operator is told** (its prompts' action and
 * screen lines, its history's words) and **how its answer is read** before the one parser of the window tools
 * (`parseBrowseAnswer` / `parseWorkAnswer`) takes it. Every answer of every set becomes one of today's actions
 * (`BrowserBrowseAction`), so everything after the parser — the window's checks before acting, the `ai` gate, holding each
 * page write and sending it once within the frames, the permits, the run's promise, the waits for a press's write, the run
 * log in today's words — is the same code for every set. What the operator can do is the same in every set.
 *
 * - `current`: today's words — click, type, select, go, back, wait.
 * - `compact`: click; `set` (into a field, or a choice of a select: one word, the element decides which); `go` (an address
 *   of the site, or `back`); wait. The ends (done, stop, plan) are every set's.
 *
 * Pure; knows no site. The setting itself is this PC's (`config.json` `browserOperatorToolset`, default `current`).
 */
import {
  OPERATOR_ACTION_LINES, OPERATOR_SCREEN_LINES, browseOperatorPrompt, operatorScreenLines,
  type BrowserBrowseHistoryEntry, type BrowserOperatorHistoryEntry, type BrowserPageSnapshot,
} from './browser-browse'
import { workOperatorPrompt, workPreviewOperatorPrompt, type OperatorToolLines } from './browser-frame-writes'

export const BROWSER_OPERATOR_TOOLSETS = ['current', 'compact'] as const
export type BrowserOperatorToolset = typeof BROWSER_OPERATOR_TOOLSETS[number]
export const DEFAULT_BROWSER_OPERATOR_TOOLSET: BrowserOperatorToolset = 'current'

/** A stored or sent value as a tool set: anything unknown is the default (never a reason to stop a run). */
export const browserOperatorToolset = (v: unknown): BrowserOperatorToolset =>
  (BROWSER_OPERATOR_TOOLSETS as readonly unknown[]).includes(v) ? v as BrowserOperatorToolset : DEFAULT_BROWSER_OPERATOR_TOOLSET

/** The member's words of the setting (Settings → ブラウザ操作 → 「係の道具」). */
export const BROWSER_TOOLSET_WORDS = {
  heading: '係の道具',
  intro: 'サイトを操作する AI（係）に、どんな形で道具を渡すかを選べます。この PC だけの設定です。どちらでも、AI ができることと、アプリの守りは同じです。変わるのは AI への説明の書き方だけです。',
  names: { current: 'いまの形', compact: 'まとめた形' } satisfies Record<BrowserOperatorToolset, string>,
  details: {
    current: '押す・入れる・選ぶ・移る・戻る・待つを、別々の道具として渡します。',
    compact: '入れると選ぶを1つに、戻るを移るにまとめて、説明を短くします。試している形です。',
  } satisfies Record<BrowserOperatorToolset, string>,
  failed: '保存できませんでした。もう一度お試しください。',
} as const

/** The window-tool prompts a set has (the preview of declared reads has no window tools: one prompt for every set). */
export type BrowserToolsetPrompt = 'browse' | 'work-preview' | 'work'

/** The compact set's action lines: one word to put a value in, `go` for back too. */
const COMPACT_ACTION_LINES: readonly string[] = [
  '{"do":"click","ref":<ref>} か {"do":"click","x":<画素>,"y":<画素>}',
  '{"do":"set","ref":<ref。省くといまの入力欄>,"value":"<入れる文字か、options のどれか>"}',
  '{"do":"go","path":"/<同じサイトのアドレス>|back"}、{"do":"wait","seconds":<1〜5>}',
]

const LINES: Readonly<Record<BrowserOperatorToolset, OperatorToolLines>> = {
  current: { actions: OPERATOR_ACTION_LINES, screen: OPERATOR_SCREEN_LINES },
  compact: { actions: COMPACT_ACTION_LINES, screen: operatorScreenLines('set') },
}

const PROMPTS: Readonly<Record<BrowserOperatorToolset, Readonly<Record<BrowserToolsetPrompt, string>>>> = Object.fromEntries(
  BROWSER_OPERATOR_TOOLSETS.map(set => [set, {
    browse: browseOperatorPrompt(LINES[set]),
    'work-preview': workPreviewOperatorPrompt(LINES[set]),
    work: workOperatorPrompt(LINES[set]),
  }]),
) as Record<BrowserOperatorToolset, Record<BrowserToolsetPrompt, string>>

/** The fixed system prompt of a window-tool step in a set. */
export const browserToolsetPrompt = (set: BrowserOperatorToolset, prompt: BrowserToolsetPrompt): string => PROMPTS[set][prompt]

/** The words a set does not have: an answer naming one is refused as an unknown `do` (`shape`), as any other word. */
const NOT_IN: Readonly<Record<BrowserOperatorToolset, readonly string[]>> = { current: ['set'], compact: ['type', 'select', 'back'] }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * The operator's answer text in a set → the answer text in today's words, for the one parser; or a problem (an answer in a
 * word the set does not have). Text that is no JSON object goes on unchanged (the parser says why). In `compact`:
 * - `set` with a `ref` of a select on the page shown → `select` (`value` → `option`); any other `set` → `type` (`value` →
 *   `text`; without a ref, the focused field) — the parser then refuses a wrong role, a password field, an option not
 *   offered, a text too long, exactly as for today's words;
 * - `go` with `path: "back"` → `back` (the parser then refuses any other key);
 * - a key the translation would write already there (`text`, `option`) → `keys`, never overwritten.
 */
export function readToolsetAnswer(set: BrowserOperatorToolset, text: string, page: BrowserPageSnapshot | null): { text: string } | { problem: 'shape' | 'keys' } {
  let v: unknown
  try { v = JSON.parse(text.trim()) } catch { return { text } }
  if (!isMap(v) || typeof v.do !== 'string') return { text }
  if (NOT_IN[set].includes(v.do)) return { problem: 'shape' }
  if (set === 'current') return { text }
  const rest: Record<string, unknown> = { ...v }
  if (v.do === 'set') {
    const select = Number.isSafeInteger(v.ref) && page?.elements.some(e => e.ref === v.ref && e.role === 'select')
    const to = select ? 'option' : 'text'
    if (own(v, 'text') || own(v, 'option')) return { problem: 'keys' }
    delete rest.value
    return { text: JSON.stringify({ ...rest, do: select ? 'select' : 'type', ...(own(v, 'value') ? { [to]: v.value } : {}) }) }
  }
  if (v.do === 'go' && v.path === 'back') {
    delete rest.path
    return { text: JSON.stringify({ ...rest, do: 'back' }) }
  }
  return { text }
}

/** Today's action word as a set says it (the history the operator is shown). */
const HISTORY_WORDS: Readonly<Record<BrowserOperatorToolset, Partial<Record<BrowserBrowseHistoryEntry['do'], string>>>> = {
  current: {},
  compact: { type: 'set', select: 'set', back: 'go' },
}

/** The history as the operator of a set is shown it: each `do` in its set's words, the rest unchanged. */
export function toolsetHistory(set: BrowserOperatorToolset, history: readonly BrowserBrowseHistoryEntry[]): BrowserOperatorHistoryEntry[] {
  const words = HISTORY_WORDS[set]
  return history.map(h => ({ ...h, do: words[h.do] ?? h.do }))
}
