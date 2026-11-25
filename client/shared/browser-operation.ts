/**
 * The app's browser window for 「ブラウザ操作」 (agent-browser.md "The app's
 * window"): the IPC payloads and the pure rules the shell's window applies
 * (client/electron/browser-window.ts). Pure (no Node, DOM or Electron), so the
 * rules are tested under Node and the real-Electron test checks the wiring.
 */
import {
  browserAiStopped, decideBrowserRequest, normalizeBrowserHost,
  type BrowserRequest, type BrowserRequestRefusal, type BrowserSiteSetting,
} from '../../shared/core/browser-operation'
import { METHOD_OVERRIDE_HEADERS, type BrowserLoginHelper } from '../../shared/core/plugin-browser-declaration'
import type { BrowserSiteParts } from '../../shared/core/browser-site-parts'
import type { BrowserPageReadAttempt } from './browser-runner'

// ---------------------------------------------------------------------------
// IPC payloads (browser:sites / browser:open / browser:clearLogin)
// ---------------------------------------------------------------------------

/**
 * One site the member may open, as the settings show it. `kept`: a login made in its window now is kept on
 * this PC across restarts (agent-browser.md "Keeping a login on disk"); false or absent = in memory only.
 */
export interface BrowserSiteView {
  host: string
  kept?: boolean
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
  /** The login is kept on this PC (agent-browser.md "Keeping a login on disk"). */
  loginKept: 'ログインはこの PC に覚えておくので、アプリを開き直してもそのままです。囲いのない AI がこの PC で動くときは、その前に消します。',
  /** An AI turn could not start because a kept login could not be removed first. */
  keptNotRemoved: 'この PC に覚えていたサイトのログインを消せなかったため、AI を始めませんでした。もう一度お試しください。',
  open: '開いてログイン',
  clearLogin: 'ログインを消す',
  cleared: 'このサイトのログインを消しました。',
  none: 'いま開けるサイトはありません。',
  clearFailed: 'ログインを消せませんでした。もう一度お試しください。',
  notAllowed: 'このサイトは、いまは開けません。会社の設定が変わった可能性があります。',
} as const

// ---------------------------------------------------------------------------
// The window's one request rule
// ---------------------------------------------------------------------------

/**
 * - `human`: the member operates (browses, logs in); their own writes to the operated host go out as in
 *   any browser, and the site's declared login helpers work (`decideLoginHelper`).
 * - `ai`: every write to the operated host must pass the write gate (`decideAiWrite`); login helpers
 *   are refused entirely.
 */
export type BrowserWindowMode = 'human' | 'ai'

export interface BrowserWindowState {
  /** The window's site; null once the window is closed (its session then refuses everything). */
  site: BrowserSiteSetting | null
  mode: BrowserWindowMode
  /** `ai` mode: the write gate (DevTools Fetch interception) is attached and sees the window's requests. */
  aiGateReady: boolean
  /** The site's declared login helpers (its bundled declaration's `login_helpers`; none = none). */
  helpers: readonly BrowserLoginHelper[]
}

export interface BrowserWindowRequest extends BrowserRequest {
  /** The request came from this window's own page (its webContents), not a service worker or another context. */
  fromWindow: boolean
  /**
   * The frame that sent it is one the page's write gate sees (`frameSeenByPageGate`: the operated origin,
   * in the main frame's process). False for another frame, or when the frame is not known (gone).
   */
  pageFrame: boolean
  /** The body as the network sees it (plain bytes only; undefined for a file, a blob or none). */
  body?: string
}

export type BrowserWindowRefusal = BrowserRequestRefusal | 'closed' | 'ai-websocket' | 'ai-unchecked-write' | 'ai-outside' | 'ai-other-frame' | LoginHelperRefusal
export type BrowserWindowDecision = { allow: true } | { allow: false; reason: BrowserWindowRefusal }

const READ_METHODS = new Set(['GET', 'HEAD'])
export const isReadMethod = (method: string): boolean => READ_METHODS.has(method.toUpperCase())

