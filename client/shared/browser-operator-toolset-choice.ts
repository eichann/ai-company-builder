/**
 * Which tool set 「ブラウザ操作」's operator is told its actions in (agent-browser.md "The operator's tool sets"): the list,
 * this PC's setting read, and the member's words. A leaf (no import), so the card's trail, the settings and the reading
 * of answers (`browser-operator-toolsets.ts`) share one list without a cycle.
 */
export const BROWSER_OPERATOR_TOOLSETS = ['current', 'compact', 'playwright', 'openai', 'anthropic'] as const
export type BrowserOperatorToolset = typeof BROWSER_OPERATOR_TOOLSETS[number]
export const DEFAULT_BROWSER_OPERATOR_TOOLSET: BrowserOperatorToolset = 'current'

/** A stored or sent value as a tool set: anything unknown is the default (never a reason to stop a run). */
export const browserOperatorToolset = (v: unknown): BrowserOperatorToolset =>
  (BROWSER_OPERATOR_TOOLSETS as readonly unknown[]).includes(v) ? v as BrowserOperatorToolset : DEFAULT_BROWSER_OPERATOR_TOOLSET

/** The member's words of the setting (Settings → ブラウザ操作 → 「係の道具」) and of the card's trail. */
export const BROWSER_TOOLSET_WORDS = {
  heading: '係の道具',
  intro: 'サイトを操作する AI（係）に、どんな形で道具を渡すかを選べます。この PC だけの設定です。どの形でも、AI ができることと、アプリの守りは同じです。変わるのは AI への説明の書き方だけです。',
  names: {
    current: 'いまの形', compact: 'まとめた形', playwright: 'Playwright 風', openai: 'OpenAI 風', anthropic: 'Anthropic 風',
  } satisfies Record<BrowserOperatorToolset, string>,
  details: {
    current: '押す・入れる・選ぶ・移る・戻る・待つを、別々の道具として渡します。',
    compact: '入れると選ぶを1つに、戻るを移るにまとめて、説明を短くします。試している形です。',
    playwright: 'Playwright MCP の道具の名前と形（browser_click など）で渡します。試している形です。',
    openai: 'OpenAI の computer use の形（画面の位置を押す click など）で渡します。試している形です。',
    anthropic: 'Anthropic の computer use の形（画面の位置を押す left_click など）で渡します。試している形です。',
  } satisfies Record<BrowserOperatorToolset, string>,
  failed: '保存できませんでした。もう一度お試しください。',
} as const
