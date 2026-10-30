/**
 * The AI action log's event contract (monitoring M1): one event per tool call
 * an agent makes in the chat — what kind of tool, on what (company-relative
 * path, web host, program name), who decided, and how it ended. Metadata
 * only: no prompt, no file content, no command arguments, no URL path or
 * query, no message text ever enters an event (`describeTarget` is the only
 * door for the tool input, and it keeps only those parts).
 *
 * One event per call, emitted once the call is over (`createToolEventTracker`):
 *   - refused before it ran (guard, member, permission mode, stop) → at the
 *     refusal, no `outcome`;
 *   - allowed → when its result arrives, `outcome` 'ok' / 'error' and
 *     `durationMs`;
 *   - still open when the turn ends (stopped, CLI gone, a refusal the app
 *     never saw) → at the end, `outcome` 'unfinished'.
 * The same shape for Claude Code, Codex and the API key; agents report what
 * they see through the tracker and never build events themselves.
 *
 * Pure (no Node, no Electron): main process and tests import it.
 */
import type { AuthMode } from './agent'
import { CODEX_CHOICE_SERVER, CODEX_CHOICE_TOOL, CLAUDE_CHOICE_TOOL } from './choice-prompt'
import { REVIEW_SERVER } from './review-request'
import { WEB_RESEARCH_SERVER, WEB_RESEARCH_TOOL } from './web-research'
import { commandHosts, type SandboxConcern, type SandboxViolation } from './agents/sandbox-policy'
import {
  AGENT_EVENT_VERSION,
  type AgentToolEvent, type FileTarget, type GuardReason, type SandboxMark, type SensitiveLocation, type ToolCategory,
  type ToolDecision, type ToolOutcome, type ToolTarget,
} from '../../shared/types/agent-events'

// The wire contract — the event shape and the server's own validation
// (`parseAgentToolEvent`) — lives in the repository's
// shared/types/agent-events.ts. Its `agent` is the server's list of agents:
// the tracker below assigns an AuthMode to it, so an agent id the server does
// not know fails to compile here.
export { AGENT_EVENT_VERSION }
export type { AgentToolEvent, FileTarget, GuardReason, SandboxMark, SensitiveLocation, ToolCategory, ToolDecision, ToolOutcome, ToolTarget }

/**
 * Transient data part the chat server sends when the main process stopped a
 * turn (chat-turns.ts `abort`); the stream then ends with an `abort` chunk
 * whose reason is the same string.
 */
export const TURN_STOPPED_PART_TYPE = 'data-turn-stopped'
export type TurnStopReason = 'stopped-by-admin' | 'app-quit'

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * MCP servers the app itself provides (acb_consultations, acb_company_files,
 * acb_review, acb_ask): category 'app-tool'. Pinned against the electron constants in
 * tests/agent-events.test.ts. The app's web research (`acb_web`) is not one
 * of them: it reaches the web, so it is 'web'.
 */
export const APP_MCP_SERVERS: readonly string[] = ['acb_consultations', 'acb_company_files', REVIEW_SERVER, CODEX_CHOICE_SERVER]

/**
 * Tool names → category. Claude Code's own names; Codex calls are reported
 * under the names the app gives them (Bash, Write, WebSearch, mcp__…); the
 * API-key mode's five tools have names of their own. No name is shared
 * between them, so the category needs no agent id.
 */
const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read', ListDirectory: 'read', View: 'read', NotebookRead: 'read',
  Write: 'write', Edit: 'write', MultiEdit: 'write', NotebookEdit: 'write',
  Bash: 'command', BashOutput: 'command', KillShell: 'command', KillBash: 'command', PowerShell: 'command',
  WebFetch: 'web', WebSearch: 'web',
  Task: 'subagent', Agent: 'subagent',
  [CLAUDE_CHOICE_TOOL]: 'question',
  readFile: 'read', listDirectory: 'read', readSkillFile: 'read', writeFile: 'write', executeCommand: 'command',
}

/** `mcp__<server>__<tool>` → its parts (Claude's naming; Codex calls are reported the same way). */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName)
  return match ? { server: match[1], tool: match[2] } : undefined
}

