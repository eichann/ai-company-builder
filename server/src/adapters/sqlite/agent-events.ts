import type Database from 'better-sqlite3'
import type {
  AgentEventFilter,
  AgentEventRepository,
  AgentEventRow,
  AgentEventSettingsChangeRow,
  AgentEventSettingsRepository,
  StoredAgentEventSettings,
} from '../../ports/agent-events'

type Row = {
  seq: number
  id: string
  call_id: string
  user_id: string
  received_at: string
  at: string
  client_at: string
  at_adjusted: number
  duration_ms: number | null
  conversation_id: string | null
  turn_id: string | null
  department: string | null
  agent: string
  model: string | null
  subagent_type: string | null
  tool: string
  category: string
  target: string
  decision: string
  guard_reason: string | null
  outcome: string | null
  sandbox: string | null
  skill: string | null
  client_version: string | null
}

const COLUMNS = `seq, id, call_id, user_id, received_at, at, client_at, at_adjusted, duration_ms, conversation_id, turn_id,
  department, agent, model, subagent_type, tool, category, target, decision, guard_reason, outcome, sandbox, skill, client_version`

function toRow(r: Row): AgentEventRow {
  let target: unknown = { kind: 'none' }
  try { target = JSON.parse(r.target) } catch { /* stored by insertMany as JSON; keep 'none' if not */ }
  return {
    seq: r.seq,
    id: r.id,
    callId: r.call_id,
    userId: r.user_id,
    receivedAt: r.received_at,
    at: r.at,
    clientAt: r.client_at,
    atAdjusted: r.at_adjusted === 1,
    durationMs: r.duration_ms,
    conversationId: r.conversation_id,
    turnId: r.turn_id,
    department: r.department,
    agent: r.agent,
    model: r.model,
    subagentType: r.subagent_type,
    tool: r.tool,
    category: r.category,
    target,
    decision: r.decision,
    guardReason: r.guard_reason,
    outcome: r.outcome,
    sandbox: r.sandbox,
    skill: r.skill,
    clientVersion: r.client_version,
  }
}

