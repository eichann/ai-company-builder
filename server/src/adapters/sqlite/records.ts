/**
 * SQLite storage of the company map (ports/records.ts), bound to one
 * company: built only by the company handle (adapters/sqlite/company-data.ts),
 * every statement limited to `companyId`.
 *
 * Lists of ids are bound as one JSON array (`json_each(?)`), so a query never
 * builds SQL from values and never hits the bound-parameter limit.
 */
import type Database from 'better-sqlite3'
import type { ExternalReceipt, LedgerEntry } from '../../../shared/core/record-ledger'
import type {
  RecordAccessRow, RecordCandidateFilter, RecordLinkRow, RecordProblemRow, RecordRepoKey, RecordRepository,
  RecordRow, RecordStateRow, RecordTypeRow,
} from '../../ports/records'

type Row = {
  id: string; type: string; type_version: number | null; scope_id: string | null; path: string | null; folder: string | null
  title: string; summary: string; created_at: string; updated_at: string; removed_at: string | null
}
const COLUMNS = 'id, type, type_version, scope_id, path, folder, title, summary, created_at, updated_at, removed_at'
const toRecord = (r: Row): RecordRow => ({
  id: r.id, type: r.type, typeVersion: r.type_version, scopeId: r.scope_id, path: r.path, folder: r.folder,
  title: r.title, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at, removedAt: r.removed_at,
})
type LinkRow = { source_id: string; name: string; position: number; target_id: string | null; target_path: string | null }
const toLink = (r: LinkRow): RecordLinkRow => ({ sourceId: r.source_id, name: r.name, position: r.position, targetId: r.target_id, targetPath: r.target_path })

type LedgerRow = {
  record_id: string; version: number; action: string; from_state: string | null; to_state: string | null; actor_id: string
  actor_kind: LedgerEntry['actorKind']; actor_source: string | null; at: string; note: string; changes: string; attachments: string
  decision: string | null; is_decision: number; type_version: number | null; reverses_version: number | null
  proposed_by: string | null; conversation_id: string | null; receipt: string | null
}
const toLedger = (r: LedgerRow): LedgerEntry => ({
  recordId: r.record_id, version: r.version, action: r.action, fromState: r.from_state, toState: r.to_state, actorId: r.actor_id,
  actorKind: r.actor_kind, actorSource: r.actor_source, at: r.at, note: r.note, changes: JSON.parse(r.changes), attachments: JSON.parse(r.attachments),
  decision: r.decision ? JSON.parse(r.decision) : null, isDecision: r.is_decision === 1, typeVersion: r.type_version, reversesVersion: r.reverses_version,
  proposedBy: r.proposed_by === 'ai' ? 'ai' : null, conversationId: r.conversation_id,
  receipt: r.receipt ? JSON.parse(r.receipt) as ExternalReceipt : null,
})

/** A LIKE pattern matching `text` anywhere, with %, _ and \ taken literally. */
function likeAnywhere(text: string): string {
  return `%${text.replace(/[\\%_]/g, m => `\\${m}`)}%`
}

