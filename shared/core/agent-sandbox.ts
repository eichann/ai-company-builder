/**
 * The company's AI sandbox setting (「AI の囲い」) — one copy of its shape and
 * validation for the server (storage, `GET /me/agent-policy`), the admin
 * console (the page that edits it) and the desktop app (which turns it into
 * each agent's own sandbox configuration, client/shared/agents/sandbox-policy.ts).
 *
 * The app does not build an OS sandbox of its own: it hands this policy to
 * Claude Code's and Codex's built-in sandboxes (owner decision 2026-10-25,
 * 「公式の部品で外から包む」).
 */

/**
 * - `off`: the agents run as before.
 * - `observe`: nothing is blocked; the action log marks what `enforce` would
 *   have blocked (commands reaching a host outside the list, reads of secret
 *   places), so the list can be tuned before anyone is stopped.
 * - `enforce`: commands the AI runs reach only the allowed hosts and cannot
 *   read the denied places.
 */
export type AgentSandboxMode = 'off' | 'observe' | 'enforce'
export const AGENT_SANDBOX_MODES: readonly AgentSandboxMode[] = ['off', 'observe', 'enforce']

/**
 * What the app does when `enforce` applies but this computer cannot start the
 * sandbox (Windows, an old CLI, a profile the member's own config switches
 * off): `record-only` = run as in `observe` (owner decision: the first
 * stage), `stop` = do not start the AI.
 */
export type AgentSandboxUnavailable = 'record-only' | 'stop'
export const AGENT_SANDBOX_UNAVAILABLE: readonly AgentSandboxUnavailable[] = ['record-only', 'stop']

export interface AgentSandboxSettings {
  mode: AgentSandboxMode
  /** Hosts commands may reach (`example.com`, or `*.example.com` for its subdomains). */
  allowedDomains: string[]
  /** Extra places the AI may not read, absolute (`/x`) or in the home folder (`~/x`). */
  deniedReadPaths: string[]
  onUnavailable: AgentSandboxUnavailable
}

/**
 * The starting list (owner decision 2026-10-25, findings §H.2): what the
 * company's skills reach today — Gemini / Vertex / Google APIs, Apps Script,
 * Cloudflare R2, GitHub, npm and PyPI, HubSpot. The ACB server itself is
 * always added by the app. Each company edits its own copy in the admin.
 */
export const DEFAULT_SANDBOX_ALLOWED_DOMAINS: readonly string[] = [
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'sheets.googleapis.com',
  'script.google.com',
  'script.googleusercontent.com',
  '*.r2.cloudflarestorage.com',
  'api.github.com',
  'github.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'api.hubapi.com',
]

export const DEFAULT_AGENT_SANDBOX_SETTINGS: AgentSandboxSettings = {
  mode: 'off',
  allowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS],
  deniedReadPaths: [],
  onUnavailable: 'record-only',
}

export const AGENT_SANDBOX_LIMITS = {
  domains: 200,
  domainLength: 253,
  paths: 100,
  pathLength: 1024,
} as const

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A host as both sandboxes take it, or undefined: lower case, no scheme,
 * port, path or user; at least two labels; an optional leading `*.` (its
 * subdomains). `*` alone, IP literals and `localhost` are refused — a
 * command reaching this computer's own services is not what the list is for.
 */
export function normalizeSandboxDomain(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  let value = input.trim().toLowerCase()
  if (!value || value.length > AGENT_SANDBOX_LIMITS.domainLength) return undefined
  if (value.endsWith('.')) value = value.slice(0, -1)
  const wildcard = value.startsWith('*.')
  const host = wildcard ? value.slice(2) : value
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every(label => LABEL.test(label))) return undefined
  if (labels.every(label => /^\d+$/.test(label))) return undefined
  if (host === 'localhost' || host.endsWith('.localhost')) return undefined
  if (/^\d+$/.test(labels[labels.length - 1])) return undefined
  return wildcard ? `*.${host}` : host
}

/**
 * A denied place as the app stores it, or undefined: `/abs/path` or
 * `~/path` (`~` alone is refused: the whole home folder would stop most
 * tools — findings §H), no `..` / `.` segments, no glob characters, no
 * control characters; NFC, without a trailing `/`.
 */
export function normalizeDeniedReadPath(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  let value = input.trim().normalize('NFC')
  if (!value || value.length > AGENT_SANDBOX_LIMITS.pathLength) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f*?[\]{}\\]/.test(value)) return undefined
  if (!value.startsWith('/') && !value.startsWith('~/')) return undefined
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  const segments = value.split('/').slice(1)
  if (segments.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  if (value === '~' || value === '/') return undefined
  return value
}

function uniqueList(input: unknown, normalize: (value: unknown) => string | undefined, limit: number, what: string): { value: string[] } | { error: string } {
  if (!Array.isArray(input)) return { error: `${what} must be an array` }
  if (input.length > limit) return { error: `${what}: at most ${limit} entries` }
  const out: string[] = []
  for (const item of input) {
    const normalized = normalize(item)
    if (!normalized) return { error: `${what}: invalid entry` }
    if (!out.includes(normalized)) out.push(normalized)
  }
  return { value: out }
}

/** Validate a stored or submitted setting (every field required). */
export function parseAgentSandboxSettings(input: unknown): { value: AgentSandboxSettings } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'settings must be an object' }
  const body = input as Record<string, unknown>
  if (!AGENT_SANDBOX_MODES.includes(body.mode as AgentSandboxMode)) return { error: 'mode must be off, observe or enforce' }
  if (!AGENT_SANDBOX_UNAVAILABLE.includes(body.onUnavailable as AgentSandboxUnavailable)) return { error: 'onUnavailable must be record-only or stop' }
  const domains = uniqueList(body.allowedDomains, normalizeSandboxDomain, AGENT_SANDBOX_LIMITS.domains, 'allowedDomains')
  if ('error' in domains) return domains
  const paths = uniqueList(body.deniedReadPaths, normalizeDeniedReadPath, AGENT_SANDBOX_LIMITS.paths, 'deniedReadPaths')
  if ('error' in paths) return paths
  return { value: { mode: body.mode as AgentSandboxMode, allowedDomains: domains.value, deniedReadPaths: paths.value, onUnavailable: body.onUnavailable as AgentSandboxUnavailable } }
}

/** Does `host` match an allowed entry (`*.x` = subdomains of x, not x itself)? */
export function sandboxAllowsHost(allowed: readonly string[], host: string): boolean {
  const value = host.trim().toLowerCase().replace(/\.$/, '')
  if (!value) return false
  return allowed.some(entry => entry.startsWith('*.') ? value.endsWith(entry.slice(1)) : value === entry)
}
