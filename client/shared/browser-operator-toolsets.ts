/**
 * The operator's tool sets of 「ブラウザ操作」 (agent-browser.md "The operator's tool sets"; owner 2026-11-28: compare forms
 * on the real app, chosen per PC). A tool set changes only **what the operator is told** (its prompts' action and screen
 * lines, its history's words) and **how its answer is read** before the one parser of the window tools
 * (`parseBrowseAnswer` / `parseWorkAnswer`) takes it. Every answer of every set becomes one of today's actions
 * (`BrowserBrowseAction`), so everything after the parser — the window's checks before acting, the `ai` gate, holding each
 * page write and sending it once within the frames, the permits, the run's promise, the waits for a press's write, the run
 * log in today's words — is the same code for every set. What the operator can do is the same in every set; a set only
 * imitates the words and shapes of a known tool set (sources: the PR that added it).
 *
 * - `current`: today's words — click, type, select, go, back, wait.
 * - `compact`: click; `set` (into a field, or a choice of a select: the element decides); `go` (an address or `back`); wait.
 * - `playwright`: Playwright MCP's names and arguments — browser_click (`target`, `element`), browser_mouse_click_xy,
 *   browser_type, browser_select_option (`values`), browser_navigate (`url`), browser_navigate_back, browser_wait_for (`time`).
 * - `openai`: OpenAI computer use's actions — `{"type":"click","button":"left","x","y"}`, `type`, `wait` (2 s).
 * - `anthropic`: Anthropic computer use's actions — `{"action":"left_click","coordinate":[x,y]}`, `type`, `wait` (`duration`).
 * The two computer-use sets add the app's own `do` words for what the screen alone cannot reach: a press by ref (an element
 * off the screen), a choice of a select, an address of the site, back. Their `type` (and Playwright's browser_type without a
 * `target`) types into the field pressed just before — only when the last press (typing and waits aside) reached a text
 * field; otherwise the answer is refused (`focus`) and never guessed. The ends (done, stop, plan) are every set's.
 *
 * Pure; knows no site. The setting itself is this PC's (`config.json` `browserOperatorToolset`, default `current`).
 */
import {
  OPERATOR_ACTION_LINES, OPERATOR_MEMO_KEYS, OPERATOR_SCREEN_LINES, browseOperatorPrompt, operatorScreenLines,
  type BrowserBrowseHistoryEntry, type BrowserOperatorHistoryEntry, type BrowserPageSnapshot,
} from './browser-browse'
import { workOperatorPrompt, workPreviewOperatorPrompt, type OperatorToolLines } from './browser-frame-writes'
import { BROWSER_OPERATOR_TOOLSETS, type BrowserOperatorToolset } from './browser-operator-toolset-choice'

export {
  BROWSER_OPERATOR_TOOLSETS, BROWSER_TOOLSET_WORDS, DEFAULT_BROWSER_OPERATOR_TOOLSET, browserOperatorToolset, type BrowserOperatorToolset,
} from './browser-operator-toolset-choice'

/** The window-tool prompts a set has (the preview of declared reads has no window tools: one prompt for every set). */
export type BrowserToolsetPrompt = 'browse' | 'work-preview' | 'work'

/** The seconds an OpenAI-like `wait` (no duration of its own) waits. */
export const OPENAI_WAIT_SECONDS = 2

/** The computer-use sets' line for what the app adds in its own words (a press by ref, a choice, an address, back). */
const APP_EXTRA_LINE = 'アプリの道具：{"do":"click","ref":<ref>}、{"do":"select","ref":<ref>,"option":"<options のどれか>"}、{"do":"go","path":"/<同じサイトのアドレス>"}、{"do":"back"}'

