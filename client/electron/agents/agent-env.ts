/**
 * The environment every AI process gets (Claude Code chat and one-shots,
 * Codex app-server, hand-off writers, the API-key mode's commands) — and with
 * it every command and MCP server those processes start.
 *
 * Built from an allowlist instead of the member's whole shell environment: a
 * secret exported in the shell (AWS_*, GITHUB_TOKEN, OPENAI_API_KEY, database
 * URLs, …) must not be readable by the AI or by a script it runs. The CLIs
 * authenticate with their own stored login (keychain / ~/.claude,
 * ~/.codex/auth.json), not with environment variables.
 *
 * Precedence, per variable name (compared case-insensitively — Windows
 * environment names are):
 *   0. a key broker variable (`BROKER_ENV_NAMES`: GEMINI_API_KEY,
 *      OPENAI_BASE_URL, ACB_GEMINI_API_KEY, …) is kept only with a value the app
 *      sets — a broker token, the no-key placeholder, a relay URL — and dropped
 *      otherwise, so a real key or another base URL from the member's shell
 *      never reaches the AI (client/shared/broker-env.ts);
 *   1. an ACB-set key (`ACB_SET_KEYS`) is always kept;
 *   2. a deny match (`DENY_*`) is always dropped — also when the member listed
 *      the name in the per-machine pass-through setting;
 *   3. an allow match (`ALLOW_*`) or a pass-through name is kept;
 *   4. everything else is dropped.
 *
 * Dropped names (never values) are logged once each per app start.
 */

import { BROKER_ENV_NAMES, brokerOrigin, isBrokerEnvValue } from '../../shared/broker-env'

export const ALLOW_NAMES: readonly string[] = [
  // POSIX basics
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', '__CF_USER_TEXT_ENCODING',
  // git over ssh inside tools
  'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND',
  // proxies (both spellings: the comparison is case-insensitive)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  // corporate TLS
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  // the CLIs' own config directories
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  // Windows essentials
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'CommonProgramW6432', 'WINDIR', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  // set by the app for the API-key mode's commands
  'FORCE_COLOR',
]

/** Prefixes of names that are kept (unless denied). */
export const ALLOW_PREFIXES: readonly string[] = [
  'LC_', 'XDG_',
  // Claude Code's own switches, and what the Agent SDK sets (CLAUDE_AGENT_SDK_VERSION, …_CLIENT_APP)
  'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_',
  'ACB_',
]

/** Name parts that mark a secret, anywhere in the name. */
export const DENY_SUBSTRINGS: readonly string[] = [
  'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'CREDENTIAL', 'API_KEY', 'APIKEY',
  'ACCESS_KEY', 'PRIVATE_KEY', 'COOKIE', 'DATABASE_URL', 'CONNECTION_STRING',
]

/** Name endings that mark a secret. */
export const DENY_SUFFIXES: readonly string[] = ['_KEY', '_DSN', '_PAT']

/** Whole provider families whose variables carry credentials. */
export const DENY_PREFIXES: readonly string[] = ['AWS_', 'AZURE_', 'GOOGLE_APPLICATION_']

/** Exact secret-bearing names without a tell-tale part. */
export const DENY_NAMES: readonly string[] = ['REDIS_URL', 'MONGODB_URI', 'MONGO_URL', 'POSTGRES_URL', 'MYSQL_URL', 'PGPASS', 'NETRC', 'CLAUDECODE']

/**
 * Keys the app itself sets on AI processes (or the Agent SDK sets on the CLI).
 * Kept even if a deny rule would match; a new key the app sets goes here.
 */
export const ACB_SET_KEYS: readonly string[] = [
  'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_AGENT_SDK_VERSION',
  'FORCE_COLOR',
]

/** A pass-through name the member may list: an exact variable name, no patterns. */
export const PASSTHROUGH_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const PASSTHROUGH_MAX = 50

const upper = (names: readonly string[]) => new Set(names.map(name => name.toUpperCase()))
const ALLOW = upper(ALLOW_NAMES)
const ACB_SET = upper(ACB_SET_KEYS)
const DENY = upper(DENY_NAMES)
const BROKER = upper(BROKER_ENV_NAMES)