export function categorizeTool(toolName: string): ToolCategory {
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    if (mcp.server === CODEX_CHOICE_SERVER && mcp.tool === CODEX_CHOICE_TOOL) return 'question'
    // 「Web で調べる」 (web-research.ts): the app's tool, but what it does is reach the web.
    if (mcp.server === WEB_RESEARCH_SERVER && mcp.tool === WEB_RESEARCH_TOOL) return 'web'
    return APP_MCP_SERVERS.includes(mcp.server) ? 'app-tool' : 'mcp-external'
  }
  return Object.prototype.hasOwnProperty.call(TOOL_CATEGORIES, toolName) ? TOOL_CATEGORIES[toolName] : 'other'
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface TargetContext {
  /** The company folder; paths inside it are kept relative. */
  companyRoot?: string
  /** Where relative paths resolve (the tool's cwd, else the chat's working directory). */
  cwd?: string
  /** The member's home folder (for ~ and the secret places in it). */
  home?: string
  /** The app's own data folders (userData): touching them is `app-data`. */
  appDataDirs?: readonly string[]
}

const isAbsolute = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
const fold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase())

/** Absolute path → its segments (NFC, `.`/`..` applied); null when it climbs above the root. */
function segmentsOf(p: string): string[] | null {
  const out: string[] = []
  for (const seg of p.normalize('NFC').replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (out.length === 0) return null; out.pop() } else out.push(seg)
  }
  return out
}

function startsWith(path: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || path.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (fold(path[i]) !== fold(prefix[i])) return false
  return true
}

function sensitiveKind(path: string[], ctx: TargetContext): SensitiveLocation | undefined {
  const lower = path.map(fold)
  const base = lower[lower.length - 1] ?? ''
  for (const dir of ctx.appDataDirs ?? []) {
    const segs = segmentsOf(dir)
    if (segs && startsWith(path, segs)) return 'app-data'
  }
  if (lower.includes('.ssh')) return 'ssh'
  for (let i = 0; i + 1 < lower.length; i++) if (lower[i] === 'library' && lower[i + 1] === 'keychains') return 'keychain'
  if (/^\.env/.test(base)) return 'env-file'
  const home = ctx.home ? segmentsOf(ctx.home) : null
  if (home && startsWith(path, home)) {
    const rest = lower.slice(home.length)
    if (['.aws', '.gnupg', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc', '.git-credentials'].includes(rest[0] ?? '')) return 'credentials'
    if (rest[0] === '.config' && ['gcloud', 'gh'].includes(rest[1] ?? '')) return 'credentials'
  }
  return undefined
}

/** One file path as an event may hold it: company-relative, or only "outside" (+ the kind of secret place). */
export function describePath(target: string, ctx: TargetContext): FileTarget {
  let raw = target
  if (ctx.home && (raw === '~' || raw.startsWith('~/'))) raw = ctx.home + raw.slice(1)
  const base = ctx.cwd && isAbsolute(ctx.cwd) ? ctx.cwd : ctx.companyRoot
  const joined = isAbsolute(raw) ? raw : base ? `${base}/${raw}` : null
  const path = joined === null ? null : segmentsOf(joined)
  if (!path) return { kind: 'outside' }
  const sensitive = sensitiveKind(path, ctx)
  const root = ctx.companyRoot ? segmentsOf(ctx.companyRoot) : null
  if (root && (path.length === root.length ? root.length > 0 && startsWith(path, root) : startsWith(path, root))) {
    return { kind: 'file', path: path.slice(root.length).join('/'), ...(sensitive ? { sensitive } : {}) }
  }
  return { kind: 'outside', ...(sensitive ? { sensitive } : {}) }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const MAX_PROGRAMS = 5
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'xargs', 'exec', 'command'])
/** Programs whose first word after the options is recorded, and their options that take a value. */
const SUBCOMMANDS: Record<string, string[]> = {
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace'],
  npm: ['--prefix', '-w', '--workspace'],
  pnpm: ['-C', '--dir', '--filter', '-F'],
  yarn: ['--cwd'],
  bun: ['--cwd'],
  pip: [], pip3: [], uv: ['--directory'],
  brew: [],
  docker: ['-H', '--host', '--context', '-c', '--config', '-l', '--log-level'],
  gh: ['-R', '--repo'],
  cargo: ['-C', '--manifest-path'],
  go: ['-C'],
}
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/
const SUBCOMMAND_RE = /^[a-z][a-z0-9:_-]{0,23}$/
const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,39}$/
const PACKAGE_RE = /^(@[a-z0-9~][a-z0-9._~-]{0,40}\/)?[a-z0-9~][a-z0-9._~-]{0,40}$/

