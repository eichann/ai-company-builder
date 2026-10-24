/**
 * The AI action log (monitoring M1): stored events and the per-company
 * settings. Shapes on the wire: shared/types/agent-events.ts (whose types
 * these rows reuse; ports may import only shared/core and other ports, so the
 * few unions are repeated as strings here and checked by the service).
 */

/** One stored event (the agent_events row, parsed). */
export interface AgentEventRow {
  /** Insertion order, the tie-break after `at`. */
  seq: number
  id: string
  callId: string
  userId: string
  receivedAt: string
  at: string
  clientAt: string
  atAdjusted: boolean
  durationMs: number | null
  conversationId: string | null
  turnId: string | null
  department: string | null
  agent: string
  model: string | null
  subagentType: string | null
  tool: string
  category: string
  /** The target as the app sent it (validated), JSON-decoded. */
  target: unknown
  decision: string
  guardReason: string | null
  outcome: string | null
  clientVersion: string | null
}

/** A row to store: the event plus what the reads filter on. */
export interface NewAgentEvent extends Omit<AgentEventRow, 'seq'> {
  targetKind: string
  /** Searchable parts of the target (paths, programs, host, MCP server/tool), one per line. */
  targetText: string
  /** First path segment of every file in the target, as key (NFC, A–Z folded). */
  targetRoots: string[]
  /** The department as key (NFC, A–Z folded), or null. */
  departmentKey: string | null
}

export interface AgentEventFilter {
  /** ISO; at >= from. */
  from?: string
  /** ISO; at < to. */
  to?: string
  userId?: string
  category?: string
  decision?: string
  conversationId?: string
  /** target_text contains it (A–Z case-insensitive). */
  q?: string
  /** Only events whose department, or a file of whose target, lies in one of these root folders (keys). */
  rootKeys?: string[]
}

/** Position in the newest-first order. */
export interface AgentEventCursor {
  at: string
  seq: number
}

export interface AgentEventDailyRow {
  day: string
  userId: string
  category: string
  denied: boolean
  count: number
}

export interface AgentEventRepository {
  /** Store new events; ones whose (company, id) is already stored are skipped. Returns how many were stored. */
  insertMany(companyId: string, events: NewAgentEvent[]): number
  /** Newest first (at, then seq), strictly after `after` when given. */
  page(companyId: string, filter: AgentEventFilter, after: AgentEventCursor | null, limit: number): AgentEventRow[]
  /** Counts per day (at shifted by `tzModifier`, an SQLite modifier like '+540 minutes'), member, category and denied-or-not. */
  dailyCounts(companyId: string, filter: AgentEventFilter, deniedDecisions: string[], tzModifier: string): AgentEventDailyRow[]
  /** Events with at < cutoff. */
  countBefore(companyId: string, cutoff: string): number
  /** Delete at most `max` events with at < cutoff. Returns how many went. */
  deleteBefore(companyId: string, cutoff: string, max: number): number
  /** Companies that have events. */
  companiesWithEvents(): string[]
}

export interface StoredAgentEventSettings {
  retentionDays: number
  viewers: string
  updatedAt: string
  updatedBy: string | null
}

export interface AgentEventSettingsChangeRow {
  id: string
  changedAt: string
  changedBy: string
  before: { retentionDays: number; viewers: string }
  after: { retentionDays: number; viewers: string }
}

export interface AgentEventSettingsRepository {
  /** null while the company never changed the defaults. */
  get(companyId: string): StoredAgentEventSettings | null
  /** Write the settings and their history row together. */
  save(companyId: string, settings: StoredAgentEventSettings, change: AgentEventSettingsChangeRow): void
  /** Newest first. */
  history(companyId: string, limit: number): AgentEventSettingsChangeRow[]
}