/** `%`, `_` and `\` taken literally in a LIKE … ESCAPE '\'. */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`)

function where(companyId: string, f: AgentEventFilter): { sql: string; params: unknown[] } {
  const clauses = ['company_id = ?']
  const params: unknown[] = [companyId]
  if (f.from) { clauses.push('at >= ?'); params.push(f.from) }
  if (f.to) { clauses.push('at < ?'); params.push(f.to) }
  if (f.userId) { clauses.push('user_id = ?'); params.push(f.userId) }
  if (f.category) { clauses.push('category = ?'); params.push(f.category) }
  if (f.decision) { clauses.push('decision = ?'); params.push(f.decision) }
  if (f.conversationId) { clauses.push('conversation_id = ?'); params.push(f.conversationId) }
  if (f.q) { clauses.push(`target_text LIKE ? ESCAPE '\\'`); params.push(`%${likeLiteral(f.q)}%`) }
  if (f.rootKeys) {
    if (f.rootKeys.length === 0) clauses.push('0')
    else {
      const marks = f.rootKeys.map(() => '?').join(', ')
      const roots = f.rootKeys.map(() => `instr(target_roots, ?) > 0`).join(' OR ')
      clauses.push(`(department_key IN (${marks}) OR ${roots})`)
      params.push(...f.rootKeys, ...f.rootKeys.map(k => `\n${k}\n`))
    }
  }
  return { sql: clauses.join(' AND '), params }
}

export function sqliteAgentEventRepository(conn: Database.Database): AgentEventRepository {
  return {
    insertMany(companyId, events) {
      const insert = conn.prepare(`
        INSERT OR IGNORE INTO agent_events (
          company_id, id, user_id, received_at, at, client_at, at_adjusted, version, call_id, duration_ms,
          conversation_id, turn_id, department, department_key, agent, model, subagent_type, tool, category,
          target_kind, target, target_text, target_roots, decision, guard_reason, outcome, sandbox, skill, client_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      return conn.transaction(() => {
        let stored = 0
        for (const e of events) {
          stored += insert.run(
            companyId, e.id, e.userId, e.receivedAt, e.at, e.clientAt, e.atAdjusted ? 1 : 0, e.callId, e.durationMs,
            e.conversationId, e.turnId, e.department, e.departmentKey, e.agent, e.model, e.subagentType, e.tool, e.category,
            e.targetKind, JSON.stringify(e.target), e.targetText, e.targetRoots.length ? `\n${e.targetRoots.join('\n')}\n` : '',
            e.decision, e.guardReason, e.outcome, e.sandbox, e.skill, e.clientVersion,
          ).changes
        }
        return stored
      })()
    },

    page(companyId, filter, after, limit) {
      const w = where(companyId, filter)
      const cursor = after ? ' AND (at < ? OR (at = ? AND seq < ?))' : ''
      const params = after ? [...w.params, after.at, after.at, after.seq] : w.params
      return (conn.prepare(`SELECT ${COLUMNS} FROM agent_events WHERE ${w.sql}${cursor} ORDER BY at DESC, seq DESC LIMIT ?`)
        .all(...params, limit) as Row[]).map(toRow)
    },

    dailyCounts(companyId, filter, deniedDecisions, tzModifier) {
      const w = where(companyId, filter)
      const denied = deniedDecisions.length ? `decision IN (${deniedDecisions.map(() => '?').join(', ')})` : '0'
      const rows = conn.prepare(`
        SELECT strftime('%Y-%m-%d', at, ?) AS day, user_id, category, ${denied} AS denied, COUNT(*) AS n
        FROM agent_events WHERE ${w.sql}
        GROUP BY day, user_id, category, denied
        ORDER BY day ASC, user_id ASC, category ASC
      `).all(tzModifier, ...deniedDecisions, ...w.params) as Array<{ day: string; user_id: string; category: string; denied: number; n: number }>
      return rows.map(r => ({ day: r.day, userId: r.user_id, category: r.category, denied: r.denied === 1, count: r.n }))
    },

    sandboxEvents(companyId, from, to, limit) {
      return (conn.prepare(`
        SELECT ${COLUMNS} FROM agent_events
        WHERE company_id = ? AND at >= ? AND at < ? AND (sandbox IS NOT NULL OR guard_reason IN ('denied-read', 'sandbox'))
        ORDER BY at DESC, seq DESC LIMIT ?
      `).all(companyId, from, to, limit) as Row[]).map(toRow)
    },

    countBefore(companyId, cutoff) {
      return (conn.prepare('SELECT COUNT(*) AS n FROM agent_events WHERE company_id = ? AND at < ?').get(companyId, cutoff) as { n: number }).n
    },

    deleteBefore(companyId, cutoff, max) {
      return conn.prepare(`
        DELETE FROM agent_events WHERE seq IN (
          SELECT seq FROM agent_events WHERE company_id = ? AND at < ? ORDER BY at ASC LIMIT ?
        )
      `).run(companyId, cutoff, max).changes
    },

    companiesWithEvents() {
      return (conn.prepare('SELECT DISTINCT company_id FROM agent_events').all() as Array<{ company_id: string }>).map(r => r.company_id)
    },
  }
}

export function sqliteAgentEventSettingsRepository(conn: Database.Database): AgentEventSettingsRepository {
  const parse = (s: string): AgentEventSettingsChangeRow['before'] => {
    try {
      const v = JSON.parse(s) as { retentionDays?: unknown; viewers?: unknown }
      return { retentionDays: Number(v.retentionDays), viewers: String(v.viewers) }
    } catch {
      return { retentionDays: 0, viewers: '' }
    }
  }
  return {
    get(companyId): StoredAgentEventSettings | null {
      const r = conn.prepare('SELECT retention_days, viewers, updated_at, updated_by FROM agent_event_settings WHERE company_id = ?')
        .get(companyId) as { retention_days: number; viewers: string; updated_at: string; updated_by: string | null } | undefined
      return r ? { retentionDays: r.retention_days, viewers: r.viewers, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },

    save(companyId, s, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO agent_event_settings (company_id, retention_days, viewers, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(company_id) DO UPDATE SET retention_days = excluded.retention_days, viewers = excluded.viewers,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, s.retentionDays, s.viewers, s.updatedAt, s.updatedBy)
        conn.prepare(`INSERT INTO agent_event_settings_history (id, company_id, changed_at, changed_by, before, after) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(change.id, companyId, change.changedAt, change.changedBy, JSON.stringify(change.before), JSON.stringify(change.after))
      })()
    },

    history(companyId, limit) {
      const rows = conn.prepare(`
        SELECT id, changed_at, changed_by, before, after FROM agent_event_settings_history
        WHERE company_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT ?
      `).all(companyId, limit) as Array<{ id: string; changed_at: string; changed_by: string; before: string; after: string }>
      return rows.map(r => ({ id: r.id, changedAt: r.changed_at, changedBy: r.changed_by, before: parse(r.before), after: parse(r.after) }))
    },
  }
}
