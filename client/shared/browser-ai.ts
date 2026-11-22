/**
 * The build switch of the AI's browser operation (agent-browser.md "The operator and the preview",
 * design memo §33.3). PR 6b connects every path in the app but ships it switched off. Every 6b entry
 * asks the switch on its first line (`features/browser/ai-switch.ts`) and, while it is off, returns at
 * once: no page read, no CLI check or start, no server call, no send. The clean-up paths (cancel,
 * report, confirm, the waiting list, the card) never ask it.
 *
 * The build constant stays `false`: no build turns it on for everyone. 6c (owner decision 2026-11-22)
 * turns it on **for one PC only**, through the per-PC opt-in below, which the person creates by hand on
 * that PC (agent-browser.md "This PC's opt-in").
 *
 * `client/tests/browser-preview.test.ts` fails while this is anything but `false`.
 */
export const BROWSER_AI_BUILD_SWITCH = false as boolean

/** The opt-in's file, in the app's userData folder (never in a company folder). */
export const BROWSER_AI_OPT_IN_FILE = 'browser-ai-this-pc.json'
/** An opt-in names its own end; one further ahead than this is refused (a forgotten opt-in ends by itself). */
export const BROWSER_AI_OPT_IN_MAX_DAYS = 14
/** Larger than any real opt-in: refused without reading it. */
export const BROWSER_AI_OPT_IN_MAX_BYTES = 4096

/**
 * What a valid opt-in says, exactly these keys:
 *   { "browserAi": "this-pc", "server": "<the app's server origin>", "userId": "<the member's id>",
 *     "until": "<ISO time with its zone, in the future, at most 14 days ahead>" }
 * It is on only for that server and that signed-in member, and only until `until`.
 */
export interface BrowserAiOptIn {
  browserAi: 'this-pc'
  server: string
  userId: string
  until: string
}

const OPT_IN_KEYS: readonly (keyof BrowserAiOptIn)[] = ['browserAi', 'server', 'userId', 'until']
const USER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** The origin of an http(s) address without credentials, or null. */
export function serverOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.origin
  } catch { return null }
}

/**
 * Whether this opt-in text turns the AI's browser operation on now, for this server and this signed-in
 * member (pure; the file is read by `createThisPcSwitch`). Anything unexpected = off.
 */
export function browserAiOptInOn(text: string, now: { server: string; userId: string | null; at: number }): boolean {
  if (text.length > BROWSER_AI_OPT_IN_MAX_BYTES) return false
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return false }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const o = parsed as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== OPT_IN_KEYS.length || !OPT_IN_KEYS.every(k => keys.includes(k))) return false
  if (o.browserAi !== 'this-pc') return false
  if (typeof o.userId !== 'string' || !USER_ID_RE.test(o.userId) || o.userId !== now.userId) return false
  const mine = serverOrigin(now.server)
  if (typeof o.server !== 'string' || !mine || serverOrigin(o.server) !== mine) return false
  if (typeof o.until !== 'string' || !ISO_RE.test(o.until)) return false
  const until = Date.parse(o.until)
  return Number.isFinite(until) && until > now.at && until <= now.at + BROWSER_AI_OPT_IN_MAX_DAYS * 86_400_000
}
