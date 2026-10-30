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

import { normalizeSandboxDomain, type AgentSandboxSettings } from '../../../shared/core/agent-sandbox'

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
export interface ClaudeSandboxSettings {
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
