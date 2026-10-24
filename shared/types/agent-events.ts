/**
 * The AI action log (monitoring M1) — the contract between the desktop app
 * (which records one event per tool call an agent makes in the chat,
 * client/shared/agent-events.ts), the server (which stores them,
 * server/src/services/agent-events.ts) and the admin console (which reads
 * them).
 *
 * Metadata only: what kind of tool, on what (a company-relative path, a web
 * host, a program name), who decided, how it ended. Never a prompt, file
 * content, command argument, URL path or message.
 *
 * `parseAgentToolEvent` is the server's per-event validation; the app's own
 * tests feed its events through it, so what the app sends is what the server
 * accepts. Pure: imports only shared/core.
 */
import { normalizeRepoPath } from '../core/paths'

export const AGENT_EVENT_VERSION = 1

export const AGENT_KINDS = ['claude-code', 'codex', 'api-key'] as const
/** The agent that made the call (the app's AuthMode). */
export type AgentKind = typeof AGENT_KINDS[number]

export const TOOL_CATEGORIES = ['read', 'write', 'command', 'web', 'mcp-external', 'app-tool', 'subagent', 'question', 'other'] as const
export type ToolCategory = typeof TOOL_CATEGORIES[number]

/**
 * Who let the call run, or refused it:
 * - auto-allowed: the app allowed it without asking (read-only tools in
 *   canUseTool, the app's own tools, subagent launches);
 * - member-allowed / member-denied: the member answered an approval;
 * - guard-denied: one of the app's guards refused (see `guardReason`);
 * - policy-default: the app did not decide; the agent's own permission mode
 *   or sandbox did (and let it run);
 * - policy-denied: the agent's permission mode refused (Claude's
 *   PermissionDenied hook, when the CLI sends it);
 * - stopped: refused because the AI is stopped (M2).
 */
export const TOOL_DECISIONS = ['auto-allowed', 'member-allowed', 'member-denied', 'guard-denied', 'policy-default', 'policy-denied', 'stopped'] as const
export type ToolDecision = typeof TOOL_DECISIONS[number]

/** Decisions that refused the call. */
export const DENIED_DECISIONS: readonly ToolDecision[] = ['member-denied', 'guard-denied', 'policy-denied', 'stopped']

/** Why a guard refused or asked: a short code, never the message text. */
export const GUARD_REASONS = [
  'read-only-folder', 'not-downloaded', 'reserved-path', 'instruction-file', 'git-clone', 'git-init',
  'private-read', 'dangerous-command', 'needs-approval', 'outside-folder',
] as const
export type GuardReason = typeof GUARD_REASONS[number]

export const TOOL_OUTCOMES = ['ok', 'error', 'unfinished'] as const
export type ToolOutcome = typeof TOOL_OUTCOMES[number]

/** Secret places outside (or inside) the company folder: the kind is kept, the path never. */
export const SENSITIVE_LOCATIONS = ['ssh', 'env-file', 'keychain', 'credentials', 'app-data'] as const
export type SensitiveLocation = typeof SENSITIVE_LOCATIONS[number]

export type FileTarget =
  | { kind: 'file'; path: string; sensitive?: SensitiveLocation }
  | { kind: 'outside'; sensitive?: SensitiveLocation }

export type ToolTarget =
  | FileTarget
  | { kind: 'files'; files: FileTarget[]; more?: number }
  /** `programs`: program name, plus the subcommand for a few well-known tools (`git push`). */
  | { kind: 'command'; programs: string[]; more?: number; redirect?: true }
  | { kind: 'web'; host?: string }
  | { kind: 'mcp'; server: string; tool?: string }
  | { kind: 'subagent'; subagentType?: string }
  | { kind: 'none' }

