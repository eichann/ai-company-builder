/**
 * The app's browser window for 「ブラウザ操作」 (agent-browser.md "The app's
 * window"): the IPC payloads and the pure rules the shell's window applies
 * (client/electron/browser-window.ts). Pure (no Node, DOM or Electron), so the
 * rules are tested under Node and the real-Electron test checks the wiring.
 */
import {
  decideBrowserRequest, normalizeBrowserHost,
  type BrowserRequest, type BrowserRequestRefusal, type BrowserSiteSetting,
} from '../../shared/core/browser-operation'
import { METHOD_OVERRIDE_HEADERS } from '../../shared/core/plugin-browser-declaration'
import type { AgentStopPolicy } from '../../shared/types/agent-stop'

// ---------------------------------------------------------------------------
// IPC payloads (browser:sites / browser:open / browser:clearLogin)
// ---------------------------------------------------------------------------

/** One site the member may open, as the settings show it. */
export interface BrowserSiteView {
  host: string
  /** True: the login is kept after the app quits (the member's AI sandbox is 「囲う」). */
  loginKept: boolean
}

/** The member's sites now: empty when 「ブラウザ操作」 is off, unknown or the policy could not be read. */
export interface BrowserSitesResult {
  sites: BrowserSiteView[]
}

export type BrowserActionResult = { ok: true } | { ok: false; message: string }

export const BROWSER_WORDS = {
  section: 'ブラウザ操作',
  intro: '会社が許可したサイトを、アプリの中の窓で開けます。ログインはご自分でしてください。',
  aiNotYet: 'AI はまだこの窓を操作しません。',
  loginNotKept: 'アプリを開き直すと、もう一度ログインが必要です。',
  open: '開いてログイン',
  clearLogin: 'ログインを消す',
  cleared: 'このサイトのログインを消しました。',
  none: 'いま開けるサイトはありません。',
  notAllowed: 'このサイトは、いまは開けません。会社の設定が変わった可能性があります。',
} as const

// ---------------------------------------------------------------------------
// The window's one request rule
// ---------------------------------------------------------------------------

/**
 * - `human`: the member operates; their own writes to the operated host go out as in any browser.
 * - `ai`: every write to the operated host must pass the write gate (`decideAiWrite`).
 */
export type BrowserWindowMode = 'human' | 'ai'

export interface BrowserWindowState {
  /** The window's site; null once the window is closed (its session then refuses everything). */
  site: BrowserSiteSetting | null
  mode: BrowserWindowMode
  /** `ai` mode: the write gate (DevTools Fetch interception) is attached and sees the window's requests. */
  aiGateReady: boolean
}

export interface BrowserWindowRequest extends BrowserRequest {
  /** The request came from this window's own page (its webContents), not a service worker or another context. */
  fromWindow: boolean
}

export type BrowserWindowRefusal = BrowserRequestRefusal | 'closed' | 'ai-websocket' | 'ai-unchecked-write'
export type BrowserWindowDecision = { allow: true } | { allow: false; reason: BrowserWindowRefusal }

const READ_METHODS = new Set(['GET', 'HEAD'])
export const isReadMethod = (method: string): boolean => READ_METHODS.has(method.toUpperCase())

/**
 * Every request of a browser window's session passes here (the session's one
 * `onBeforeRequest`). The site's rule (`decideBrowserRequest`) first; then in
 * `ai` mode no WebSocket to the operated host (no operation type declares one)
 * and no write the gate cannot see: before the gate is attached, or from
 * outside the window's page (a service worker is not in the gate's view).
 */
export function decideWindowRequest(state: BrowserWindowState, request: BrowserWindowRequest): BrowserWindowDecision {
  if (!state.site) return { allow: false, reason: 'closed' }
  const decided = decideBrowserRequest(state.site, request)
  if (!decided.allow) return decided
  if (state.mode === 'ai' && decided.use === 'operate') {
    if (request.resourceType === 'webSocket' || /^wss:/i.test(request.url)) return { allow: false, reason: 'ai-websocket' }
    if (!isReadMethod(request.method) && (!request.fromWindow || !state.aiGateReady)) return { allow: false, reason: 'ai-unchecked-write' }
  }
  return { allow: true }
}

