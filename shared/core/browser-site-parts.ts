/**
 * A registered domain's parts settings (「ブラウザ操作」 › a domain's 「詳しい設定」, redesign step ②,
 * agent-browser.md "A domain's parts and login helpers"): the hosts its pages load parts from (images,
 * fonts, scripts, styles: GET / HEAD only, never a page, a frame, a fetch or a write — the window's rule,
 * `decideBrowserRequest`) and the hosts a person's login needs (`BrowserLoginHelper`: only while a person
 * logs in, never while the AI operates — `decideLoginHelper` in the app). Company data entered by an
 * owner / admin (the FDE) after reading a recording, so a new site works without a new app release; it
 * replaces, per domain, what the app's bundled declaration lends (kept only as a fallback until step ⑦).
 *
 * One copy of the rule, for the server (saving, the policy), the admin console (the form) and the app (what
 * it takes from the policy): every host in its very spelling (`normalizeBrowserHost`, no `*.`), never a
 * host the company registered as a domain it operates (an operated domain cannot be lent to another one as
 * a part), never twice, a login helper never also a parts host (one host, one rule). Knows no site.
 */
import { normalizeBrowserHost } from './browser-operation'
import { BROWSER_DECLARATION_LIMITS, BROWSER_LOGIN_HELPER_PATH_RE, type BrowserLoginHelper } from './plugin-browser-declaration'

export interface BrowserSiteParts {
  /** The registered domain these settings belong to (one of the company's operated hosts). */
  host: string
  /** Hosts its pages load parts from: GET / HEAD of script, stylesheet, font and image only. */
  assetHosts: string[]
  /** Hosts a person's login needs, each narrowed to a path; never used while the AI operates. */
  loginHelpers: BrowserLoginHelper[]
}

/** The same limits as a reviewed declaration's (`BROWSER_DECLARATION_LIMITS`). */
export const BROWSER_SITE_PARTS_LIMITS = {
  assetHosts: BROWSER_DECLARATION_LIMITS.assetHosts,
  loginHelpers: BROWSER_DECLARATION_LIMITS.loginHelpers,
  loginHelperPath: BROWSER_DECLARATION_LIMITS.loginHelperPath,
} as const

/**
 * Why a setting is refused (the admin's words are keyed by it; `at` names the host or path concerned):
 * - `shape`: not the shape (unknown or missing keys, wrong types)
 * - `not-registered`: `host` is not a domain the company registered
 * - `bad-host`: a host not in its exact spelling (`*.`, an IP, localhost, a scheme, upper case…)
 * - `operated`: a domain the company registered, used as a part or a login helper
 * - `twice`: the same host twice, or a login helper's host also a parts host
 * - `too-many`: more than the limits
 * - `bad-path`: a login helper's path is not `/whole/segments/`
 */
export type BrowserSitePartsProblem = 'shape' | 'not-registered' | 'bad-host' | 'operated' | 'twice' | 'too-many' | 'bad-path'

export type BrowserSitePartsResult =
  | { value: BrowserSiteParts }
  | { error: string; problem: BrowserSitePartsProblem; at?: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[], required: readonly string[]) =>
  Object.keys(v).every(k => keys.includes(k)) && required.every(k => k in v)
const exactHost = (v: unknown): string | undefined => {
  const host = normalizeBrowserHost(v)
  return host !== undefined && host === v ? host : undefined
}

/**
 * Validate one domain's parts settings against the company's registered (operated) hosts. Strict: every key
 * required, nothing else; every host exact; no registered host anywhere but `host`; nothing twice.
 */