/**
 * Every request of a browser window's session passes here (the session's one
 * `onBeforeRequest`). The site's rule (`decideBrowserRequest`) first; then in
 * `ai` mode no WebSocket to the operated host (no operation type declares one);
 * nothing at all from outside the window's page (a service worker, which the
 * page's gate does not see: main never uses this session — its reads and writes
 * go through page-less sessions of their own, `browserReadPartition` /
 * `browserWritePartition` —, so no outside request here can be main's); and no
 * write of the page the gate cannot see (before the gate is attached), nor any
 * request of a frame the gate does not see (another origin or process: its own
 * DevTools target; the main frame's navigation is the page's own). In
 * `human` mode the site's rule alone: the member's own browsing, a worker's
 * request included, is theirs.
 */
export function decideWindowRequest(state: BrowserWindowState, request: BrowserWindowRequest): BrowserWindowDecision {
  if (!state.site) return { allow: false, reason: 'closed' }
  const decided = decideBrowserRequest(state.site, request)
  // What the site's rule refuses on a login helper's host is the helper rule's (human mode, under its
  // path), whatever the refusal: a host the site does not list, or a host the admin also lists as an
  // asset host (its GET of parts was already allowed above and stays so; the rest, such as the
  // CAPTCHA's frame, is the helper's). In ai mode the helper rule refuses all, so ai mode gets
  // nothing beyond the site's rule (agent-browser.md "Login helpers").
  if (!decided.allow) {
    const helper = loginHelperOf(state.helpers, request.url)
    return helper ? decideLoginHelper(state.mode, helper, request) : decided
  }
  if (state.mode === 'ai' && decided.use === 'operate') {
    if (request.resourceType === 'webSocket' || /^wss:/i.test(request.url)) return { allow: false, reason: 'ai-websocket' }
    // Same path as main's read or not: a page-less session reads for main, never this one (design memo §33 2-4).
    if (!request.fromWindow) return { allow: false, reason: isReadMethod(request.method) ? 'ai-outside' : 'ai-unchecked-write' }
    if (request.resourceType !== 'mainFrame' && !request.pageFrame) return { allow: false, reason: 'ai-other-frame' }
    if (!isReadMethod(request.method) && !state.aiGateReady) return { allow: false, reason: 'ai-unchecked-write' }
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

// ---------------------------------------------------------------------------
// Login helpers (agent-browser.md "Login helpers")
// ---------------------------------------------------------------------------

export type LoginHelperRefusal = 'ai-login-helper' | 'login-helper-path' | 'login-helper-use'

/** Percent-encoded `/` `\` `.`: a path that a server could read as leaving the prefix is never one of a helper's. */
const ENCODED_PATH_PART_RE = /%(2f|5c|2e)/i

/** Is the address on a declared helper's host, https and its default port, without a user? Then that helper. */
function helperHostOf(helpers: readonly BrowserLoginHelper[], url: string): { helper: BrowserLoginHelper; path: string } | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) return null
  const host = normalizeBrowserHost(parsed.hostname)
  const helper = host ? helpers.find(h => h.host === host) : undefined
  return helper ? { helper, path: parsed.pathname } : null
}

/**
 * The helper an address belongs to, or null. A helper's host outside its path prefix is still that
 * helper's host: `decideLoginHelper` then refuses it (`login-helper-path`), so the log says why.
 */
export function loginHelperOf(helpers: readonly BrowserLoginHelper[], url: string): (BrowserLoginHelper & { inPrefix: boolean }) | null {
  const found = helperHostOf(helpers, url)
  if (!found) return null
  const inPrefix = found.path.startsWith(found.helper.pathPrefix) && !ENCODED_PATH_PART_RE.test(found.path)
  return { ...found.helper, inPrefix }
}

const HELPER_READ_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'])