/** One tool call, as the app sends it (POST …/agent-events). */
export interface AgentToolEvent {
  version: typeof AGENT_EVENT_VERSION
  /** Unique per event (the server drops duplicates by it). */
  id: string
  /** The agent's own id of the call (tool_use_id, Codex item id), or one made up. */
  callId: string
  /** When the app first saw the call (ISO). */
  at: string
  durationMs?: number
  /** The app's conversation (appSessionId). */
  conversationId?: string
  turnId?: string
  /** Informational; the server files the event under the company of the URL. */
  companyId?: string
  /** The conversation's working department folder (company-relative, NFC), when one was open. */
  department?: string
  agent: AgentKind
  model?: string
  /** The subagent the call ran in (Claude's hook `agent_type`). */
  subagentType?: string
  tool: string
  category: ToolCategory
  target: ToolTarget
  decision: ToolDecision
  guardReason?: GuardReason
  outcome?: ToolOutcome
}

// ---------------------------------------------------------------------------
// Limits (server-enforced; the app batches within them)
// ---------------------------------------------------------------------------

/** Events per POST; more → 413. */
export const AGENT_EVENTS_MAX_PER_REQUEST = 200
/** Per member and company: events accepted per window; more → 429 + Retry-After. */
export const AGENT_EVENTS_RATE_LIMIT = 3000
export const AGENT_EVENTS_RATE_WINDOW_MS = 10 * 60 * 1000
/** An `at` older than this or later than the skew is stored as the time it arrived (`atAdjusted`). */
export const AGENT_EVENTS_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000
export const AGENT_EVENTS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

export const AGENT_EVENTS_DEFAULT_RETENTION_DAYS = 180
export const AGENT_EVENTS_MIN_RETENTION_DAYS = 7
export const AGENT_EVENTS_MAX_RETENTION_DAYS = 3650

export const AGENT_EVENT_VIEWER_MODES = ['admins', 'admins-and-managers'] as const
/** Who may read the log: owner/admin only, or also department managers (their departments' part). */
export type AgentEventViewerMode = typeof AGENT_EVENT_VIEWER_MODES[number]

// ---------------------------------------------------------------------------
// Validation (the server's, per event)
// ---------------------------------------------------------------------------

const MAX_PATH = 1024
const MAX_FILES = 5
const MAX_PROGRAMS = 5
const MAX_MORE = 1_000_000
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Printable: no control characters (C0 and DEL). */
const PRINTABLE_RE = { test: (s: string) => ![...s].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) }
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/
/** A program label (`git push`, `sudo rm`, `npx @scope/pkg`, `?` for a name the app would not keep). */
const PROGRAM_RE = /^[A-Za-z0-9 ._+:@/~?-]{1,80}$/
const HOST_RE = /^[a-z0-9.\-:[\]]{1,255}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

const has = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)

function text(value: unknown, max: number, re: { test(s: string): boolean } = PRINTABLE_RE): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && re.test(value) ? value : undefined
}

function count(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined
}

/** A company-relative path: NFC, '/'-separated, no '.'/'..', not the root itself. */
function relPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_PATH || !PRINTABLE_RE.test(value)) return undefined
  const p = normalizeRepoPath(value)
  return p ? p : undefined
}

function fileTarget(raw: unknown): FileTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const sensitive = has(SENSITIVE_LOCATIONS, v.sensitive) ? { sensitive: v.sensitive } : {}
  if (v.kind === 'outside') return { kind: 'outside', ...sensitive }
  if (v.kind !== 'file') return null
  // The company folder itself is a path too ('' — Glob/LS at the root).
  const path = v.path === '' ? '' : relPath(v.path)
  return path === undefined ? null : { kind: 'file', path, ...sensitive }
}

