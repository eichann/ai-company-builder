/**
 * The company's AI sandbox setting (shared/core/agent-sandbox.ts) → each
 * agent's own built-in sandbox configuration (pure: no Node, Electron or SDK
 * imports; paths are POSIX — Windows is record-only, owner decision 2026-10-25).
 *
 * The app does not sandbox anything itself. It hands this to:
 * - Claude Code: the SDK `sandbox` option (the CLI's `--settings` layer) plus
 *   `permissions.deny` in the inline flag settings. Verified on CLI 2.1.304:
 *   with `strictAllowlist` and `allowUnsandboxedCommands: false` there, the
 *   company repository's `.claude/settings.json` can neither switch the
 *   sandbox off nor add hosts or readable paths, and bypassPermissions /
 *   `dangerouslyDisableSandbox` do not escape it. The sandbox covers Bash and
 *   its children only; the Read tool is covered by the `Read(...)` denies.
 * - Codex: a permission profile (`default_permissions` + `permissions.acb` +
 *   `features.network_proxy`) in the thread config. A legacy `sandbox` /
 *   `sandbox_mode` anywhere switches profiles off, so the caller must not
 *   pass one (and checks that the profile took effect).
 *
 * Findings and verification: `.claude/rules/agent-sandbox.md`.
 */

import { normalizeSandboxDomain, sandboxAllowsHost, type AgentSandboxSettings } from '../../../shared/core/agent-sandbox'

/**
 * Places no sandboxed AI command may read: SSH / cloud / package-registry
 * credentials, keychains, browser profiles (cookies), password managers.
 * The same list as the company Macs' managed settings (Jamf), so a computer
 * without them gets the same floor, plus cloud credentials the developer
 * variant leaves readable. The app's own data folder is added per computer.
 */
export const SECRET_READ_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.azure',
  '~/.config/gcloud',
  '~/.gnupg',
  '~/.kube',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.git-credentials',
  '~/.config/gh/hosts.yml',
  '~/Library/Keychains',
  '/Library/Keychains',
  '~/Library/Cookies',
  '~/Library/Safari',
  '~/Library/Containers/com.apple.Safari',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/BraveSoftware',
  '~/Library/Application Support/Arc',
  '~/Library/Application Support/Vivaldi',
  '~/Library/Application Support/com.operasoftware.Opera',
  '~/Library/Application Support/Firefox',
  '~/Library/Application Support/1Password',
  '~/Library/Group Containers/2BUA8C4S2C.com.1password',
  '~/Library/Application Support/Bitwarden',
  '~/.password-store',
]

/**
 * Package caches commands may write (outside the working folder): without
 * them `npm install` / `pip install` fail inside the sandbox (findings §A.2).
 */
export const CACHE_WRITE_PATHS: readonly string[] = [
  '~/.npm',
  '~/Library/Caches/pip',
  '~/.cache/pip',
  '~/.cache/uv',
  '~/Library/Caches/pnpm',
]

/** The Codex permission profile the app defines (never one from the company's or member's config). */
export const CODEX_SANDBOX_PROFILE = 'acb'

/** Facts about this computer and conversation the policy needs (main process supplies them). */
export interface SandboxHost {
  /** The member's home folder (absolute). */
  home: string
  /** The company folder the conversation works in (absolute). */
  companyRoot?: string
  /** The app's own data folders (userData): session cookies, the encrypted API key, queues. */
  appDataDirs?: readonly string[]
  /** Folders the member's tools run from (PATH entries, version managers). */
  toolDirs?: readonly string[]
  /** The ACB server's host name: always reachable (sync, company files, the key broker later). */
  serverHost?: string
}

/** The policy with every path absolute and every list merged and de-duplicated. */
export interface ResolvedSandbox {
  allowedDomains: string[]
  denyRead: string[]
  /** Only the company folder / tool folders that lie inside a denied place. */
  allowRead: string[]
  allowWrite: string[]
}

