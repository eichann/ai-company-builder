/**
 * The company's browser-operation setting (「ブラウザ操作」) — one copy of its
 * shape and of the rules every layer must apply alike: the server (storage,
 * `GET /me/agent-policy`), the admin console (the page that edits it) and the
 * desktop app (its in-app browser window and the operation runner).
 *
 * Owner decisions 2026-11-20 (internal design memo §2, §13, §17, §18):
 * - the AI operates only sites an admin allowed, and only through per-site
 *   operation types (never free clicking);
 * - each site has one host it operates (writes go only there) and asset hosts
 *   the page needs to draw itself (GET of scripts, styles, fonts, images);
 *   every other request is refused;
 * - the level per site caps what an operation type may do there;
 * - the login is kept on disk only for a member whose AI sandbox is
 *   `enforce`: otherwise the chat AI's commands could read it.
 */
import type { AgentSandboxMode } from './agent-sandbox'
import { normalizeSandboxDomain } from './agent-sandbox'

/** - `read`: 見るだけ, - `write`: 入力・保存まで, - `delete`: 削除も. */
export type BrowserOperationLevel = 'read' | 'write' | 'delete'
export const BROWSER_OPERATION_LEVELS: readonly BrowserOperationLevel[] = ['read', 'write', 'delete']

/** What one step of an operation type does to the site. */
export type BrowserOperationEffect = 'read' | 'write' | 'delete'

export interface BrowserSiteSetting {
  /** The host the AI operates (exact, no `*.`): the only host requests may change things on. */
  host: string
  level: BrowserOperationLevel
  /** Hosts the pages load parts from (exact): GET of scripts, styles, fonts and images only. */
  assetHosts: string[]
}

/** - `off`: nobody gets the browser window, - `on`: members the company lets use it. */
export type BrowserOperationMode = 'off' | 'on'
export const BROWSER_OPERATION_MODES: readonly BrowserOperationMode[] = ['off', 'on']

export interface BrowserOperationSettings {
  mode: BrowserOperationMode
  sites: BrowserSiteSetting[]
}

export const DEFAULT_BROWSER_OPERATION_SETTINGS: BrowserOperationSettings = { mode: 'off', sites: [] }

export const BROWSER_OPERATION_LIMITS = {
  sites: 50,
  assetHosts: 20,
} as const

/**
 * A host as the browser window compares it, or undefined: the sandbox's host
 * rules (lower case, ≥ 2 labels, no IP literal or `localhost`) without the
 * `*.` form — a wildcard would let one entry cover hosts nobody looked at.
 */
export function normalizeBrowserHost(input: unknown): string | undefined {
  const host = normalizeSandboxDomain(input)
  return host && !host.startsWith('*.') ? host : undefined
}

function parseSite(input: unknown): { value: BrowserSiteSetting } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'site must be an object' }
  const body = input as Record<string, unknown>
  const host = normalizeBrowserHost(body.host)
  if (!host) return { error: 'site host is invalid' }
  if (!BROWSER_OPERATION_LEVELS.includes(body.level as BrowserOperationLevel)) return { error: 'site level must be read, write or delete' }
  if (!Array.isArray(body.assetHosts)) return { error: 'assetHosts must be an array' }
  if (body.assetHosts.length > BROWSER_OPERATION_LIMITS.assetHosts) return { error: `assetHosts: at most ${BROWSER_OPERATION_LIMITS.assetHosts} entries` }
  const assetHosts: string[] = []
  for (const item of body.assetHosts) {
    const asset = normalizeBrowserHost(item)
    if (!asset) return { error: 'assetHosts: invalid entry' }
    // The operated host is never an asset host: it would read as two rules for one host.
    if (asset === host) return { error: 'assetHosts: the operated host cannot be an asset host' }
    if (!assetHosts.includes(asset)) assetHosts.push(asset)
  }
  return { value: { host, level: body.level as BrowserOperationLevel, assetHosts } }
}

/** Validate a stored or submitted setting (every field required; one entry per operated host). */
export function parseBrowserOperationSettings(input: unknown): { value: BrowserOperationSettings } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'settings must be an object' }
  const body = input as Record<string, unknown>
  if (!BROWSER_OPERATION_MODES.includes(body.mode as BrowserOperationMode)) return { error: 'mode must be off or on' }
  if (!Array.isArray(body.sites)) return { error: 'sites must be an array' }
  if (body.sites.length > BROWSER_OPERATION_LIMITS.sites) return { error: `sites: at most ${BROWSER_OPERATION_LIMITS.sites} entries` }
  const sites: BrowserSiteSetting[] = []
  for (const item of body.sites) {
    const site = parseSite(item)
    if ('error' in site) return site
    if (sites.some(s => s.host === site.value.host)) return { error: 'sites: one entry per host' }
    sites.push(site.value)
  }
  return { value: { mode: body.mode as BrowserOperationMode, sites } }
}

/** May an operation type with this effect run on a site at this level? */
export function levelAllows(level: BrowserOperationLevel, effect: BrowserOperationEffect): boolean {
  const l = BROWSER_OPERATION_LEVELS.indexOf(level)
  const e = BROWSER_OPERATION_LEVELS.indexOf(effect)
  // An unknown effect (a newer declaration) is never allowed; an unknown level (-1) is below every effect.
  return e >= 0 && l >= e
}

/** The request facts the browser window's one request hook knows (Electron's `resourceType` names). */
export interface BrowserRequest {
  url: string
  method: string
  resourceType: string
}

export type BrowserRequestRefusal = 'scheme' | 'port' | 'host' | 'asset-use' | 'bad-url'
export type BrowserRequestDecision = { allow: true; use: 'operate' | 'asset' } | { allow: false; reason: BrowserRequestRefusal }

const ASSET_RESOURCE_TYPES = new Set(['script', 'stylesheet', 'font', 'image'])
const ASSET_METHODS = new Set(['GET', 'HEAD'])

/**
 * Every request of the browser window of one site passes here (design memo
 * §17-3). HTTPS only (WSS to the operated host), default ports only; the
 * operated host is allowed any method — which writes may go out is decided
 * per operation type by the runner, not by host; an asset host only for GET /
 * HEAD of scripts, styles, fonts and images; anything else is refused,
 * including navigations, frames and fetches to asset hosts.
 */
export function decideBrowserRequest(site: BrowserSiteSetting, request: BrowserRequest): BrowserRequestDecision {
  let url: URL
  try { url = new URL(request.url) } catch { return { allow: false, reason: 'bad-url' } }
  if (url.username || url.password) return { allow: false, reason: 'bad-url' }
  const host = normalizeBrowserHost(url.hostname)
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') return { allow: false, reason: 'scheme' }
  if (url.port !== '') return { allow: false, reason: 'port' }
  if (host && host === site.host) return { allow: true, use: 'operate' }
  if (url.protocol === 'wss:' || !host || !site.assetHosts.includes(host)) return { allow: false, reason: 'host' }
  if (!ASSET_METHODS.has(request.method.toUpperCase()) || !ASSET_RESOURCE_TYPES.has(request.resourceType)) return { allow: false, reason: 'asset-use' }
  return { allow: true, use: 'asset' }
}

/**
 * Where the browser window keeps the site's login (design memo §18): on disk
 * only when the member's sandbox is `enforce` (the app's data is then out of
 * the AI's reach); otherwise in memory, gone when the app quits.
 */
export function browserLoginStorage(sandboxMode: AgentSandboxMode): 'disk' | 'memory' {
  return sandboxMode === 'enforce' ? 'disk' : 'memory'
}