/** The target, keeping only the fields of its kind; null when it is not one. */
export function parseToolTarget(raw: unknown): ToolTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const more = count(v.more, MAX_MORE)
  switch (v.kind) {
    case 'file':
    case 'outside':
      return fileTarget(v)
    case 'files': {
      if (!Array.isArray(v.files)) return null
      const files: FileTarget[] = []
      for (const f of v.files.slice(0, MAX_FILES)) {
        const t = fileTarget(f)
        if (!t) return null
        files.push(t)
      }
      const extra = (more ?? 0) + Math.max(0, v.files.length - MAX_FILES)
      return { kind: 'files', files, ...(extra > 0 ? { more: Math.min(extra, MAX_MORE) } : {}) }
    }
    case 'command': {
      if (!Array.isArray(v.programs)) return null
      const programs: string[] = []
      for (const p of v.programs.slice(0, MAX_PROGRAMS)) {
        const label = text(p, 80, PROGRAM_RE)
        if (label === undefined) return null
        programs.push(label)
      }
      const extra = (more ?? 0) + Math.max(0, v.programs.length - MAX_PROGRAMS)
      return { kind: 'command', programs, ...(extra > 0 ? { more: Math.min(extra, MAX_MORE) } : {}), ...(v.redirect === true ? { redirect: true as const } : {}) }
    }
    case 'web': {
      const host = typeof v.host === 'string' ? text(v.host.toLowerCase(), 255, HOST_RE) : undefined
      return host ? { kind: 'web', host } : { kind: 'web' }
    }
    case 'mcp': {
      const server = text(v.server, 100)
      if (!server) return null
      const tool = text(v.tool, 100)
      return { kind: 'mcp', server, ...(tool ? { tool } : {}) }
    }
    case 'subagent': {
      const subagentType = text(v.subagentType, 40, NAME_RE)
      return subagentType ? { kind: 'subagent', subagentType } : { kind: 'subagent' }
    }
    case 'none':
      return { kind: 'none' }
    default:
      return null
  }
}

/**
 * One event as the server stores it, or null when it is not a valid event.
 * Required fields (version, id, callId, at, agent, tool, category, target,
 * decision) must be valid or the event is rejected; an optional field with an
 * invalid value is dropped. Unknown fields are dropped. Paths come back NFC.
 */
export function parseAgentToolEvent(raw: unknown): AgentToolEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (v.version !== AGENT_EVENT_VERSION) return null
  const id = text(v.id, 64, ID_RE)
  const callId = text(v.callId, 200)
  const at = typeof v.at === 'string' && ISO_RE.test(v.at) && !Number.isNaN(Date.parse(v.at)) ? v.at : undefined
  const tool = text(v.tool, 100)
  const target = parseToolTarget(v.target)
  if (!id || !callId || !at || !tool || !target) return null
  if (!has(AGENT_KINDS, v.agent) || !has(TOOL_CATEGORIES, v.category) || !has(TOOL_DECISIONS, v.decision)) return null

  const durationMs = count(v.durationMs, MAX_DURATION_MS)
  const conversationId = text(v.conversationId, 100)
  const turnId = text(v.turnId, 100)
  const companyId = text(v.companyId, 100)
  const department = relPath(v.department)
  const model = text(v.model, 100)
  const subagentType = text(v.subagentType, 40, NAME_RE)
  return {
    version: AGENT_EVENT_VERSION,
    id,
    callId,
    at,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(companyId ? { companyId } : {}),
    ...(department ? { department } : {}),
    agent: v.agent,
    ...(model ? { model } : {}),
    ...(subagentType ? { subagentType } : {}),
    tool,
    category: v.category,
    target,
    decision: v.decision,
    ...(has(GUARD_REASONS, v.guardReason) ? { guardReason: v.guardReason } : {}),
    ...(has(TOOL_OUTCOMES, v.outcome) ? { outcome: v.outcome } : {}),
  }
}

// ---------------------------------------------------------------------------
// POST /api/companies/:companyId/agent-events  { events: AgentToolEvent[] }
// ---------------------------------------------------------------------------

export interface AgentEventIngestRequest {
  events: AgentToolEvent[]
}

export interface AgentEventIngestResult {
  /** Stored now. */
  accepted: number
  /** Already stored (same id) — a re-send. */
  duplicates: number
  /** Not valid events (skipped; the rest of the batch is stored). */
  rejected: number
}

// ---------------------------------------------------------------------------
// GET …/agent-events  (owner/admin; managers when the viewer mode allows)
// ---------------------------------------------------------------------------

/** A file the reader may not see (inside a folder they cannot read): no path, no name. */
export interface HiddenFileTarget {
  kind: 'hidden'
}