function trimSlash(value: string): string {
  let out = value
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** `~/x` → `<home>/x`; absolute paths stay; anything else → undefined. */
export function expandHomePath(value: string, home: string): string | undefined {
  const base = trimSlash(home)
  if (value === '~') return base
  if (value.startsWith('~/')) return trimSlash(`${base}/${value.slice(2)}`)
  if (value.startsWith('/')) return trimSlash(value)
  return undefined
}

/** `inner` is `outer` or inside it (lexically, NFC). */
export function isSameOrInside(inner: string, outer: string): boolean {
  const a = trimSlash(inner.normalize('NFC'))
  const b = trimSlash(outer.normalize('NFC'))
  return a === b || a.startsWith(b === '/' ? '/' : `${b}/`)
}

function unique(values: Iterable<string | undefined>): string[] {
  const out: string[] = []
  for (const value of values) if (value && !out.includes(value)) out.push(value)
  return out
}

/** Merge the company setting with this computer's facts. */
export function resolveSandbox(settings: Pick<AgentSandboxSettings, 'allowedDomains' | 'deniedReadPaths'>, host: SandboxHost): ResolvedSandbox {
  const expand = (value: string) => expandHomePath(value, host.home)
  const fixed = unique([...SECRET_READ_PATHS.map(expand), ...(host.appDataDirs ?? []).map(expand)])
  const denyRead = unique([...fixed, ...settings.deniedReadPaths.map(expand)])
  // The company folder and the tools must stay readable when the company
  // denies a folder around them: re-allow one only when such a denied place
  // contains it, never one inside a secret place, and never one that would
  // re-open a denied place inside it (allowRead wins over denyRead in Claude Code).
  const needed = unique([host.companyRoot, ...(host.toolDirs ?? [])].map(value => value ? expand(value) : undefined))
  const allowRead = needed.filter(root =>
    denyRead.some(denied => isSameOrInside(root, denied)) &&
    !fixed.some(secret => isSameOrInside(root, secret)) &&
    !denyRead.some(denied => !isSameOrInside(root, denied) && isSameOrInside(denied, root)))
  const allowedDomains = unique([
    ...settings.allowedDomains.map(normalizeSandboxDomain),
    normalizeSandboxDomain(host.serverHost),
  ])
  const allowWrite = unique(CACHE_WRITE_PATHS.map(expand)).filter(path => !denyRead.some(denied => isSameOrInside(path, denied)))
  return { allowedDomains, denyRead, allowRead, allowWrite }
}

/** Claude Code's sandbox settings (the SDK's `SandboxSettings` subset the app sets). */
export type ClaudeSandboxSettings = {
  enabled: true
  failIfUnavailable: true
  autoAllowBashIfSandboxed: true
  allowUnsandboxedCommands: false
  network: { allowedDomains: string[]; strictAllowlist: true }
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] }
}

/** Claude Code's own web tools: they bypass the sandbox's host list, so enforce denies them. */
export const CLAUDE_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const

/**
 * Claude Code: the `sandbox` option and the `permissions.deny` rules for the
 * inline flag settings. `Read(//abs)` is Claude Code's spelling of an
 * absolute path; both the place and everything under it are denied, so the
 * Read tool (outside the sandbox) is refused too.
 */
export function claudeSandboxOptions(resolved: ResolvedSandbox): { sandbox: ClaudeSandboxSettings; permissionsDeny: string[] } {
  return {
    sandbox: {
      enabled: true,
      // The app decides what happens when it cannot start (the company's onUnavailable).
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...resolved.allowedDomains], strictAllowlist: true },
      filesystem: { denyRead: [...resolved.denyRead], allowRead: [...resolved.allowRead], allowWrite: [...resolved.allowWrite] },
    },
    permissionsDeny: [
      ...CLAUDE_WEB_TOOLS,
      ...resolved.denyRead.flatMap(path => [`Read(/${path})`, `Read(/${path}/**)`]),
    ],
  }
}

/**
 * Codex: the thread config that selects the app's permission profile. The
 * workspace profile (write the working folder, read elsewhere) plus: the
 * denied places, the caches, and the network through Codex's proxy with only
 * the allowed hosts (`*.x` = subdomains in both CLIs). In Codex a deny wins
 * over everything, so a denied place that contains the company folder or a
 * tool folder (Claude re-allows those through `allowRead`) is left out —
 * the folder the AI works in must stay readable.
 */
