/**
 * The AI action log (monitoring M1): what members' apps report about each
 * tool call their AI made (shared/types/agent-events.ts), stored per company,
 * read by the admin console, pruned after the company's retention.
 *
 * Who may do what:
 * - send (`ingest`): any member, for themselves — the user is the session's,
 *   never the body's;
 * - read (`list`, `summary`): owner/admin always; a department manager only
 *   while the company's `viewers` setting is 'admins-and-managers', and then
 *   only events whose department, or a file of whose target, lies in a
 *   department they manage — with every path they cannot read (a private
 *   folder they are not a viewer of, a folder closed to them) shown as
 *   `{ kind: 'hidden' }` and never matched by the target search;
 * - settings, the retention preview, the viewer list: owner/admin.
 *
 * Nothing here logs event contents.
 */
import type { AccountDirectory } from '../ports/accounts'
import type {
  AgentEventCursor,
  AgentEventFilter,
  AgentEventRepository,
  AgentEventRow,
  AgentEventSettingsRepository,
  NewAgentEvent,
} from '../ports/agent-events'
import type { Clock, IdGenerator } from '../ports/clock'
import type { DepartmentRepository } from '../ports/departments'
import type { MembershipRepository } from '../ports/memberships'
import type { ScopeRepository } from '../ports/scopes'
import { foldAsciiCase, pathKey } from '../../shared/core/paths'
import { resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import {
  AGENT_EVENT_VIEWER_MODES,
  AGENT_EVENTS_DEFAULT_RETENTION_DAYS,
  AGENT_EVENTS_MAX_AGE_MS,
  AGENT_EVENTS_MAX_FUTURE_SKEW_MS,
  AGENT_EVENTS_MAX_PER_REQUEST,
  AGENT_EVENTS_MAX_RETENTION_DAYS,
  AGENT_EVENTS_MIN_RETENTION_DAYS,
  AGENT_EVENTS_RATE_LIMIT,
  AGENT_EVENTS_RATE_WINDOW_MS,
  AGENT_KINDS,
  DENIED_DECISIONS,
  GUARD_REASONS,
  TOOL_CATEGORIES,
  TOOL_DECISIONS,
  TOOL_OUTCOMES,
  parseAgentToolEvent,
  parseToolTarget,
  type AgentEventDailyCount,
  type AgentEventIngestResult,
  type AgentEventPage,
  type AgentEventRecord,
  type AgentEventRetentionPreview,
  type AgentEventSettings,
  type AgentEventSettingsValues,
  type AgentEventSummary,
  type AgentEventTarget,
  type AgentEventViewer,
  type AgentEventViewerMode,
  type AgentEventViewers,
  type ShownFileTarget,
  type ToolCategory,
  type ToolTarget,
} from '../../shared/types/agent-events'
import { hasFullAccess, requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const AGENT_EVENTS_READ_FORBIDDEN = 'Only owners and admins can view the AI action log'
export const AGENT_EVENTS_SETTINGS_FORBIDDEN = 'Only owners and admins can manage the AI action log settings'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** A manager's page with a target search scans at most this many rows, then hands back a cursor. */
const MAX_SCAN = 2000
const MAX_Q = 200
const MAX_SUMMARY_DAYS = 400
const DEFAULT_SUMMARY_DAYS = 30
const HISTORY_LIMIT = 20
const PRUNE_CHUNK = 500
const RATE_TABLE_LIMIT = 10_000

export interface AgentEventDeps {
  agentEvents: AgentEventRepository
  agentEventSettings: AgentEventSettingsRepository
  memberships: MembershipRepository
  scopes: ScopeRepository
  departments: DepartmentRepository
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  /** Let other work run between prune chunks (setImmediate in production). */
  yieldNow?: () => Promise<void>
}

/** Raw query-string values. */
export type RawQuery = Record<string, string | undefined>

const has = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)
const pick = <T extends string>(list: readonly T[], value: string, fallback: T): T => (has(list, value) ? value : fallback)
const pickOrNull = <T extends string>(list: readonly T[], value: string | null): T | null => (has(list, value) ? value : null)

/** Searchable parts of a target, one per entry. */
function targetParts(t: AgentEventTarget): string[] {
  switch (t.kind) {
    case 'file': return [t.path]
    case 'files': return t.files.flatMap(f => (f.kind === 'file' ? [f.path] : []))
    case 'command': return t.programs
    case 'web': return t.host ? [t.host] : []
    case 'mcp': return t.tool ? [t.server, t.tool] : [t.server]
    case 'subagent': return t.subagentType ? [t.subagentType] : []
    default: return []
  }
}

/** First segment of every file path in the target, as key. */
function targetRoots(t: ToolTarget): string[] {
  const paths = t.kind === 'file' ? [t.path] : t.kind === 'files' ? t.files.flatMap(f => (f.kind === 'file' ? [f.path] : [])) : []
  return [...new Set(paths.map(p => pathKey(p).split('/')[0]).filter(Boolean))]
}

function parseIso(value: string | undefined): string | null | undefined {
  if (value === undefined || value === '') return undefined
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

function intParam(value: string | undefined, min: number, max: number): number | null | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^-?\d+$/.test(value)) return null
  const n = Number(value)
  return n >= min && n <= max ? n : null
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_(\d{1,15})$/
const encodeCursor = (row: { at: string; seq: number }) => `${row.at}_${row.seq}`
function decodeCursor(value: string): AgentEventCursor | null {
  const m = CURSOR_RE.exec(value)
  return m ? { at: m[1], seq: Number(m[2]) } : null
}

const hasControlCharacter = (s: string) => [...s].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
const shortText = (value: string | undefined, max: number) =>
  value !== undefined && value.length > 0 && value.length <= max && !hasControlCharacter(value) ? value : undefined

interface ListQuery {
  filter: AgentEventFilter
  cursor: AgentEventCursor | null
  limit: number
}

/** GET …/agent-events query → filter, or the 400 answer. */
export function parseListQuery(raw: RawQuery): Outcome<ListQuery> {
  const from = parseIso(raw.from)
  const to = parseIso(raw.to)
  if (from === null) return refuse('bad-request', 'Invalid from (ISO date expected)')
  if (to === null) return refuse('bad-request', 'Invalid to (ISO date expected)')
  if (raw.category !== undefined && raw.category !== '' && !has(TOOL_CATEGORIES, raw.category)) return refuse('bad-request', 'Invalid category')
  if (raw.decision !== undefined && raw.decision !== '' && !has(TOOL_DECISIONS, raw.decision)) return refuse('bad-request', 'Invalid decision')
  const limit = intParam(raw.limit, 1, MAX_LIMIT)
  if (limit === null) return refuse('bad-request', `Invalid limit (1–${MAX_LIMIT})`)
  let cursor: AgentEventCursor | null = null
  if (raw.cursor) {
    cursor = decodeCursor(raw.cursor)
    if (!cursor) return refuse('bad-request', 'Invalid cursor')
  }
  const q = raw.q?.normalize('NFC').trim()
  if (q && q.length > MAX_Q) return refuse('bad-request', `q is too long (at most ${MAX_Q} characters)`)
  return ok({
    filter: {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(shortText(raw.userId, 200) ? { userId: raw.userId } : {}),
      ...(raw.category ? { category: raw.category } : {}),
      ...(raw.decision ? { decision: raw.decision } : {}),
      ...(shortText(raw.conversationId, 100) ? { conversationId: raw.conversationId } : {}),
      ...(q ? { q } : {}),
    },
    cursor,
    limit: limit ?? DEFAULT_LIMIT,
  })
}

/** Who reads, and what they may see. */
type Reader =
  | { all: true }
  | { all: false; rootKeys: string[]; canRead: (path: string) => boolean }

export function createAgentEventService(deps: AgentEventDeps) {
  const { agentEvents: events, agentEventSettings, memberships, scopes, departments, accounts, clock, ids } = deps
  const yieldNow = deps.yieldNow ?? (() => Promise.resolve())
  const budget = new Map<string, { windowStart: number; used: number }>()

  function settingsOf(companyId: string): AgentEventSettingsValues & { updatedAt: string | null; updatedBy: string | null } {
    const s = agentEventSettings.get(companyId)
    if (!s) return { retentionDays: AGENT_EVENTS_DEFAULT_RETENTION_DAYS, viewers: 'admins', updatedAt: null, updatedBy: null }
    const days = Number.isInteger(s.retentionDays) && s.retentionDays >= AGENT_EVENTS_MIN_RETENTION_DAYS && s.retentionDays <= AGENT_EVENTS_MAX_RETENTION_DAYS
      ? s.retentionDays
      : AGENT_EVENTS_DEFAULT_RETENTION_DAYS
    return { retentionDays: days, viewers: pick(AGENT_EVENT_VIEWER_MODES, s.viewers, 'admins'), updatedAt: s.updatedAt, updatedBy: s.updatedBy }
  }

  function settingsView(companyId: string): AgentEventSettings {
    const s = settingsOf(companyId)
    const history = agentEventSettings.history(companyId, HISTORY_LIMIT)
    const users = accounts.byIds([...new Set(history.map(h => h.changedBy))])
    const values = (v: { retentionDays: number; viewers: string }): AgentEventSettingsValues => ({
      retentionDays: v.retentionDays,
      viewers: pick(AGENT_EVENT_VIEWER_MODES, v.viewers, 'admins'),
    })
    return {
      retentionDays: s.retentionDays,
      viewers: s.viewers,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
      history: history.map(h => ({
        id: h.id,
        changedAt: h.changedAt,
        changedBy: h.changedBy,
        name: users.get(h.changedBy)?.name ?? null,
        email: users.get(h.changedBy)?.email ?? null,
        before: values(h.before),
        after: values(h.after),
      })),
    }
  }

  function managedDepartments(companyId: string, userId: string) {
    const managed = new Set(scopes.managedDepartmentIds(companyId, userId))
    if (managed.size === 0) return []
    return departments.listByCompany(companyId).filter(d => managed.has(d.id))
  }

  function readerOf(member: Member): Outcome<Reader> {
    if (hasFullAccess(member.role)) return ok({ all: true })
    if (settingsOf(member.companyId).viewers !== 'admins-and-managers') return refuse('forbidden', AGENT_EVENTS_READ_FORBIDDEN)
    const managed = managedDepartments(member.companyId, member.userId)
    if (managed.length === 0) return refuse('forbidden', AGENT_EVENTS_READ_FORBIDDEN)
    const list = scopes.listWithRules(member.companyId)
    const repo: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => list }
    const cache = new Map<string, boolean>()
    return ok({
      all: false,
      rootKeys: [...new Set(managed.map(d => pathKey(d.folder)))],
      canRead(path) {
        let readable = cache.get(path)
        if (readable === undefined) {
          readable = resolveAccess(member.companyId, member.userId, path, repo).read
          cache.set(path, readable)
        }
        return readable
      },
    })
  }

  function shownTarget(target: ToolTarget, reader: Reader): AgentEventTarget {
    if (reader.all) return target
    const file = (f: ShownFileTarget): ShownFileTarget => (f.kind === 'file' && !reader.canRead(f.path) ? { kind: 'hidden' } : f)
    if (target.kind === 'file') return file(target)
    if (target.kind === 'files') return { ...target, files: target.files.map(file) }
    return target
  }

  function toRecord(row: AgentEventRow, reader: Reader, users: ReturnType<AccountDirectory['byIds']>): AgentEventRecord {
    const target = parseToolTarget(row.target) ?? { kind: 'none' }
    const u = users.get(row.userId)
    const department = row.department && (reader.all || reader.canRead(row.department)) ? row.department : null
    return {
      id: row.id,
      callId: row.callId,
      userId: row.userId,
      name: u?.name ?? null,
      email: u?.email ?? null,
      at: row.at,
      atAdjusted: row.atAdjusted,
      receivedAt: row.receivedAt,
      durationMs: row.durationMs,
      conversationId: row.conversationId,
      turnId: row.turnId,
      department,
      agent: pick(AGENT_KINDS, row.agent, 'claude-code'),
      model: row.model,
      subagentType: row.subagentType,
      tool: row.tool,
      category: pick(TOOL_CATEGORIES, row.category, 'other'),
      target: shownTarget(target, reader),
      decision: pick(TOOL_DECISIONS, row.decision, 'policy-default'),
      guardReason: pickOrNull(GUARD_REASONS, row.guardReason),
      outcome: pickOrNull(TOOL_OUTCOMES, row.outcome),
      clientVersion: row.clientVersion,
    }
  }

  /** Take `n` events from the member's budget; the seconds to wait when it is spent. */
  function takeBudget(companyId: string, userId: string, n: number): number | null {
    const now = clock.nowMs()
    const key = `${companyId}\u0000${userId}`
    if (budget.size > RATE_TABLE_LIMIT) {
      for (const [k, b] of budget) if (now - b.windowStart >= AGENT_EVENTS_RATE_WINDOW_MS) budget.delete(k)
    }
    let b = budget.get(key)
    if (!b || now - b.windowStart >= AGENT_EVENTS_RATE_WINDOW_MS) {
      b = { windowStart: now, used: 0 }
      budget.set(key, b)
    }
    if (b.used + n > AGENT_EVENTS_RATE_LIMIT) return Math.max(1, Math.ceil((b.windowStart + AGENT_EVENTS_RATE_WINDOW_MS - now) / 1000))
    b.used += n
    return null
  }

  return {
    /** POST …/agent-events: store the caller's events. */
    ingest(member: Member, body: unknown, clientVersion: string | null): Outcome<AgentEventIngestResult> {
      const list = body && typeof body === 'object' && !Array.isArray(body) ? (body as { events?: unknown }).events : undefined
      if (!Array.isArray(list)) return refuse('bad-request', 'Expected { events: [...] }')
      if (list.length > AGENT_EVENTS_MAX_PER_REQUEST) {
        return refuse('too-large', `At most ${AGENT_EVENTS_MAX_PER_REQUEST} events per request`, { code: 'TOO_MANY_EVENTS', max: AGENT_EVENTS_MAX_PER_REQUEST })
      }
      if (list.length === 0) return ok({ accepted: 0, duplicates: 0, rejected: 0 })
      const wait = takeBudget(member.companyId, member.userId, list.length)
      if (wait !== null) return refuse('rate-limited', 'Too many events; try again later', { code: 'RATE_LIMITED', retryAfterSeconds: wait })

      const receivedAt = clock.now()
      const nowMs = clock.nowMs()
      const version = shortText(clientVersion ?? undefined, 100) ?? null
      const rows: NewAgentEvent[] = []
      let rejected = 0
      for (const raw of list) {
        const e = parseAgentToolEvent(raw)
        if (!e) { rejected++; continue }
        const t = Date.parse(e.at)
        const clientAt = new Date(t).toISOString()
        const plausible = t >= nowMs - AGENT_EVENTS_MAX_AGE_MS && t <= nowMs + AGENT_EVENTS_MAX_FUTURE_SKEW_MS
        rows.push({
          id: e.id,
          callId: e.callId,
          userId: member.userId,
          receivedAt,
          at: plausible ? clientAt : receivedAt,
          clientAt,
          atAdjusted: !plausible,
          durationMs: e.durationMs ?? null,
          conversationId: e.conversationId ?? null,
          turnId: e.turnId ?? null,
          department: e.department ?? null,
          departmentKey: e.department ? pathKey(e.department) : null,
          agent: e.agent,
          model: e.model ?? null,
          subagentType: e.subagentType ?? null,
          tool: e.tool,
          category: e.category,
          target: e.target,
          targetKind: e.target.kind,
          targetText: targetParts(e.target).join('\n'),
          targetRoots: targetRoots(e.target),
          decision: e.decision,
          guardReason: e.guardReason ?? null,
          outcome: e.outcome ?? null,
          clientVersion: version,
        })
      }
      const accepted = rows.length > 0 ? events.insertMany(member.companyId, rows) : 0
      return ok({ accepted, duplicates: rows.length - accepted, rejected })
    },

    /** GET …/agent-events: a page, newest first. */
    list(member: Member, raw: RawQuery): Outcome<AgentEventPage> {
      const reader = readerOf(member)
      if (!reader.ok) return reader
      const query = parseListQuery(raw)
      if (!query.ok) return query
      const { filter, limit } = query.value
      const r = reader.value
      const sqlFilter: AgentEventFilter = r.all ? filter : { ...filter, rootKeys: r.rootKeys }
      // A manager's search must not match what they cannot see: the SQL match
      // (over the full target) is re-checked on the target as shown.
      const q = !r.all && filter.q ? foldAsciiCase(filter.q) : null
      const matches = (target: AgentEventTarget) => !q || targetParts(target).some(p => foldAsciiCase(p).includes(q))

      const picked: AgentEventRecord[] = []
      const page = (next: AgentEventCursor | null): Outcome<AgentEventPage> => ok({ events: picked, nextCursor: next ? encodeCursor(next) : null })
      let cursor = query.value.cursor
      let scanned = 0
      // One row more than a page: when it exists, the page ends before it and
      // the cursor points at the last row looked at.
      const chunk = limit + 1
      for (;;) {
        const rows = events.page(member.companyId, sqlFilter, cursor, chunk)
        const names = accounts.byIds([...new Set(rows.map(x => x.userId))])
        for (const row of rows) {
          if (picked.length === limit) return page(cursor)
          scanned++
          const record = toRecord(row, r, names)
          if (matches(record.target)) picked.push(record)
          cursor = { at: row.at, seq: row.seq }
        }
        if (rows.length < chunk) return page(null)
        if (scanned >= MAX_SCAN) return page(cursor)
      }
    },

    /** GET …/agent-events/summary: counts per member and day (+ per category). */
    summary(member: Member, raw: RawQuery): Outcome<AgentEventSummary> {
      const reader = readerOf(member)
      if (!reader.ok) return reader
      const toIso = parseIso(raw.to)
      const fromIso = parseIso(raw.from)
      if (toIso === null) return refuse('bad-request', 'Invalid to (ISO date expected)')
      if (fromIso === null) return refuse('bad-request', 'Invalid from (ISO date expected)')
      const tz = intParam(raw.tzOffsetMinutes, -720, 840)
      if (tz === null) return refuse('bad-request', 'Invalid tzOffsetMinutes (-720–840)')
      // Default: up to now (plus the clock skew an event's time may have).
      const to = toIso ?? new Date(clock.nowMs() + AGENT_EVENTS_MAX_FUTURE_SKEW_MS).toISOString()
      const from = fromIso ?? new Date(Date.parse(to) - DEFAULT_SUMMARY_DAYS * DAY_MS).toISOString()
      if (Date.parse(from) >= Date.parse(to)) return refuse('bad-request', 'from must be before to')
      if (Date.parse(to) - Date.parse(from) > MAX_SUMMARY_DAYS * DAY_MS) return refuse('bad-request', `At most ${MAX_SUMMARY_DAYS} days`)
      const offset = tz ?? 0
      const r = reader.value
      const filter: AgentEventFilter = { from, to, ...(r.all ? {} : { rootKeys: r.rootKeys }) }
      const counts = events.dailyCounts(member.companyId, filter, [...DENIED_DECISIONS], `${offset >= 0 ? '+' : ''}${offset} minutes`)

      const byKey = new Map<string, AgentEventDailyCount>()
      for (const c of counts) {
        const key = `${c.day}\u0000${c.userId}`
        let d = byKey.get(key)
        if (!d) { d = { day: c.day, userId: c.userId, total: 0, denied: 0, byCategory: {} }; byKey.set(key, d) }
        d.total += c.count
        if (c.denied) d.denied += c.count
        const category: ToolCategory = pick(TOOL_CATEGORIES, c.category, 'other')
        d.byCategory[category] = (d.byCategory[category] ?? 0) + c.count
      }
      const days = [...byKey.values()]
      const users = accounts.byIds([...new Set(days.map(d => d.userId))])
      return ok({
        from,
        to,
        tzOffsetMinutes: offset,
        days,
        members: [...new Set(days.map(d => d.userId))].map(userId => ({ userId, name: users.get(userId)?.name ?? null, email: users.get(userId)?.email ?? null })),
      })
    },

    /** GET …/agent-events/settings (owner/admin). */
    settings(member: Member): Outcome<AgentEventSettings> {
      const allowed = requireFullAccess(member, AGENT_EVENTS_SETTINGS_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(settingsView(member.companyId))
    },

    /** PUT …/agent-events/settings (owner/admin): either field, or both; every change is recorded. */
    updateSettings(member: Member, body: unknown): Outcome<AgentEventSettings> {
      const allowed = requireFullAccess(member, AGENT_EVENTS_SETTINGS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('bad-request', 'Invalid JSON body')
      const b = body as Record<string, unknown>
      if (b.retentionDays === undefined && b.viewers === undefined) return refuse('bad-request', 'Nothing to change (retentionDays, viewers)')
      if (b.retentionDays !== undefined && !(typeof b.retentionDays === 'number' && Number.isInteger(b.retentionDays)
        && b.retentionDays >= AGENT_EVENTS_MIN_RETENTION_DAYS && b.retentionDays <= AGENT_EVENTS_MAX_RETENTION_DAYS)) {
        return refuse('bad-request', `retentionDays must be an integer from ${AGENT_EVENTS_MIN_RETENTION_DAYS} to ${AGENT_EVENTS_MAX_RETENTION_DAYS}`)
      }
      if (b.viewers !== undefined && !has(AGENT_EVENT_VIEWER_MODES, b.viewers)) {
        return refuse('bad-request', `viewers must be one of ${AGENT_EVENT_VIEWER_MODES.join(', ')}`)
      }
      const current = settingsOf(member.companyId)
      const before: AgentEventSettingsValues = { retentionDays: current.retentionDays, viewers: current.viewers }
      const after: AgentEventSettingsValues = {
        retentionDays: (b.retentionDays as number | undefined) ?? before.retentionDays,
        viewers: (b.viewers as AgentEventViewerMode | undefined) ?? before.viewers,
      }
      if (after.retentionDays !== before.retentionDays || after.viewers !== before.viewers) {
        const at = clock.now()
        agentEventSettings.save(
          member.companyId,
          { ...after, updatedAt: at, updatedBy: member.userId },
          { id: ids.newId(), changedAt: at, changedBy: member.userId, before, after },
        )
      }
      return ok(settingsView(member.companyId))
    },

    /** GET …/agent-events/settings/retention-preview?days=N (owner/admin): what a shorter retention would delete. */
    retentionPreview(member: Member, rawDays: string | undefined): Outcome<AgentEventRetentionPreview> {
      const allowed = requireFullAccess(member, AGENT_EVENTS_SETTINGS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const days = intParam(rawDays, AGENT_EVENTS_MIN_RETENTION_DAYS, AGENT_EVENTS_MAX_RETENTION_DAYS)
      if (days === null || days === undefined) {
        return refuse('bad-request', `days must be an integer from ${AGENT_EVENTS_MIN_RETENTION_DAYS} to ${AGENT_EVENTS_MAX_RETENTION_DAYS}`)
      }
      const olderThan = new Date(clock.nowMs() - days * DAY_MS).toISOString()
      return ok({ days, olderThan, wouldDelete: events.countBefore(member.companyId, olderThan) })
    },

    /** GET …/agent-events/viewers?mode= (owner/admin): who would see the log, and which part. */
    viewers(member: Member, rawMode: string | undefined): Outcome<AgentEventViewers> {
      const allowed = requireFullAccess(member, AGENT_EVENTS_SETTINGS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (rawMode !== undefined && rawMode !== '' && !has(AGENT_EVENT_VIEWER_MODES, rawMode)) {
        return refuse('bad-request', `mode must be one of ${AGENT_EVENT_VIEWER_MODES.join(', ')}`)
      }
      const mode: AgentEventViewerMode = rawMode ? (rawMode as AgentEventViewerMode) : settingsOf(member.companyId).viewers
      const rows = memberships.listByCompany(member.companyId)
      const departmentRows = mode === 'admins-and-managers' ? departments.listByCompany(member.companyId) : []
      const found: Array<Omit<AgentEventViewer, 'name' | 'email'>> = []
      for (const m of rows) {
        if (hasFullAccess(m.role)) { found.push({ userId: m.user_id, role: m.role, scope: 'all', departments: [] }); continue }
        if (mode !== 'admins-and-managers') continue
        const managed = new Set(scopes.managedDepartmentIds(member.companyId, m.user_id))
        const theirs = departmentRows.filter(d => managed.has(d.id)).map(d => ({ id: d.id, name: d.name, folder: d.folder }))
        if (theirs.length > 0) found.push({ userId: m.user_id, role: m.role, scope: 'departments', departments: theirs })
      }
      const rank = (v: { role: string; scope: string }) => (v.role === 'owner' ? 0 : v.scope === 'all' ? 1 : 2)
      found.sort((a, b) => rank(a) - rank(b))
      const users = accounts.byIds(found.map(v => v.userId))
      return ok({
        mode,
        viewers: found.map(v => ({ ...v, name: users.get(v.userId)?.name ?? null, email: users.get(v.userId)?.email ?? null })),
      })
    },

    /**
     * Delete events past each company's retention, in chunks with a pause
     * between them so requests keep being served. Returns how many went.
     */
    async prune(): Promise<{ deleted: number }> {
      let deleted = 0
      for (const companyId of events.companiesWithEvents()) {
        const cutoff = new Date(clock.nowMs() - settingsOf(companyId).retentionDays * DAY_MS).toISOString()
        for (;;) {
          const n = events.deleteBefore(companyId, cutoff, PRUNE_CHUNK)
          deleted += n
          await yieldNow()
          if (n < PRUNE_CHUNK) break
        }
      }
      return { deleted }
    },

    /** Tests: forget every member's rate budget. */
    resetRateLimits() {
      budget.clear()
    },
  }
}

export type AgentEventService = ReturnType<typeof createAgentEventService>