const ACTION_LINES: Readonly<Record<BrowserOperatorToolset, readonly string[]>> = {
  current: OPERATOR_ACTION_LINES,
  compact: [
    '{"do":"click","ref":<ref>} か {"do":"click","x":<画素>,"y":<画素>}',
    '{"do":"set","ref":<ref。省くといまの入力欄>,"value":"<入れる文字（200字まで）か、options のどれか>"}',
    '{"do":"go","path":"/<同じサイトのアドレス>|back"}、{"do":"wait","seconds":<1〜5>}',
  ],
  playwright: [
    '{"do":"browser_click","target":<ref>,"element":"<説明>"}、{"do":"browser_mouse_click_xy","x":<画素>,"y":<画素>}',
    '{"do":"browser_type","target":<ref。省くと直前に押した入力欄>,"element":"<説明>","text":"<200字まで>"}',
    '{"do":"browser_select_option","target":<ref>,"element":"<説明>","values":["<options のどれか1つ>"]}',
    '{"do":"browser_navigate","url":"<このサイトの https のアドレス>"}、{"do":"browser_navigate_back"}、{"do":"browser_wait_for","time":<1〜5>}',
  ],
  openai: [
    '{"type":"click","button":"left","x":<画素>,"y":<画素>}、{"type":"type","text":"<200字まで>"}、{"type":"wait"}',
    APP_EXTRA_LINE,
  ],
  anthropic: [
    '{"action":"left_click","coordinate":[<x>,<y>]}、{"action":"type","text":"<200字まで>"}、{"action":"wait","duration":<1〜5>}',
    APP_EXTRA_LINE,
  ],
}

/** Each set's first screen line (how to press, what a typing without an element goes into); the others are every set's. */
const SCREEN_FIRST: Readonly<Record<BrowserOperatorToolset, string>> = {
  current: OPERATOR_SCREEN_LINES[0],
  compact: operatorScreenLines('set')[0],
  playwright: '画像の赤枠の番号が ref で、target に書く。番号のないものは browser_mouse_click_xy で画素の位置を押す（大きさは page.screen）。番号のない入力欄は押してから target なしで browser_type。',
  openai: 'x, y は画像の画素（大きさは page.screen）。type は直前に押した入力欄に入る。wait は2秒。画像の赤枠の番号が ref。',
  anthropic: 'coordinate は画像の画素（大きさは page.screen）。type は直前に押した入力欄に入る。duration は秒。画像の赤枠の番号が ref。',
}

const linesOf = (set: BrowserOperatorToolset): OperatorToolLines =>
  ({ actions: ACTION_LINES[set], screen: [SCREEN_FIRST[set], ...OPERATOR_SCREEN_LINES.slice(1)] })

const PROMPTS: Readonly<Record<BrowserOperatorToolset, Readonly<Record<BrowserToolsetPrompt, string>>>> = Object.fromEntries(
  BROWSER_OPERATOR_TOOLSETS.map(set => [set, {
    browse: browseOperatorPrompt(linesOf(set)),
    'work-preview': workPreviewOperatorPrompt(linesOf(set)),
    work: workOperatorPrompt(linesOf(set)),
  }]),
) as Record<BrowserOperatorToolset, Record<BrowserToolsetPrompt, string>>

/** The fixed system prompt of a window-tool step in a set. */
export const browserToolsetPrompt = (set: BrowserOperatorToolset, prompt: BrowserToolsetPrompt): string => PROMPTS[set][prompt]

// ── Reading an answer ───────────────────────────────────────────────────────────────────────────────────────────────

/** Why a set's answer is refused before the parser (each a code of `BROWSER_ANSWER_PROBLEMS`). */
export type ToolsetProblem = 'shape' | 'keys' | 'focus' | 'option' | 'path' | 'point'
type Read = { text: string } | { problem: ToolsetProblem }

const ENDS = ['done', 'stop', 'plan']
/** The `do` words a set's answer may carry (the ends included); any other `do` is an unknown word (`shape`). */
const DO_WORDS: Readonly<Record<Exclude<BrowserOperatorToolset, 'current'>, readonly string[]>> = {
  compact: ['click', 'set', 'go', 'wait', ...ENDS],
  playwright: [
    'browser_click', 'browser_mouse_click_xy', 'browser_type', 'browser_select_option', 'browser_navigate', 'browser_navigate_back',
    'browser_wait_for', ...ENDS,
  ],
  openai: ['click', 'select', 'go', 'back', ...ENDS],
  anthropic: ['click', 'select', 'go', 'back', ...ENDS],
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * The answer's keys renamed into today's: each key of `keys` goes to its new name (`null`: dropped — Playwright's
 * `element`, a description for a person), the memo keys are kept, the discriminator `skip` is left out, and any other key
 * refuses the answer (`keys`) — nothing unknown reaches the parser under another name.
 */
function renamed(v: Record<string, unknown>, skip: string, keys: Readonly<Record<string, string | null>>): Record<string, unknown> | null {
  const out: Array<[string, unknown]> = []
  for (const k of Object.keys(v)) {
    if (k === skip) continue
    if (OPERATOR_MEMO_KEYS.includes(k)) out.push([k, v[k]])
    else if (own(keys, k)) { const to = keys[k]; if (to !== null) out.push([to, v[k]]) }
    else return null
  }
  return Object.fromEntries(out)
}

/** Today's answer text with `do` first (its other keys as read). */
const as = (word: string, rest: Record<string, unknown>): Read => ({ text: JSON.stringify({ do: word, ...rest }) })

/**
 * A typing into "the field pressed just before": the last action that was neither a typing nor a wait must be a press that
 * reached a text field (`pressed.role` `textbox`: never a password field, which has its own role). The window still checks
 * the focused element before typing.
 */
export function pressedField(history: readonly BrowserBrowseHistoryEntry[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h.do === 'type' || h.do === 'wait') continue
    return h.do === 'click' && h.outcome === 'ok' && typeof h.pressed === 'object' && h.pressed.role === 'textbox'
  }
  return false
}