export function codexSandboxConfig(resolved: ResolvedSandbox): Record<string, unknown> {
  const filesystem: Record<string, 'deny' | 'write'> = {}
  for (const path of resolved.allowWrite) filesystem[path] = 'write'
  for (const path of resolved.denyRead) {
    if (!resolved.allowRead.some(root => isSameOrInside(root, path))) filesystem[path] = 'deny'
  }
  const domains: Record<string, 'allow'> = {}
  for (const host of resolved.allowedDomains) domains[host] = 'allow'
  return {
    default_permissions: CODEX_SANDBOX_PROFILE,
    features: { network_proxy: true },
    permissions: {
      [CODEX_SANDBOX_PROFILE]: {
        extends: ':workspace',
        filesystem,
        network: { enabled: true, domains },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Recording (observe) and reading the sandbox's refusals (enforce)
// ---------------------------------------------------------------------------

const URL_RE = /\b(?:https?|wss?|ftp|git|ssh|sftp):\/\/[^\s'"`<>\\)]+/gi
const MAX_HOSTS = 5

/** The hosts of URLs a command names (lower case, ≤ 5; never the path, query or user). */
export function commandHosts(command: string): string[] {
  const hosts: string[] = []
  for (const match of command.matchAll(URL_RE)) {
    let host: string
    try { host = new URL(match[0]).hostname.toLowerCase() } catch { continue }
    if (!host || host.startsWith('[') || hosts.includes(host)) continue
    hosts.push(host)
    if (hosts.length >= MAX_HOSTS) break
  }
  return hosts
}

/** What enforce would refuse about a call: a host outside the list, or a read of a denied place. */
export type SandboxConcern = 'host' | 'read'

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'View', 'ListDirectory', 'readFile', 'listDirectory'])
const COMMAND_TOOLS = new Set(['Bash', 'executeCommand'])

/**
 * Would `enforce` refuse this call? Commands: a named host the list does not
 * allow, or a denied place spelled in the command (absolute, `~/`, `$HOME/`).
 * Read tools: a path inside a denied place. Best effort (a script can reach
 * anything) — this marks the log in observe mode; enforcing is the CLI's job.
 */
export function sandboxConcern(resolved: ResolvedSandbox, tool: string, input: unknown, home: string): SandboxConcern | undefined {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  if (COMMAND_TOOLS.has(tool)) {
    const command = Array.isArray(value.command) ? value.command.filter(w => typeof w === 'string').join(' ') : typeof value.command === 'string' ? value.command : ''
    if (!command) return undefined
    if (commandHosts(command).some(host => !sandboxAllowsHost(resolved.allowedDomains, host))) return 'host'
    const homeBase = trimSlash(home)
    const text = command.replace(/\$\{?HOME\}?(?=\/)/g, homeBase).replace(/(^|[\s'"=:])~(?=\/)/g, `$1${homeBase}`)
    if (resolved.denyRead.some(place => containsPath(text, place))) return 'read'
    return undefined
  }
  if (READ_TOOLS.has(tool)) {
    const raw = [value.file_path, value.path, value.notebook_path].find((v): v is string => typeof v === 'string' && v.length > 0)
    const path = raw ? expandHomePath(raw, home) : undefined
    if (path && resolved.denyRead.some(place => isSameOrInside(path, place))) return 'read'
  }
  return undefined
}

/** `place` appears in `text` as a whole path (followed by `/`, a quote, a space, a separator or the end). */
function containsPath(text: string, place: string): boolean {
  for (let from = 0; ;) {
    const at = text.indexOf(place, from)
    if (at < 0) return false
    const next = text[at + place.length]
    if (next === undefined || /[\s/'"`;|&)]/.test(next)) return true
    from = at + 1
  }
}

/** What the sandbox refused, read from a failed command's output. */
export interface SandboxViolation {
  /** Hosts the network proxy refused (`deny network-outbound host:port`). */
  hosts: string[]
  /** A file access the sandbox reported (a `deny file-…` line). */
  read: boolean
  /** The command failed with `Operation not permitted` (a denied place, when the command names one). */
  notPermitted: boolean
  /**
   * The local proxy refused a connection (`CONNECT tunnel failed, response 403`):
   * a host outside the list, when the command names one. Codex reports no
   * host, only this (verified on codex-cli 0.153.4).
   */
  proxyRefused: boolean
}

/**
 * Claude Code appends `<sandbox_violations>` to a command's error output when
 * the sandbox refused a connection (verified on CLI 2.1.314: `deny
 * network-outbound example.org:443 (host is not on the allow list)`). A
 * refused file read shows only as `Operation not permitted`.
 */
export function parseSandboxViolation(output: unknown): SandboxViolation | undefined {
  if (typeof output !== 'string' || !output) return undefined
  const block = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/.exec(output)?.[1]
  const notPermitted = /Operation not permitted/.test(output)
  const proxyRefused = /CONNECT tunnel failed, response 403/.test(output)
  if (block === undefined && !notPermitted && !proxyRefused) return undefined
  const hosts: string[] = []
  let read = false
  for (const line of (block ?? '').split('\n')) {
    const network = /deny network-outbound\s+([A-Za-z0-9.-]+)(?::\d+)?/.exec(line)
    if (network) {
      const host = network[1].toLowerCase()
      if (!hosts.includes(host) && hosts.length < MAX_HOSTS) hosts.push(host)
    } else if (/deny file-/.test(line)) read = true
  }
  return { hosts, read, notPermitted, proxyRefused }
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

/** What a turn does with the member's policy (`off` → no sandbox part at all). */
export type TurnSandboxDecision =
  | { mode: 'off' }
  | { mode: 'observe' | 'enforce'; resolved: ResolvedSandbox; onUnavailable: AgentSandboxSettings['onUnavailable']; degraded: boolean }

/**
 * The member's mode for this turn. `enforce` with an agent that cannot take
 * the sandbox (registry `capabilities.sandbox`) runs as `observe`
 * (`degraded`: the caller applies the company's `onUnavailable`).
 */
export function decideTurnSandbox(settings: AgentSandboxSettings, host: SandboxHost, canEnforce: boolean): TurnSandboxDecision {
  if (settings.mode === 'off') return { mode: 'off' }
  const resolved = resolveSandbox(settings, host)
  if (settings.mode === 'enforce' && !canEnforce) return { mode: 'observe', resolved, onUnavailable: settings.onUnavailable, degraded: true }
  return { mode: settings.mode, resolved, onUnavailable: settings.onUnavailable, degraded: false }
}

/** Platforms where the app hands the sandbox to an agent (owner decision: Windows is record only). */
export function sandboxPlatform(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux'
}

// ---------------------------------------------------------------------------
// What the member and the AI are told (plain Japanese for the member)
// ---------------------------------------------------------------------------

export const SANDBOX_MESSAGES = {
  /** enforce + `stop`, and this computer / agent cannot run the sandbox at all (Windows, …). */
  unavailableStop: 'この PC では AI の囲い（サンドボックス）を使えないため、会社の設定により AI を使えません。管理者に相談してください。',
  /** enforce + `stop`, and the agent's sandbox failed to start. */
  startFailedStop: 'サンドボックスを開始できませんでした。会社の設定により、この PC では AI を使えません。管理者に相談してください。',
  /** enforce + `record-only`, and the agent's sandbox failed to start (shown once in the reply). */
  startFailedRecordOnly: 'サンドボックスを開始できませんでした。会社の設定により、今回は記録だけで続けます。',
} as const

/** The sentence the member sees when a command reached for a host outside the list. */
export function blockedHostMessage(host: string): string {
  return `会社の設定で、この宛先（${host}）には接続できません。必要なら管理者に許可を依頼してください。`
}

export const BLOCKED_READ_MESSAGE = '会社の設定で、この場所は AI が読めないようになっています。'

/**
 * For the AI (system prompt, every agent under enforce): relay the refusal in
 * the member's words and never work around it.
 */
export const SANDBOX_INSTRUCTIONS = `

## Company sandbox (「AI の囲い」)
Commands you run are sandboxed by the company: they can reach only the hosts the company allows, and cannot read some places (credentials, keychains, browser data). When a command fails because the sandbox refused a host (for example "<sandbox_violations> deny network-outbound HOST"), tell the user exactly: 「会社の設定で、この宛先（HOST）には接続できません。必要なら管理者に許可を依頼してください。」 with HOST replaced. When a read is refused, tell the user: 「${BLOCKED_READ_MESSAGE}」 Never try to get around the sandbox (another tool, another host, a proxy, copying the file elsewhere, dangerouslyDisableSandbox).`

/** Claude Code's text when `failIfUnavailable` stopped it (strings of CLI 2.1.314). */
export const CLAUDE_SANDBOX_UNAVAILABLE_RE = /failIfUnavailable|sandbox_required_unavailable|sandbox unavailable/i

/** For the AI after a refused command (Claude's PostToolUseFailure `additionalContext`). */
export function sandboxRefusalContext(violation: SandboxViolation | undefined, concernRead: boolean): string | undefined {
  if (!violation) return undefined
  if (violation.hosts.length) return `The company sandbox refused this connection. Tell the user exactly: ${violation.hosts.map(blockedHostMessage).join(' ')} Do not try another way.`
  if (violation.read || (violation.notPermitted && concernRead)) return `The company sandbox refused this read. Tell the user exactly: ${BLOCKED_READ_MESSAGE} Do not try another way.`
  return undefined
}