/**
 * One request to a declared login helper (the window's one rule for them; table-tested in
 * browser-login-helpers.test.ts). Only in `human` mode — while the AI operates every helper request
 * is refused (`ai-login-helper`) —, only from the window's own page, only under the path prefix; then
 * GET / HEAD of a page's parts and fetches, a frame only where the helper says `frame`, a POST only by
 * fetch / XHR and only where it says `post`. Never a top-level navigation, a WebSocket, a beacon or a
 * plug-in object.
 */
export function decideLoginHelper(
  mode: BrowserWindowMode,
  helper: BrowserLoginHelper & { inPrefix: boolean },
  request: { method: string; resourceType: string; fromWindow: boolean },
): BrowserWindowDecision {
  if (mode !== 'human') return { allow: false, reason: 'ai-login-helper' }
  if (!helper.inPrefix) return { allow: false, reason: 'login-helper-path' }
  if (!request.fromWindow) return { allow: false, reason: 'login-helper-use' }
  const method = request.method.toUpperCase()
  const type = request.resourceType
  if (type === 'subFrame') return helper.frame && method === 'GET' ? { allow: true } : { allow: false, reason: 'login-helper-use' }
  if (method === 'POST') return helper.post && type === 'xhr' ? { allow: true } : { allow: false, reason: 'login-helper-use' }
  if ((method === 'GET' || method === 'HEAD') && HELPER_READ_TYPES.has(type)) return { allow: true }
  return { allow: false, reason: 'login-helper-use' }
}

/**
 * Where a frame of the window may navigate now: the site's rule (`navigationAllowed`), and in `human`
 * mode a subframe also to a login helper that may be framed, under its prefix. Never the main frame.
 */
export function windowNavigationAllowed(state: BrowserWindowState, url: string, mainFrame: boolean): boolean {
  if (!state.site) return false
  if (navigationAllowed(state.site, url, mainFrame)) return true
  if (mainFrame || state.mode !== 'human') return false
  const helper = loginHelperOf(state.helpers, url)
  return !!helper && helper.frame && helper.inPrefix
}

/** The hosts the window's proxy sends DIRECT besides the site's: the login helpers', in `human` mode only. */
export function proxyHelperHosts(state: Pick<BrowserWindowState, 'mode' | 'helpers'>): string[] {
  return state.mode === 'human' ? state.helpers.map(h => h.host) : []
}

/** A frame as the window sees it: its origin (`null` when opaque) and its renderer process. */
export interface BrowserFrameFacts {
  origin: string
  processId: number
}

/**
 * Is this a frame whose requests the page's write gate sees? Only one of the operated origin exactly
 * (`https://<host>`; an empty document inherits it) in the main frame's process. Judged by origin and
 * process, never by address: an opaque frame (a sandboxed `srcdoc`, `data:`) or one of another site can
 * live in a process of its own — its own DevTools target, which the gate's Fetch does not see — whatever
 * its address says (agent-browser.md "Login helpers"). Unknown (null) is never one.
 */
export function frameSeenByPageGate(site: BrowserSiteSetting, mainProcessId: number, frame: BrowserFrameFacts | null): boolean {
  return !!frame && frame.processId === mainProcessId && frame.origin === `https://${site.host}`
}

/**
 * Frames that keep the AI from operating: every frame but the main one the page's write gate does not
 * see (`frameSeenByPageGate`) — a login helper's frame left from the login page, a sandboxed frame the
 * page made, anything else. Asked as the window enters `ai` mode and again by every check of the run up
 * to the last one right before the write leaves.
 */
export function foreignFrameCount(site: BrowserSiteSetting, mainProcessId: number, subframes: readonly BrowserFrameFacts[]): number {
  return subframes.filter(f => !frameSeenByPageGate(site, mainProcessId, f)).length
}

/**
 * The window's session proxy (a PAC script): the site's hosts go DIRECT, everything else to the
 * shell's own refusing proxy on 127.0.0.1 (`refusePort`). It reaches what the request hook cannot
 * see — preconnect, the Reporting API / NEL, WebRTC's TCP — since every connection of the session
 * asks the proxy. Hosts are the setting's (`normalizeBrowserHost`: [a-z0-9.-]) and are embedded as
 * JSON, so the script is data, never the setting's code.
 */