/** Playwright's `target` as a ref: the number, or its decimal spelling; anything else as given (the parser refuses it). */
const ref = (t: unknown): unknown => (typeof t === 'string' && /^\d{1,6}$/.test(t) ? Number(t) : t)

/** An `https` address of the run's domain (or a path) as a path of it; null when it is anything else (never guessed). */
function sitePath(url: unknown, host: string): string | null {
  if (typeof url !== 'string') return null
  if (url.startsWith('/')) return url
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' || u.host !== host || u.username || u.password || u.port || /#/.test(url)) return null
  // Only an address already in its plain form: nothing the URL reader would rewrite (`..`, a space, `\`) is taken.
  const path = `${u.pathname}${u.search}`
  return url === `https://${host}${path}` ? path : null
}

function readCompact(v: Record<string, unknown>, page: BrowserPageSnapshot | null): Read {
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
  return { text: JSON.stringify(v) }
}

function readPlaywright(v: Record<string, unknown>, ctx: ToolsetContext): Read {
  const keys = (map: Record<string, string | null>) => renamed(v, 'do', map)
  switch (v.do) {
    case 'browser_click': { const r = keys({ target: 'ref', element: null }); return r ? as('click', { ...r, ...(own(r, 'ref') ? { ref: ref(r.ref) } : {}) }) : { problem: 'keys' } }
    case 'browser_mouse_click_xy': { const r = keys({ x: 'x', y: 'y' }); return r ? as('click', r) : { problem: 'keys' } }
    case 'browser_type': {
      const r = keys({ target: 'ref', element: null, text: 'text' })
      if (!r) return { problem: 'keys' }
      if (own(r, 'ref')) return as('type', { ...r, ref: ref(r.ref) })
      return pressedField(ctx.history) ? as('type', r) : { problem: 'focus' }
    }
    case 'browser_select_option': {
      const r = keys({ target: 'ref', element: null, values: 'option' })
      if (!r) return { problem: 'keys' }
      if (!own(r, 'option')) return as('select', r)
      const values = r.option
      if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') return { problem: 'option' }
      return as('select', { ...r, ref: ref(r.ref), option: values[0] })
    }
    case 'browser_navigate': {
      const r = keys({ url: 'path' })
      if (!r) return { problem: 'keys' }
      if (!own(r, 'path')) return as('go', r)
      const path = sitePath(r.path, ctx.host)
      return path === null ? { problem: 'path' } : as('go', { ...r, path })
    }
    case 'browser_navigate_back': { const r = keys({}); return r ? as('back', r) : { problem: 'keys' } }
    case 'browser_wait_for': { const r = keys({ time: 'seconds' }); return r ? as('wait', r) : { problem: 'keys' } }
    default: return { text: JSON.stringify(v) }
  }
}