export function parseBrowserSiteParts(input: unknown, operatedHosts: readonly string[]): BrowserSitePartsResult {
  const refuse = (problem: BrowserSitePartsProblem, error: string, at?: string): BrowserSitePartsResult => ({ error, problem, ...(at !== undefined ? { at } : {}) })
  if (!isObject(input) || !onlyKeys(input, ['host', 'assetHosts', 'loginHelpers'], ['host', 'assetHosts', 'loginHelpers'])) return refuse('shape', 'site parts must be { host, assetHosts, loginHelpers }')
  const host = exactHost(input.host)
  if (!host || !operatedHosts.includes(host)) return refuse('not-registered', 'host must be a registered site')
  if (!Array.isArray(input.assetHosts) || !Array.isArray(input.loginHelpers)) return refuse('shape', 'assetHosts and loginHelpers must be arrays')
  if (input.assetHosts.length > BROWSER_SITE_PARTS_LIMITS.assetHosts) return refuse('too-many', `assetHosts: at most ${BROWSER_SITE_PARTS_LIMITS.assetHosts} entries`)
  if (input.loginHelpers.length > BROWSER_SITE_PARTS_LIMITS.loginHelpers) return refuse('too-many', `loginHelpers: at most ${BROWSER_SITE_PARTS_LIMITS.loginHelpers} entries`)
  const assetHosts: string[] = []
  for (const item of input.assetHosts) {
    const asset = exactHost(item)
    if (!asset) return refuse('bad-host', 'assetHosts: invalid entry', typeof item === 'string' ? item : undefined)
    // A domain the company operates is never another domain's part: it would lend that domain's pages to this window.
    if (operatedHosts.includes(asset)) return refuse('operated', 'assetHosts: a registered site cannot be a parts host', asset)
    if (assetHosts.includes(asset)) return refuse('twice', 'assetHosts: listed twice', asset)
    assetHosts.push(asset)
  }
  const loginHelpers: BrowserLoginHelper[] = []
  for (const item of input.loginHelpers) {
    if (!isObject(item) || !onlyKeys(item, ['host', 'pathPrefix', 'frame', 'post'], ['host', 'pathPrefix', 'frame', 'post'])
      || typeof item.frame !== 'boolean' || typeof item.post !== 'boolean') {
      return refuse('shape', 'loginHelpers: each is { host, pathPrefix, frame, post }')
    }
    const helper = exactHost(item.host)
    if (!helper) return refuse('bad-host', 'loginHelpers: invalid host', typeof item.host === 'string' ? item.host : undefined)
    if (operatedHosts.includes(helper)) return refuse('operated', 'loginHelpers: a registered site cannot be a login helper', helper)
    if (assetHosts.includes(helper) || loginHelpers.some(h => h.host === helper)) return refuse('twice', 'loginHelpers: one rule per host', helper)
    const prefix = item.pathPrefix
    if (typeof prefix !== 'string' || prefix.length > BROWSER_SITE_PARTS_LIMITS.loginHelperPath || !BROWSER_LOGIN_HELPER_PATH_RE.test(prefix)) {
      return refuse('bad-path', 'loginHelpers: pathPrefix must be /whole/segments/', helper)
    }
    loginHelpers.push({ host: helper, pathPrefix: prefix, frame: item.frame, post: item.post })
  }
  return { value: { host, assetHosts, loginHelpers } }
}

/** Nothing set: the domain falls back to what the app carries (the server stores no row for it). */
export function browserSitePartsEmpty(parts: Pick<BrowserSiteParts, 'assetHosts' | 'loginHelpers'>): boolean {
  return parts.assetHosts.length === 0 && parts.loginHelpers.length === 0
}

/**
 * The parts settings of a list, each re-checked against the registered hosts now (a domain registered after
 * a setting was saved makes that setting invalid): the valid ones, one per registered host, in the given order.
 * Used by the server for the policy and by the app for what it takes from the policy.
 */
export function validBrowserSiteParts(list: unknown, operatedHosts: readonly string[]): { valid: BrowserSiteParts[]; dropped: number } {
  if (!Array.isArray(list)) return { valid: [], dropped: 0 }
  const valid: BrowserSiteParts[] = []
  let dropped = 0
  for (const item of list) {
    const parsed = parseBrowserSiteParts(item, operatedHosts)
    if ('error' in parsed || valid.some(v => v.host === parsed.value.host) || browserSitePartsEmpty(parsed.value)) dropped += 1
    else valid.push(parsed.value)
  }
  return { valid, dropped }
}