export function browserProxyScript(site: BrowserSiteSetting, refusePort: number, helperHosts: readonly string[] = []): string {
  if (!Number.isInteger(refusePort) || refusePort <= 0 || refusePort > 65535) throw new Error('bad refusing proxy port')
  const hosts = [site.host, ...site.assetHosts, ...helperHosts].map(h => normalizeBrowserHost(h)).filter((h): h is string => !!h)
  return `var DIRECT_HOSTS = ${JSON.stringify(hosts)};
function FindProxyForURL(url, host) {
  host = String(host).toLowerCase();
  if (host.charAt(host.length - 1) === '.') host = host.slice(0, -1);
  for (var i = 0; i < DIRECT_HOSTS.length; i++) if (DIRECT_HOSTS[i] === host) return 'DIRECT';
  return 'PROXY 127.0.0.1:${refusePort}';
}`
}

/**
 * The session a window's run writes through (`browser-window.ts`): one per window session, in memory,
 * named after it (so it is an `acb-browser-*` partition too).
 */
export function browserWritePartition(partition: string): string {
  return `${inMemory(partition)}-write`
}

/**
 * A page-less session is always in memory, also beside a window whose login is kept on disk (`persist:`,
 * agent-browser.md "Keeping a login on disk"): its name is the window's without the prefix.
 */
function inMemory(partition: string): string {
  return partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition
}

/**
 * The session main reads a window's site through (the preview's reads and the runner's, agent-browser.md
 * "The operator and the preview"): page-less, one per window session, in memory, named after it.
 */
export function browserReadPartition(partition: string): string {
  return `${inMemory(partition)}-read`
}

/** Response headers that register a reporting endpoint (Reporting API, NEL): never kept. */
const REPORTING_HEADERS = new Set(['report-to', 'reporting-endpoints', 'nel'])

/**
 * A response's headers as the window receives them: no reporting endpoint headers, and a document
 * (a frame's page) gets `X-DNS-Prefetch-Control: off`, so the page's links are not looked up ahead.
 */
export function browserResponseHeaders(headers: Record<string, string[]>, resourceType: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (REPORTING_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'x-dns-prefetch-control') continue
    out[name] = value
  }
  if (resourceType === 'mainFrame' || resourceType === 'subFrame') out['X-DNS-Prefetch-Control'] = ['off']
  return out
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

/**
 * Says yes to a read of the window's own page in `ai` mode during a run (the run's `pageRead`:
 * the page's parts, else a declared read path). None = every read passes, as outside a run.
 */
export type BrowserReadDecider = (read: BrowserPageReadAttempt) => boolean

/** The gate for one read (GET / HEAD) of the window's page in `ai` mode; reads of other hosts are the request hook's. */
export function decideAiRead(site: BrowserSiteSetting, read: BrowserPageReadAttempt, decider: BrowserReadDecider | undefined): boolean {
  if (!decider) return true
  let host: string | undefined
  try { host = normalizeBrowserHost(new URL(read.url).hostname) } catch { return false }
  if (host !== site.host) return true
  try { return decider(read) === true } catch { return false }
}

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

/** The one rule of which stops stop the AI's browser operation (shared with the server's plans: shared/core/browser-operation.ts). */
export { browserAiStopped }

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

/**
 * The site as its window applies it (agent-browser.md "Asset hosts"; owner decision 2026-11-23, plan B):
 * the asset hosts are the reviewed declaration's for the site's host (`declared`, from an approved and
 * carried bundled declaration only — main composes it), never the company's free-text list — that list is
 * a developer setting, added only when `developer` is true (a development build that asks for it). Each
 * kept host is exact (`normalizeBrowserHost`, its very spelling) and never the operated host; the rest of
 * the policy's site (host, level) is kept as it is.
 */