/** True when the name looks like a secret (rule 2). */
export function isDeniedName(name: string): boolean {
  const key = name.toUpperCase()
  if (ACB_SET.has(key)) return false
  return DENY.has(key)
    || DENY_PREFIXES.some(prefix => key.startsWith(prefix))
    || DENY_SUFFIXES.some(suffix => key.endsWith(suffix))
    || DENY_SUBSTRINGS.some(part => key.includes(part))
}

function isAllowedName(key: string): boolean {
  return ALLOW.has(key) || ALLOW_PREFIXES.some(prefix => key.startsWith(prefix))
}

export interface AgentEnvResult {
  env: Record<string, string>
  /** Names that were present and left out (sorted). Never the values. */
  dropped: string[]
}

/**
 * Rules 0–4 over `source`; `extraNames` = the member's pass-through names;
 * `serverOrigin` = the company server (`https://…`) whose relay URLs may pass.
 */
export function buildAgentEnv(source: Record<string, string | undefined>, extraNames: readonly string[] = [], serverOrigin = ''): AgentEnvResult {
  const extra = upper(extraNames.filter(name => PASSTHROUGH_NAME.test(name)))
  const env: Record<string, string> = {}
  const dropped: string[] = []
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue
    const key = name.toUpperCase()
    const keep = BROKER.has(key)
      ? isBrokerEnvValue(name, value, serverOrigin)
      : ACB_SET.has(key) || (!isDeniedName(name) && (isAllowedName(key) || extra.has(key)))
    if (keep) env[name] = value
    else dropped.push(name)
  }
  return { env, dropped: dropped.sort() }
}

/** Which pass-through names would be refused (rule 2) or are not valid names. */
export function refusedPassthroughNames(names: readonly string[]): { invalid: string[]; denied: string[] } {
  return {
    invalid: names.filter(name => !PASSTHROUGH_NAME.test(name)),
    denied: names.filter(name => PASSTHROUGH_NAME.test(name) && isDeniedName(name)),
  }
}

/** Trimmed, valid, not denied, deduplicated (case-insensitively), at most PASSTHROUGH_MAX. */
export function normalizePassthroughNames(names: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (!PASSTHROUGH_NAME.test(name) || isDeniedName(name) || seen.has(name.toUpperCase())) continue
    seen.add(name.toUpperCase())
    out.push(name)
    if (out.length >= PASSTHROUGH_MAX) break
  }
  return out
}

// --- The app's instance: configured once by main.ts ------------------------

let passthrough: () => readonly string[] = () => []
let serverOrigin: () => string = () => ''
let log: (line: string) => void = line => console.log(line)
const reported = new Set<string>()

/** main.ts: where the member's pass-through names come from (config.json), and the log. */
export function configureAgentEnv(options: { passthroughNames: () => readonly string[]; serverUrl?: () => string; log?: (line: string) => void }): void {
  passthrough = options.passthroughNames
  if (options.serverUrl) { const url = options.serverUrl; serverOrigin = () => brokerOrigin(url()) }
  if (options.log) log = options.log
}

/**
 * The environment for an AI process started from `source` (the shell
 * environment plus what the app adds). Every AI spawn goes through this:
 * `spawnAgentProcess` (Claude Code, Codex, hand-off), `runClaudeOneShot`, the
 * API-key mode's commands.
 */
export function agentEnv(source: Record<string, string | undefined>): Record<string, string> {
  let extra: readonly string[] = []
  try { extra = passthrough() } catch { /* unreadable settings: no extras */ }
  let origin = ''
  try { origin = serverOrigin() } catch { /* no server: no relay URLs */ }
  const { env, dropped } = buildAgentEnv(source, extra, origin)
  const fresh = dropped.filter(name => !reported.has(name))
  if (fresh.length) {
    for (const name of fresh) reported.add(name)
    log(`[agent-env] not passed to AI processes: ${fresh.join(', ')}`)
  }
  return env
}

/** Tests: forget what was logged and the configuration. */
export function resetAgentEnvForTests(): void {
  reported.clear()
  passthrough = () => []
  serverOrigin = () => ''
  log = line => console.log(line)
}