export function sqliteRecordRepository(conn: Database.Database, companyId: string): RecordRepository {
  return {
    settings() {
      const r = conn.prepare('SELECT enabled, updated_at, updated_by FROM record_settings WHERE company_id = ?').get(companyId) as
        { enabled: number; updated_at: string; updated_by: string | null } | undefined
      return r ? { enabled: r.enabled === 1, updatedAt: r.updated_at, updatedBy: r.updated_by } : { enabled: false, updatedAt: null, updatedBy: null }
    },
    setEnabled(enabled, by, at) {
      conn.prepare(`
        INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(companyId, enabled ? 1 : 0, at, by)
    },

    typeVersions() {
      return (conn.prepare('SELECT name, version, definition, source, commit_sha, created_at FROM record_types WHERE company_id = ? ORDER BY name, version')
        .all(companyId) as Array<{ name: string; version: number; definition: string; source: 'file' | 'core' | 'plugin'; commit_sha: string | null; created_at: string }>)
        .map(r => ({ name: r.name, version: r.version, definition: r.definition, source: r.source, commitSha: r.commit_sha, createdAt: r.created_at }))
    },
    insertTypeVersion(row: RecordTypeRow) {
      conn.prepare('INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, row.name, row.version, row.definition, row.source, row.commitSha, row.createdAt)
    },

    find(id) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM records WHERE company_id = ? AND id = ?`).get(companyId, id) as Row | undefined
      return r ? toRecord(r) : null
    },
    findByPath(path) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM records WHERE company_id = ? AND path = ? AND removed_at IS NULL`).get(companyId, path) as Row | undefined
      return r ? toRecord(r) : null
    },
    fileRecordsIn(scopeId) {
      return (conn.prepare(`SELECT ${COLUMNS} FROM records WHERE company_id = ? AND path IS NOT NULL AND removed_at IS NULL AND scope_id IS ?`)
        .all(companyId, scopeId) as Row[]).map(toRecord)
    },
    upsert(row) {
      conn.prepare(`
        INSERT INTO records (company_id, id, type, type_version, scope_id, path, folder, title, summary, created_at, updated_at, removed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, id) DO UPDATE SET type = excluded.type, type_version = excluded.type_version, scope_id = excluded.scope_id,
          path = excluded.path, folder = excluded.folder, title = excluded.title, summary = excluded.summary,
          updated_at = excluded.updated_at, removed_at = excluded.removed_at
      `).run(companyId, row.id, row.type, row.typeVersion, row.scopeId, row.path, row.folder, row.title, row.summary, row.createdAt, row.updatedAt, row.removedAt)
    },
    markRemoved(id, at) {
      conn.prepare('UPDATE records SET removed_at = ?, updated_at = ? WHERE company_id = ? AND id = ? AND removed_at IS NULL').run(at, at, companyId, id)
      conn.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(companyId, id)
    },

    linksFrom(ids) {
      if (ids.length === 0) return []
      return (conn.prepare('SELECT source_id, name, position, target_id, target_path FROM record_links WHERE company_id = ? AND source_id IN (SELECT value FROM json_each(?)) ORDER BY source_id, name, position')
        .all(companyId, JSON.stringify(ids)) as LinkRow[]).map(toLink)
    },
    linksTo(ids) {
      if (ids.length === 0) return []
      return (conn.prepare('SELECT source_id, name, position, target_id, target_path FROM record_links WHERE company_id = ? AND target_id IN (SELECT value FROM json_each(?)) ORDER BY source_id, name, position')
        .all(companyId, JSON.stringify(ids)) as LinkRow[]).map(toLink)
    },
    replaceLinks(sourceId, links) {
      conn.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(companyId, sourceId)
      const insert = conn.prepare('INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES (?, ?, ?, ?, ?, ?)')
      for (const l of links) insert.run(companyId, sourceId, l.name, l.position, l.targetId, l.targetPath)
    },

    states(ids) {
      if (ids.length === 0) return []
      return (conn.prepare('SELECT record_id, state, fields, version, updated_at FROM record_state WHERE company_id = ? AND record_id IN (SELECT value FROM json_each(?))')
        .all(companyId, JSON.stringify(ids)) as Array<{ record_id: string; state: string | null; fields: string; version: number; updated_at: string }>)
        .map((r): RecordStateRow => ({ recordId: r.record_id, state: r.state, fields: r.fields, version: r.version, updatedAt: r.updated_at }))
    },

    writeState(row, expectedVersion) {
      if (expectedVersion === 0) {
        const r = conn.prepare('INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(company_id, record_id) DO NOTHING')
          .run(companyId, row.recordId, row.state, row.fields, row.version, row.updatedAt)
        return r.changes === 1
      }
      const r = conn.prepare('UPDATE record_state SET state = ?, fields = ?, version = ?, updated_at = ? WHERE company_id = ? AND record_id = ? AND version = ?')
        .run(row.state, row.fields, row.version, row.updatedAt, companyId, row.recordId, expectedVersion)
      return r.changes === 1
    },

    ledger(recordId) {
      return (conn.prepare(`SELECT record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at, note, changes, attachments,
          decision, is_decision, type_version, reverses_version, proposed_by, conversation_id, receipt FROM record_ledger WHERE company_id = ? AND record_id = ? ORDER BY version`)
        .all(companyId, recordId) as LedgerRow[]).map(toLedger)
    },
    appendLedger(e: LedgerEntry) {
      conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at, note,
          changes, attachments, decision, is_decision, type_version, reverses_version, proposed_by, conversation_id, receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, e.recordId, e.version, e.action, e.fromState, e.toState, e.actorId, e.actorKind, e.actorSource, e.at, e.note,
          JSON.stringify(e.changes), JSON.stringify(e.attachments), e.decision ? JSON.stringify(e.decision) : null, e.isDecision ? 1 : 0,
          e.typeVersion, e.reversesVersion, e.proposedBy, e.conversationId, e.receipt ? JSON.stringify(e.receipt) : null)
    },

    candidates(filter: RecordCandidateFilter, limit: number): RecordAccessRow[] {
      const where: string[] = []
      const params: unknown[] = [companyId]
      if (filter.types) { where.push('r.type IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(filter.types)) }
      if (filter.ids) { where.push('r.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(filter.ids)) }
      if (filter.states) { where.push('s.state IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(filter.states)) }
      for (const f of filter.fields ?? []) {
        const values = f.values.filter(v => v !== null)
        const parts: string[] = []
        if (values.length > 0) {
          parts.push('json_extract(s.fields, ?) IN (SELECT value FROM json_each(?))')
          params.push(`$.${f.name}`, JSON.stringify(values))
        }
        if (f.values.includes(null)) { parts.push('json_extract(s.fields, ?) IS NULL'); params.push(`$.${f.name}`) }
        where.push(parts.length > 0 ? `(${parts.join(' OR ')})` : '0')
      }
      if (filter.text) {
        where.push("(r.title LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\')")
        params.push(likeAnywhere(filter.text), likeAnywhere(filter.text))
      }
      params.push(limit)
      const extra = where.map(w => ` AND ${w}`).join('')
      return (conn.prepare(`
        SELECT r.id, r.type, r.scope_id, r.path, r.folder FROM records r
        LEFT JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id
        WHERE r.company_id = ? AND r.removed_at IS NULL${extra}
        ORDER BY r.updated_at DESC, r.id LIMIT ?
      `).all(...params) as Array<{ id: string; type: string; scope_id: string | null; path: string | null; folder: string | null }>)
        .map(r => ({ id: r.id, type: r.type, scopeId: r.scope_id, path: r.path, folder: r.folder }))
    },
    byIds(ids) {
      if (ids.length === 0) return []
      return (conn.prepare(`SELECT ${COLUMNS} FROM records WHERE company_id = ? AND removed_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
        .all(companyId, JSON.stringify(ids)) as Row[]).map(toRecord)
    },

    head(repo) {
      const r = conn.prepare('SELECT commit_sha FROM record_index_heads WHERE company_id = ? AND repo = ?').get(companyId, repo) as { commit_sha: string } | undefined
      return r?.commit_sha ?? null
    },
    setHead(repo, commitSha, at) {
      conn.prepare(`
        INSERT INTO record_index_heads (company_id, repo, commit_sha, indexed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id, repo) DO UPDATE SET commit_sha = excluded.commit_sha, indexed_at = excluded.indexed_at
      `).run(companyId, repo, commitSha, at)
    },
    clearHeads() {
      conn.prepare('DELETE FROM record_index_heads WHERE company_id = ?').run(companyId)
    },

    insertAiToken(t) {
      conn.prepare(`INSERT INTO record_ai_tokens (id, company_id, user_id, token_hash, scope, agent, conversation_id, created_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(t.id, companyId, t.userId, t.tokenHash, t.scope, t.agent, t.conversationId, t.createdAt, t.expiresAt)
    },
    aiTokenByHash(tokenHash) {
      const r = conn.prepare('SELECT id, user_id, token_hash, scope, agent, conversation_id, created_at, expires_at, revoked_at FROM record_ai_tokens WHERE company_id = ? AND token_hash = ?')
        .get(companyId, tokenHash) as { id: string; user_id: string; token_hash: string; scope: 'read' | 'act'; agent: string; conversation_id: string; created_at: string; expires_at: string; revoked_at: string | null } | undefined
      return r ? {
        id: r.id, userId: r.user_id, tokenHash: r.token_hash, scope: r.scope, agent: r.agent, conversationId: r.conversation_id,
        createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
      } : null
    },
    revokeAiToken(userId, tokenId, at) {
      return conn.prepare('UPDATE record_ai_tokens SET revoked_at = ? WHERE company_id = ? AND user_id = ? AND id = ? AND revoked_at IS NULL').run(at, companyId, userId, tokenId).changes === 1
    },
    liveAiTokens(userId, now) {
      return (conn.prepare('SELECT COUNT(*) AS n FROM record_ai_tokens WHERE company_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(companyId, userId, now) as { n: number }).n
    },
    pruneAiTokens(before) {
      conn.prepare('DELETE FROM record_ai_tokens WHERE company_id = ? AND expires_at < ?').run(companyId, before)
    },

    problems(limit) {
      return (conn.prepare('SELECT repo, path, kind, detail, found_at FROM record_index_problems WHERE company_id = ? ORDER BY found_at DESC, path LIMIT ?')
        .all(companyId, limit) as Array<{ repo: RecordRepoKey; path: string; kind: string; detail: string; found_at: string }>)
        .map((r): RecordProblemRow => ({ repo: r.repo, path: r.path, kind: r.kind, detail: r.detail, foundAt: r.found_at }))
    },
    replaceProblems(repo, paths, problems) {
      if (paths === null) conn.prepare('DELETE FROM record_index_problems WHERE company_id = ? AND repo = ?').run(companyId, repo)
      else if (paths.length > 0) {
        conn.prepare('DELETE FROM record_index_problems WHERE company_id = ? AND repo = ? AND path IN (SELECT value FROM json_each(?))').run(companyId, repo, JSON.stringify(paths))
      }
      const insert = conn.prepare(`
        INSERT INTO record_index_problems (company_id, repo, path, kind, detail, found_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, repo, path, kind) DO UPDATE SET detail = excluded.detail, found_at = excluded.found_at
      `)
      for (const p of problems) insert.run(companyId, repo, p.path, p.kind, p.detail, p.foundAt)
    },
  }
}