export function browserWindowSite(site: BrowserSiteSetting, declared: readonly string[], developer: boolean): BrowserSiteSetting {
  const assetHosts: string[] = []
  for (const host of [...declared, ...(developer ? site.assetHosts : [])]) {
    if (normalizeBrowserHost(host) === host && host !== site.host && !assetHosts.includes(host)) assetHosts.push(host)
  }
  return { host: site.host, level: site.level, assetHosts }
}

/** The site as its window applies it, with the login helpers it lends while a person logs in. */
export interface BrowserWindowSite extends BrowserSiteSetting {
  loginHelpers: BrowserLoginHelper[]
  /**
   * Which parts hosts may load scripts (`decideBrowserRequest`'s `scriptHosts`): set only for a domain the company
   * set — the hosts its admin marked 「プログラムも読み込む」 —, absent when the bundled declaration lends the parts.
   */
  scriptHosts?: string[]
}

/**
 * A registered domain's window site (redesign step ②, agent-browser.md "A domain's parts and login helpers"):
 * the parts hosts and login helpers come from the company's 「詳しい設定」 of that domain (`company`, from the
 * policy's `browserParts`) when it set one; otherwise — only until step ⑦ removes it — from the app's bundled,
 * approved declaration (`bundled`), and `from` says which (main logs it). Never both: once a company sets a
 * domain, the bundled ones no longer apply there. Whatever the source, no host the company registered as a
 * domain it operates (`operated`) is ever a part or a helper, a helper is never also a part, each host exact and
 * once (the core's rule, `parseBrowserSiteParts`, applied again here so a fallback obeys it too).
 */
export function browserWindowSiteFrom(
  site: BrowserSiteSetting,
  sources: { company: BrowserSiteParts | undefined; bundled: { assetHosts: readonly string[]; loginHelpers: readonly BrowserLoginHelper[] } },
  developer: boolean,
  operated: readonly string[],
): { site: BrowserWindowSite; from: 'company' | 'bundled' | 'none' } {
  const own = sources.company?.host === site.host ? sources.company : undefined
  const chosen = own ?? sources.bundled
  const base = browserWindowSite(site, chosen.assetHosts, developer)
  const assetHosts = base.assetHosts.filter(h => !operated.includes(h))
  const loginHelpers: BrowserLoginHelper[] = []
  for (const h of chosen.loginHelpers) {
    if (normalizeBrowserHost(h.host) !== h.host || h.host === site.host || operated.includes(h.host)) continue
    // One rule per host within the chosen source; a development build's extra parts host never drops a helper (the
    // window's precedence handles a host that is both: "Login helpers").
    if (chosen.assetHosts.includes(h.host) || loginHelpers.some(x => x.host === h.host)) continue
    loginHelpers.push({ host: h.host, pathPrefix: h.pathPrefix, frame: h.frame === true, post: h.post === true })
  }
  const from = own ? 'company' : (chosen.assetHosts.length > 0 || chosen.loginHelpers.length > 0 ? 'bundled' : 'none')
  // The company's parts load scripts only where its admin said so; a development build's extra hosts as before.
  const scriptHosts = own ? assetHosts.filter(h => own.scriptHosts.includes(h) || !own.assetHosts.includes(h)) : undefined
  return { site: { ...base, assetHosts, loginHelpers, ...(scriptHosts ? { scriptHosts } : {}) }, from }
}

/**
 * Whether this app adds the company's free-text asset hosts (the developer setting, agent-browser.md
 * "Asset hosts"): only an unpackaged (development) build **and** only when started with
 * `ACB_BROWSER_DEVELOPER_ASSET_HOSTS=1`. A released app never does, whatever its environment says.
 */
export function developerAssetHostsOn(build: { packaged: boolean }, env: Readonly<Record<string, string | undefined>>): boolean {
  return !build.packaged && env.ACB_BROWSER_DEVELOPER_ASSET_HOSTS === '1'
}