/**
 * Where a frame of the window may navigate: https on the operated host, its
 * default port, no user in the address. A subframe may also be an empty
 * document (`about:blank`, `about:srcdoc`: nothing is fetched). Everything
 * else — another host, `http:`, `file:`, `javascript:`, a custom scheme — is
 * refused and never handed to the system (no external browser, no app).
 */
export function navigationAllowed(site: BrowserSiteSetting, url: string, mainFrame: boolean): boolean {
  if (!mainFrame && (url === 'about:blank' || url === 'about:srcdoc')) return true
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) return false
  return normalizeBrowserHost(parsed.hostname) === site.host
}

/** The host to name in a log line about a refused address: never its path, query or body. */
export function hostForLog(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname || parsed.protocol.replace(/:$/, '')
  } catch {
    return '(unreadable)'
  }
}

/** Refusals counted per host and reason, logged in one line each (no address, query or body). */
export function createRefusalTally() {
  const counts = new Map<string, number>()
  return {
    add(host: string, reason: string) {
      const key = `${host}\0${reason}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    },
    /** The lines to log since the last drain, then empty. */
    drain(): string[] {
      const lines = [...counts].map(([key, n]) => {
        const [host, reason] = key.split('\0')
        return `refused ${n} request(s) to ${host} (${reason})`
      })
      counts.clear()
      return lines
    },
  }
}

// ---------------------------------------------------------------------------
// The `ai`-mode write gate
// ---------------------------------------------------------------------------

/** A write the window's page is about to send to the operated host, as the gate sees it. */
export interface BrowserWriteAttempt {
  method: string
  url: string
  headers: Record<string, string>
  /** The body as text, when the page sent one the gate could read. */
  body?: string
}

/**
 * Says yes to a write only when it is one an approved step declared (PR 5's
 * runner: `matchDeclaredWrite`, each declared write at most once).
 */
export type BrowserWriteDecider = (write: BrowserWriteAttempt) => boolean | Promise<boolean>

export type AiWriteRefusal = 'host' | 'stopped' | 'method-override' | 'no-step' | 'decider-refused' | 'decider-failed'
export type AiWriteDecision = { allow: true } | { allow: false; reason: AiWriteRefusal }

/**
 * The AI's operation of a site stops with the emergency stop of the whole AI and with a stop of
 * the `web` or `mcp-external` kind (it reaches a service outside, as a connector's read does).
 * Undefined (never received) stops nothing, as everywhere else (agent-stop.md).
 */
export function browserAiStopped(stop: AgentStopPolicy | undefined): boolean {
  return !!stop && (stop.all || stop.tools.includes('web') || stop.tools.includes('mcp-external'))
}

/**
 * The gate for one request of a window in `ai` mode. Reads (GET / HEAD) pass
 * (the request rule already limits where). A write passes only to the operated
 * host over https, while the AI is not stopped, without a method-override
 * header, and only when an approved step's decider says yes; no decider = no
 * write. A decider that throws refuses.
 */
export async function decideAiWrite(
  site: BrowserSiteSetting,
  write: BrowserWriteAttempt,
  decider: BrowserWriteDecider | undefined,
  stopped: boolean,
): Promise<AiWriteDecision> {
  if (isReadMethod(write.method)) return { allow: true }
  let url: URL
  try { url = new URL(write.url) } catch { return { allow: false, reason: 'host' } }
  if (url.protocol !== 'https:' || url.port !== '' || normalizeBrowserHost(url.hostname) !== site.host) return { allow: false, reason: 'host' }
  if (stopped) return { allow: false, reason: 'stopped' }
  if (Object.keys(write.headers).some(h => METHOD_OVERRIDE_HEADERS.includes(h.toLowerCase()))) return { allow: false, reason: 'method-override' }
  if (!decider) return { allow: false, reason: 'no-step' }
  try {
    return (await decider(write)) === true ? { allow: true } : { allow: false, reason: 'decider-refused' }
  } catch {
    return { allow: false, reason: 'decider-failed' }
  }
}