interface Lexed { segments: string[][]; redirect: boolean }

/** Shell words per simple command (quotes removed), split at `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. */
function lex(command: string): Lexed {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let redirect = false
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = [] }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close < 0 ? command.length : close
      word += command.slice(i + 1, end); inWord = true; i = end
    } else if (c === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') { if (command[j] === '\\') j++; j++ }
      word += command.slice(i + 1, Math.min(j, command.length)).replace(/\\(.)/g, '$1'); inWord = true; i = j
    } else if (c === '\\') {
      word += command[i + 1] ?? ''; inWord = true; i++
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && command[i + 1] !== '>' && command[i - 1] !== '>')) {
      endSegment()
      if ((c === '|' || c === '&') && command[i + 1] === c) i++
    } else if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      // A file redirection: `>`, `>>`, `&>`, `2>` — not `2>&1` and not to /dev/null.
      if (c === '&') i++
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false } else endWord()
      if (command[i + 1] === '>') i++
      if (command[i + 1] === '&') { i++; continue }
      const rest = command.slice(i + 1).trimStart()
      if (!/^\/dev\/null(\s|$|[;&|])/.test(rest)) redirect = true
    } else if (c === '<') {
      endWord()
    } else {
      word += c; inWord = true
    }
  }
  endSegment()
  return { segments, redirect }
}

const programName = (word: string) => {
  const base = word.replace(/^.*[\\/]/, '')
  return PROGRAM_RE.test(base) ? base : '?'
}

/** One simple command → its label(s): `git push`, `python3 -m pytest`, `sudo rm`; never arguments. */
function describeSegment(words: string[], depth: number, out: { programs: string[]; redirect: boolean }) {
  let i = 0
  const prefix: string[] = []
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
    const name = i < words.length ? programName(words[i]) : undefined
    if (!name || !WRAPPERS.has(name)) break
    prefix.push(name); i++
    while (i < words.length && words[i].startsWith('-')) i++
  }
  if (i >= words.length) { if (prefix.length) out.programs.push(prefix.join(' ')); return }
  const program = programName(words[i])
  const rest = words.slice(i + 1)
  if (SHELLS.has(program) && depth < 2) {
    const flag = rest.findIndex(w => /^-[a-z]*c[a-z]*$/.test(w))
    if (flag >= 0 && rest[flag + 1] !== undefined) {
      const inner = lex(rest[flag + 1])
      if (inner.redirect) out.redirect = true
      for (const segment of inner.segments) describeSegment(segment, depth + 1, out)
      return
    }
  }
  if (program === 'tee') out.redirect = true
  let label = program
  if (/^python(\d+(\.\d+)?)?$/.test(program)) {
    const m = rest.indexOf('-m')
    if (m >= 0 && MODULE_RE.test(rest[m + 1] ?? '')) label = `${program} -m ${rest[m + 1]}`
  } else if (PACKAGE_RUNNERS.has(program)) {
    const pkg = rest.find(w => !w.startsWith('-'))
    const name = pkg?.replace(/(.)@[^/]*$/, '$1')
    if (name && PACKAGE_RE.test(name)) label = `${program} ${name}`
  } else if (SUBCOMMANDS[program]) {
    const valued = SUBCOMMANDS[program]
    for (let j = 0; j < rest.length; j++) {
      const w = rest[j]
      if (w.startsWith('-')) { if (valued.includes(w)) j++; continue }
      if (SUBCOMMAND_RE.test(w)) label = `${program} ${w}`
      break
    }
  }
  out.programs.push([...prefix, label].join(' '))
}