export type ShownFileTarget = FileTarget | HiddenFileTarget

/** A stored target as a reader receives it: paths they cannot read are `hidden`. */
export type AgentEventTarget =
  | ShownFileTarget
  | { kind: 'files'; files: ShownFileTarget[]; more?: number }
  | Exclude<ToolTarget, FileTarget | { kind: 'files' }>

export interface AgentEventRecord {
  id: string
  /** The agent's id of the call (pairs the event with the conversation's transcript, when one is kept). */
  callId: string
  userId: string
  name: string | null
  email: string | null
  /** When the call happened (the app's clock), or `receivedAt` when that was implausible (`atAdjusted`). */
  at: string
  atAdjusted: boolean
  receivedAt: string
  durationMs: number | null
  conversationId: string | null
  turnId: string | null
  department: string | null
  agent: AgentKind
  model: string | null
  subagentType: string | null
  tool: string
  category: ToolCategory
  target: AgentEventTarget
  decision: ToolDecision
  guardReason: GuardReason | null
  outcome: ToolOutcome | null
  /** The app build that sent it (X-ACB-Client-Version), when it said. */
  clientVersion: string | null
}

export interface AgentEventQuery {
  /** ISO; inclusive. */
  from?: string
  /** ISO; exclusive. */
  to?: string
  userId?: string
  category?: ToolCategory
  decision?: ToolDecision
  conversationId?: string
  /** Part of the target (path, program, host, MCP server), A–Z case-insensitive. */
  q?: string
  cursor?: string
  /** 1–200, default 50. */
  limit?: number
}

export interface AgentEventPage {
  /** Newest first. */
  events: AgentEventRecord[]
  /** Pass as `cursor` for the next (older) page; null at the end. */
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// GET …/agent-events/summary?from&to&tzOffsetMinutes
// ---------------------------------------------------------------------------

export interface AgentEventDailyCount {
  /** YYYY-MM-DD in the requested time zone offset. */
  day: string
  userId: string
  total: number
  /** Refused calls (DENIED_DECISIONS). */
  denied: number
  byCategory: Partial<Record<ToolCategory, number>>
}

export interface AgentEventSummary {
  from: string
  to: string
  tzOffsetMinutes: number
  /** Per member and day, oldest day first. */
  days: AgentEventDailyCount[]
  /** The members named in `days`. */
  members: Array<{ userId: string; name: string | null; email: string | null }>
}

// ---------------------------------------------------------------------------
// Settings (GET any reader of the settings card = owner/admin; PUT owner/admin)
// ---------------------------------------------------------------------------

export interface AgentEventSettingsValues {
  retentionDays: number
  viewers: AgentEventViewerMode
}

export interface AgentEventSettingsChange {
  id: string
  changedAt: string
  changedBy: string
  name: string | null
  email: string | null
  before: AgentEventSettingsValues
  after: AgentEventSettingsValues
}

export interface AgentEventSettings extends AgentEventSettingsValues {
  /** null while the defaults were never changed. */
  updatedAt: string | null
  updatedBy: string | null
  /** The latest changes, newest first (≤ 20). */
  history: AgentEventSettingsChange[]
}

/** PUT …/agent-events/settings: either field, or both. */
export type AgentEventSettingsUpdate = Partial<AgentEventSettingsValues>

/** GET …/agent-events/settings/retention-preview?days=N */
export interface AgentEventRetentionPreview {
  days: number
  /** Events at or after this instant stay. */
  olderThan: string
  wouldDelete: number
}

/** GET …/agent-events/viewers?mode= — who would see the log under that mode. */
export interface AgentEventViewer {
  userId: string
  name: string | null
  email: string | null
  role: string
  /** `all` (owner/admin) or `departments` (a manager: only the listed departments' part). */
  scope: 'all' | 'departments'
  departments: Array<{ id: string; name: string; folder: string }>
}

export interface AgentEventViewers {
  mode: AgentEventViewerMode
  viewers: AgentEventViewer[]
}