/** A computer-use set's own action (`type` for OpenAI, `action` for Anthropic) in today's words. */
function readComputerUse(set: 'openai' | 'anthropic', v: Record<string, unknown>, history: readonly BrowserBrowseHistoryEntry[]): Read {
  const key = set === 'openai' ? 'type' : 'action'
  const word = v[key]
  const keys = (map: Record<string, string | null>) => renamed(v, key, map)
  const typing = (): Read => {
    const r = keys({ text: 'text' })
    if (!r) return { problem: 'keys' }
    return pressedField(history) ? as('type', r) : { problem: 'focus' }
  }
  if (set === 'openai') {
    if (word === 'click') {
      const r = keys({ button: 'button', x: 'x', y: 'y' })
      if (!r) return { problem: 'keys' }
      if (own(r, 'button') && r.button !== 'left') return { problem: 'point' }
      delete r.button
      return as('click', r)
    }
    if (word === 'type') return typing()
    if (word === 'wait') { const r = keys({}); return r ? as('wait', { ...r, seconds: OPENAI_WAIT_SECONDS }) : { problem: 'keys' } }
    return { problem: 'shape' }
  }
  if (word === 'left_click') {
    const r = keys({ coordinate: 'coordinate' })
    if (!r) return { problem: 'keys' }
    const c = r.coordinate
    if (!Array.isArray(c) || c.length !== 2) return { problem: 'point' }
    delete r.coordinate
    return as('click', { ...r, x: c[0], y: c[1] })
  }
  if (word === 'type') return typing()
  if (word === 'wait') { const r = keys({ duration: 'seconds' }); return r ? as('wait', r) : { problem: 'keys' } }
  return { problem: 'shape' }
}

/** What reading an answer may look at: the page shown, the run's own history (today's words) and its domain. */
export interface ToolsetContext {
  page: BrowserPageSnapshot | null
  history: readonly BrowserBrowseHistoryEntry[]
  host: string
}

/**
 * The operator's answer text in a set → the answer text in today's words, for the one parser; or a problem. Text that is
 * no JSON object goes on unchanged (the parser says why). What the last press reached (`ctx.history`) decides where a
 * typing without an element goes; a Playwright-like address must be of the run's domain (`ctx.host`). In every set but `current`, a `do` word the set does not have
 * is an unknown word (`shape`), and a key the reading would write that is already there is refused (`keys`), never
 * overwritten — the parser then refuses a wrong role, a password field, an option not offered, a long text, another site,
 * exactly as for today's words.
 */
export function readToolsetAnswer(set: BrowserOperatorToolset, text: string, ctx: ToolsetContext): Read {
  if (set === 'current') return { text }
  let v: unknown
  try { v = JSON.parse(text.trim()) } catch { return { text } }
  if (!isMap(v)) return { text }
  if ((set === 'openai' || set === 'anthropic') && !own(v, 'do')) {
    return own(v, set === 'openai' ? 'type' : 'action') ? readComputerUse(set, v, ctx.history) : { problem: 'shape' }
  }
  if (typeof v.do !== 'string') return { text }
  if (!DO_WORDS[set].includes(v.do)) return { problem: 'shape' }
  if (set === 'compact') return readCompact(v, ctx.page)
  if (set === 'playwright') return readPlaywright(v, ctx)
  // A computer-use set's own `do` words: a press only by ref (a press at a point is its own `click` / `left_click`).
  if (v.do === 'click' && (own(v, 'x') || own(v, 'y'))) return { problem: 'keys' }
  return { text: JSON.stringify(v) }
}

// ── The history in a set's words ────────────────────────────────────────────────────────────────────────────────────

/** One entry as a set shows it: its action word under the set's key, a ref under the set's name for it. */
function shown(set: BrowserOperatorToolset, h: BrowserBrowseHistoryEntry): BrowserOperatorHistoryEntry {
  const { do: word, ref: r, ...rest } = h
  const byRef = r !== undefined
  const at = byRef ? { ref: r } : {}
  switch (set) {
    case 'current': return h
    case 'compact':
      if (word === 'type' || word === 'select') return { do: 'set', ...at, ...rest }
      if (word === 'back') return { do: 'go', ...rest, path: 'back' }
      return { do: word, ...at, ...rest }
    case 'playwright': {
      const target = byRef ? { target: r } : {}
      const names = {
        click: byRef ? 'browser_click' : 'browser_mouse_click_xy', type: 'browser_type', select: 'browser_select_option',
        go: 'browser_navigate', back: 'browser_navigate_back', wait: 'browser_wait_for',
      } as const
      return { do: names[word], ...target, ...rest }
    }
    case 'openai':
    case 'anthropic': {
      if ((word === 'click' && !byRef) || word === 'type' || word === 'wait') {
        return set === 'openai' ? { type: word, ...rest } : { action: word === 'click' ? 'left_click' : word, ...rest }
      }
      return { do: word, ...at, ...rest }
    }
  }
}

/** The history as the operator of a set is shown it: each action as that set's answer would say it, the rest unchanged. */
export function toolsetHistory(set: BrowserOperatorToolset, history: readonly BrowserBrowseHistoryEntry[]): BrowserOperatorHistoryEntry[] {
  return history.map(h => shown(set, h))
}