/**
 * A shell command as an event may hold it: program names (+ subcommands),
 * whether it writes a file, the hosts of URLs it names (what the AI sandbox's
 * host list is about); no arguments, no URL path or query.
 */
export function describeCommand(command: string): Extract<ToolTarget, { kind: 'command' }> {
  const out = { programs: [] as string[], redirect: false }
  const lexed = lex(command)
  if (lexed.redirect) out.redirect = true
  for (const segment of lexed.segments) describeSegment(segment, 0, out)
  const programs = out.programs.slice(0, MAX_PROGRAMS)
  const more = out.programs.length - programs.length
  const hosts = commandHosts(command)
  return { kind: 'command', programs, ...(more > 0 ? { more } : {}), ...(out.redirect ? { redirect: true as const } : {}), ...(hosts.length ? { hosts } : {}) }
}

// ---------------------------------------------------------------------------
// Skills (which skill a call belongs to, for the sandbox's per-skill table)
// ---------------------------------------------------------------------------

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}(:[a-z0-9][a-z0-9_-]{0,63})?$/
const SKILL_PATH_RE = /(?:^|[\s'"/\\])\.(?:claude|agents|codex)[/\\]skills[/\\]([a-z0-9][a-z0-9_-]{0,63})(?:[/\\]|$)/

/**
 * The skill a call starts or works inside: Claude's `Skill` tool, or a path
 * (a file, a command's script) under `.claude/skills/<name>/` (also
 * `.agents/` / `.codex/`). Only a skill folder name, never a path.
 */
export function skillOfCall(tool: string, input: unknown): string | undefined {
  const value = record(input)
  if (tool === 'Skill') {
    const name = str(value.skill) ?? str(value.command) ?? str(value.name)
    const clean = name?.replace(/^\//, '')
    return clean && SKILL_NAME_RE.test(clean) ? clean : undefined
  }
  const texts = [value.file_path, value.path, value.notebook_path, value.command].map(v => Array.isArray(v) ? v.join(' ') : v).filter((v): v is string => typeof v === 'string')
  for (const text of texts) {
    const match = SKILL_PATH_RE.exec(text)
    if (match) return match[1]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const MAX_FILES = 5
const str = (value: unknown) => typeof value === 'string' && value ? value : undefined
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

function webHost(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined
  } catch { return undefined }
}

/**
 * What a call works on, from its input — the only place a tool input is
 * read for an event. Keeps a company-relative path, a web host, program
 * names, an MCP server name or a subagent type; drops everything else.
 */
export function describeTarget(toolName: string, input: unknown, ctx: TargetContext): ToolTarget {
  const category = categorizeTool(toolName)
  const value = record(input)
  switch (category) {
    case 'read':
    case 'write': {
      const changes = Array.isArray(value.changes) ? value.changes : undefined
      if (changes) {
        const paths = changes.map(change => str(record(change).path)).filter((p): p is string => !!p)
        const files = paths.slice(0, MAX_FILES).map(p => describePath(p, ctx))
        return { kind: 'files', files, ...(paths.length > MAX_FILES ? { more: paths.length - MAX_FILES } : {}) }
      }
      const target = str(value.file_path) ?? str(value.notebook_path) ?? str(value.path)
      if (target) return describePath(target, ctx)
      // Glob / Grep / LS without a path search the working directory.
      if (['Glob', 'Grep', 'LS', 'listDirectory'].includes(toolName) && ctx.cwd) return describePath(ctx.cwd, ctx)
      return { kind: 'none' }
    }
    case 'command': {
      const command = Array.isArray(value.command) ? value.command.filter(w => typeof w === 'string').join(' ') : str(value.command)
      return command ? describeCommand(command) : { kind: 'command', programs: [] }
    }
    case 'web': {
      // WebFetch's `url`; the web research's first given page (its question is never read).
      const host = webHost(value.url) ?? (Array.isArray(value.urls) ? webHost(value.urls[0]) : undefined)
      return host ? { kind: 'web', host } : { kind: 'web' }
    }
    case 'mcp-external':
    case 'app-tool': {
      const mcp = parseMcpToolName(toolName)
      return mcp ? { kind: 'mcp', server: mcp.server, tool: mcp.tool } : { kind: 'none' }
    }
    case 'subagent': {
      const subagentType = str(value.subagent_type)
      return subagentType && PROGRAM_RE.test(subagentType) ? { kind: 'subagent', subagentType } : { kind: 'subagent' }
    }
    default:
      return { kind: 'none' }
  }
}

// ---------------------------------------------------------------------------
// Tracker (one per turn)
// ---------------------------------------------------------------------------

export interface ToolCall {
  tool: string
  input?: unknown
  /** The tool's own working directory (Claude hook `cwd`, Codex item `cwd`). */
  cwd?: string
  subagentType?: string
}

/** What an agent reports for its calls; the tracker turns it into events. Never throws. */
export interface ToolEventTracker {
  /** The app (or the member) decided. Refusals are emitted at once. Returns the call id used. */
  decide(callId: string | undefined, call: ToolCall, decision: ToolDecision, guardReason?: GuardReason): string
  /** The call started without a decision of the app's (Codex item/started): the agent's own policy let it run. */
  start(callId: string, call: ToolCall): void
  /**
   * Its result arrived. A call the tracker never saw is reported as `policy-default`.
   * `violation`: what the sandbox refused, read from the failed command's output.
   */
  finish(callId: string, outcome: 'ok' | 'error', call?: ToolCall, durationMs?: number, violation?: SandboxViolation): void
  /** The turn is over: calls still open are emitted as `unfinished`. Later reports still work. */
  close(): void
}

/**
 * The member's AI sandbox for this turn (sandbox-policy.ts): `observe` marks
 * calls `enforce` would refuse; `enforce` marks the ones the sandbox refused.
 */
export interface ToolEventSandbox {
  mode: 'observe' | 'enforce'
  concern: (call: ToolCall) => SandboxConcern | undefined
}

export interface ToolEventContext extends TargetContext {
  agent: AuthMode
  sandbox?: ToolEventSandbox
  conversationId?: string
  turnId?: string
  companyId?: string
  /** The conversation's working department folder (company-relative). */
  department?: string
  model?: string
}

const DENIALS: ReadonlySet<ToolDecision> = new Set(['member-denied', 'guard-denied', 'policy-denied', 'stopped'])
const MAX_OPEN = 500
const MAX_TOOL_NAME = 100

interface OpenCall {
  callId: string
  at: number
  since: number
  tool: string
  subagentType?: string
  target: ToolTarget
  decision: ToolDecision
  guardReason?: GuardReason
  concern?: SandboxConcern
  skill?: string
  sandbox?: SandboxMark
}

export function createToolEventTracker(
  context: ToolEventContext,
  emit: (event: AgentToolEvent) => void,
  deps: { now?: () => number; newId?: () => string; warn?: (message: string) => void } = {},
): ToolEventTracker {
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  const warn = deps.warn ?? ((message: string) => console.warn(message))
  const open = new Map<string, OpenCall>()
  const done = new Set<string>()
  let warned = false
  // The skill this turn is running (the latest one a call started or worked inside).
  let currentSkill: string | undefined
  // A department folder name as the event carries it (company-relative, NFC), or nothing.
  const departmentPath = context.department?.normalize('NFC').replace(/\\/g, '/').split('/').filter(s => s && s !== '.').join('/')
  const department = departmentPath && !departmentPath.split('/').includes('..') ? departmentPath : undefined

  const safe = <T>(fallback: T, run: () => T): T => {
    try { return run() } catch (error) {
      if (!warned) { warned = true; warn(`[agent-events] could not record a tool call: ${error instanceof Error ? error.message : 'unknown'}`) }
      return fallback
    }
  }
  const targetOf = (call: ToolCall) => describeTarget(call.tool, call.input, { ...context, cwd: call.cwd || context.cwd })
  const subagent = (call: ToolCall) => call.subagentType && PROGRAM_RE.test(call.subagentType) ? call.subagentType : undefined
  const concernOf = (call: ToolCall) => {
    try { return context.sandbox?.concern(call) } catch { return undefined }
  }
  const openCall = (callId: string, call: ToolCall, decision: ToolDecision, guardReason?: GuardReason): OpenCall => {
    const t = now()
    currentSkill = skillOfCall(call.tool, call.input) ?? currentSkill
    const concern = concernOf(call)
    return {
      callId, at: t, since: t, tool: call.tool.slice(0, MAX_TOOL_NAME), subagentType: subagent(call), target: targetOf(call), decision, guardReason,
      ...(concern ? { concern } : {}), ...(currentSkill ? { skill: currentSkill } : {}),
      ...(concern && context.sandbox?.mode === 'observe' ? { sandbox: 'would-block' as const } : {}),
    }
  }
  /** Enforce: did the sandbox refuse this call? Hosts it refused join the target's. */
  const blockedBy = (c: OpenCall, violation: SandboxViolation | undefined): OpenCall | undefined => {
    if (context.sandbox?.mode !== 'enforce' || !violation) return undefined
    const read = violation.read || (violation.notPermitted && c.concern === 'read')
    if (violation.hosts.length === 0 && !read) return undefined
    const target = c.target.kind === 'command' && violation.hosts.length
      ? { ...c.target, hosts: [...new Set([...(c.target.hosts ?? []), ...violation.hosts])].slice(0, 5) }
      : c.target
    return { ...c, target, sandbox: 'blocked', guardReason: c.guardReason ?? 'sandbox' }
  }
  const send = (c: OpenCall, outcome?: ToolOutcome, durationMs?: number) => {
    open.delete(c.callId)
    done.add(c.callId)
    const event: AgentToolEvent = {
      version: AGENT_EVENT_VERSION,
      id: newId(),
      callId: c.callId,
      at: new Date(c.at).toISOString(),
      ...(durationMs !== undefined ? { durationMs: Math.max(0, Math.round(durationMs)) } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.companyId ? { companyId: context.companyId } : {}),
      ...(department ? { department } : {}),
      agent: context.agent,
      ...(context.model ? { model: context.model } : {}),
      ...(c.subagentType ? { subagentType: c.subagentType } : {}),
      tool: c.tool,
      category: categorizeTool(c.tool),
      target: c.target,
      decision: c.decision,
      ...(c.guardReason ? { guardReason: c.guardReason } : {}),
      ...(outcome ? { outcome } : {}),
      ...(c.sandbox ? { sandbox: c.sandbox } : {}),
      ...(c.skill ? { skill: c.skill } : {}),
    }
    emit(event)
  }
  const remember = (c: OpenCall) => {
    if (open.size >= MAX_OPEN) { const oldest = open.values().next().value; if (oldest) send(oldest, 'unfinished') }
    open.set(c.callId, c)
  }

  return {
    decide(callId, call, decision, guardReason) {
      const id = callId || newId()
      safe(undefined, () => {
        if (done.has(id)) return
        const existing = open.get(id)
        const c = existing
          ? { ...existing, decision, guardReason: guardReason ?? existing.guardReason, since: now(), ...(existing.target.kind === 'none' && call.input !== undefined ? { target: targetOf(call) } : {}) }
          : openCall(id, call, decision, guardReason)
        if (DENIALS.has(decision)) send(c)
        else remember(c)
      })
      return id
    },
    start(callId, call) {
      safe(undefined, () => {
        if (done.has(callId)) return
        const existing = open.get(callId)
        if (!existing) { remember(openCall(callId, call, 'policy-default')); return }
        if (existing.target.kind === 'none' || (existing.target.kind === 'command' && existing.target.programs.length === 0)) {
          remember({ ...existing, target: targetOf(call) })
        }
      })
    },
    finish(callId, outcome, call, durationMs, violation) {
      safe(undefined, () => {
        if (done.has(callId)) return
        const seen = open.get(callId) ?? (call ? openCall(callId, call, 'policy-default') : undefined)
        if (!seen) return
        const c = (outcome === 'error' ? blockedBy(seen, violation) : undefined) ?? seen
        send(c, outcome, durationMs ?? now() - c.since)
      })
    },
    close() {
      safe(undefined, () => { for (const c of [...open.values()]) send(c, 'unfinished') })
    },
  }
}
