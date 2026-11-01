/**
 * SQLite storage of the company map (ports/records.ts), bound to one
 * company: built only by the company handle (adapters/sqlite/company-data.ts),
 * every statement limited to `companyId`.
 *
 * Lists of ids are bound as one JSON array (`json_each(?)`), so a query never
 * builds SQL from values and never hits the bound-parameter limit.
 */
import type Database from 'better-sqlite3'
import { parseAiRunProcedure } from '../../../shared/core/ai-runs'
import type { ExternalReceipt, LedgerEntry } from '../../../shared/core/record-ledger'
import type {
  RecordAccessRow, RecordCandidateFilter, RecordLinkRow, RecordProblemRow, RecordRepoKey, RecordRepository,
  RecordRow, RecordStateRow, RecordTypeRow,
} from '../../ports/records'
import { CONTENT_REF_PREFIX } from '../../../shared/core/record-contents'
import { sqliteContentStore } from './record-contents'

type Row = {
  id: string; type: string; type_version: number | null; scope_id: string | null; path: string | null; folder: string | null; personal_owner: string | null
  title: string; summary: string; created_at: string; updated_at: string; removed_at: string | null
}
const COLUMNS = 'id, type, type_version, scope_id, path, folder, personal_owner, title, summary, created_at, updated_at, removed_at'
const toRecord = (r: Row): RecordRow => ({
  id: r.id, type: r.type, typeVersion: r.type_version, scopeId: r.scope_id, path: r.path, folder: r.folder, personalOwner: r.personal_owner,
  title: r.title, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at, removedAt: r.removed_at,
})
type LinkRow = { source_id: string; name: string; position: number; target_id: string | null; target_path: string | null }
const toLink = (r: LinkRow): RecordLinkRow => ({ sourceId: r.source_id, name: r.name, position: r.position, targetId: r.target_id, targetPath: r.target_path })

type LedgerRow = {
  record_id: string; version: number; action: string; from_state: string | null; to_state: string | null; actor_id: string
  actor_kind: LedgerEntry['actorKind']; actor_source: string | null; at: string; note: string; changes: string; attachments: string
  decision: string | null; is_decision: number; type_version: number | null; reverses_version: number | null
  proposed_by: string | null; conversation_id: string | null; receipt: string | null; on_behalf_of: string | null; run_id: string | null
  procedure: string | null
}
const toLedger = (r: LedgerRow): LedgerEntry => ({
  recordId: r.record_id, version: r.version, action: r.action, fromState: r.from_state, toState: r.to_state, actorId: r.actor_id,
  actorKind: r.actor_kind, actorSource: r.actor_source, at: r.at, note: r.note, changes: JSON.parse(r.changes), attachments: JSON.parse(r.attachments),
  decision: r.decision ? JSON.parse(r.decision) : null, isDecision: r.is_decision === 1, typeVersion: r.type_version, reversesVersion: r.reverses_version,
  proposedBy: r.proposed_by === 'ai' ? 'ai' : null, conversationId: r.conversation_id,
  receipt: r.receipt ? JSON.parse(r.receipt) as ExternalReceipt : null,
  runId: r.run_id,
  ...(r.run_id ? { procedure: parseAiRunProcedure(r.procedure) } : {}),
  ...(r.on_behalf_of ? { onBehalfOf: r.on_behalf_of } : {}),
})

/** Where the content id starts in a reference (`acb-content:<id>:…`, 1-based for substr). */
const CONTENT_ID_AT = CONTENT_REF_PREFIX.length + 1

/** A LIKE pattern matching `text` anywhere, with %, _ and \ taken literally. */
function likeAnywhere(text: string): string {
  return `%${text.replace(/[\\%_]/g, m => `\\${m}`)}%`
}

/**
 * The core types stop naming a business plugin's types (owner decision 2026-11-01
 * night, records.md "Core interfaces"): links to `deal` / `customer` became links to
 * the `bundle` / `counterpart` interfaces, the `minutes` type became `meeting`
 * (会議), and the links named `minutes` / `about` were renamed. Production had no
 * record data then; staging data is carried over at startup (db/index.ts, every
 * company), idempotently — every statement matches only the old shape, so a second
 * run changes nothing — in one transaction per company:
 *
 * - records of type `minutes` become `meeting` (version 1 of the new type); their
 *   ids (`minutes-…`) stay, so the ledger, contents, notices and the app's
 *   consultations that point at them stay valid;
 * - link rows of core records are renamed: task / interaction / meeting
 *   `customer` → `counterpart`, interaction / meeting / decision `deal` → `bundle`,
 *   approval / outbound_message `about` → `bundle`, approval / outbound_message /
 *   decision `minutes` → `meeting`;
 * - an interaction's text field `counterpart` becomes `counterpart_text` (the
 *   name `counterpart` is now its link);
 * - the stored core definitions of `minutes` are dropped (the type no longer
 *   exists; a company's own file definition, if any, is left alone).
 *
 * The ledger is history and is not rewritten: an old `links.deal` entry no longer
 * matches a link of the type, so undoing it answers CHANGED_SINCE.
 */
export function migrateCompanyCoreInterfaceLinks(conn: Database.Database, companyId: string): { records: number; links: number } {
  return conn.transaction(() => {
    const records = conn.prepare(`UPDATE records SET type = 'meeting', type_version = 1 WHERE company_id = ? AND type = 'minutes'`).run(companyId).changes
    const rename = conn.prepare(`
      UPDATE record_links SET name = ?
      WHERE company_id = ? AND name = ? AND source_id IN (
        SELECT r.id FROM records r WHERE r.company_id = ? AND r.type IN (SELECT value FROM json_each(?)))
    `)
    const renames: Array<{ old: string; renamed: string; types: string[] }> = [
      { old: 'customer', renamed: 'counterpart', types: ['task', 'interaction', 'meeting'] },
      { old: 'deal', renamed: 'bundle', types: ['interaction', 'meeting', 'decision'] },
      { old: 'about', renamed: 'bundle', types: ['approval', 'outbound_message'] },
      { old: 'minutes', renamed: 'meeting', types: ['approval', 'outbound_message', 'decision'] },
    ]
    let links = 0
    for (const r of renames) links += rename.run(r.renamed, companyId, r.old, companyId, JSON.stringify(r.types)).changes
    conn.prepare(`
      UPDATE record_state SET fields = json_set(json_remove(fields, '$.counterpart'), '$.counterpart_text', json_extract(fields, '$.counterpart'))
      WHERE company_id = ? AND json_valid(fields) AND json_type(fields, '$.counterpart') IS NOT NULL AND record_id IN (
        SELECT r.id FROM records r WHERE r.company_id = ? AND r.type = 'interaction')
    `).run(companyId, companyId)
    conn.prepare(`DELETE FROM record_types WHERE company_id = ? AND name = 'minutes' AND source = 'core'`).run(companyId)
    return { records, links }
  })()
}

export function sqliteRecordRepository(conn: Database.Database, companyId: string): RecordRepository {
  // Titles, summaries, content fields, notes and reasons live in the content store
  // (./record-contents.ts): stored as references on the way in, resolved on the way out.
  const contents = sqliteContentStore(conn, companyId)
  const resolveRows = (rows: RecordRow[]): RecordRow[] => {
    const resolve = contents.resolver(rows.flatMap(r => [{ recordId: r.id, value: r.title }, { recordId: r.id, value: r.summary }]))
    return rows.map(r => ({ ...r, title: resolve(r.id, r.title), summary: resolve(r.id, r.summary) }))
  }
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
    minutesFolder() {
      const r = conn.prepare('SELECT minutes_folder FROM record_settings WHERE company_id = ?').get(companyId) as { minutes_folder: string | null } | undefined
      return r?.minutes_folder ?? null
    },
    setMinutesFolder(folder, by, at) {
      // A new row keeps the feature off (enabled 0); an existing row keeps its switch.
      conn.prepare(`
        INSERT INTO record_settings (company_id, enabled, updated_at, updated_by, minutes_folder) VALUES (?, 0, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET minutes_folder = excluded.minutes_folder, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(companyId, at, by, folder)
    },
    meetingIntake() {
      const r = conn.prepare('SELECT meeting_intake FROM record_settings WHERE company_id = ?').get(companyId) as { meeting_intake: string | null } | undefined
      return r?.meeting_intake ?? null
    },
    setMeetingIntake(value, by, at) {
      // A new row keeps the feature off (enabled 0); an existing row keeps its switch.
      conn.prepare(`
        INSERT INTO record_settings (company_id, enabled, updated_at, updated_by, meeting_intake) VALUES (?, 0, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET meeting_intake = excluded.meeting_intake, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(companyId, at, by, value)
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
      return r ? resolveRows([toRecord(r)])[0] : null
    },
    findByPath(path) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM records WHERE company_id = ? AND path = ? AND removed_at IS NULL`).get(companyId, path) as Row | undefined
      return r ? resolveRows([toRecord(r)])[0] : null
    },
    fileRecordsIn(scopeId) {
      const rows = (conn.prepare(`SELECT ${COLUMNS} FROM records WHERE company_id = ? AND path IS NOT NULL AND removed_at IS NULL AND scope_id IS ?`)
        .all(companyId, scopeId) as Row[]).map(toRecord)
      return resolveRows(rows)
    },
    upsert(row) {
      const b = contents.batch(row.id, row.type)
      const title = b.put(row.title)
      const summary = b.put(row.summary)
      conn.prepare(`
        INSERT INTO records (company_id, id, type, type_version, scope_id, path, folder, personal_owner, title, summary, created_at, updated_at, removed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, id) DO UPDATE SET type = excluded.type, type_version = excluded.type_version, scope_id = excluded.scope_id,
          path = excluded.path, folder = excluded.folder, title = excluded.title, summary = excluded.summary,
          updated_at = excluded.updated_at, removed_at = excluded.removed_at
      `).run(companyId, row.id, row.type, row.typeVersion, row.scopeId, row.path, row.folder, row.personalOwner, title, summary, row.createdAt, row.updatedAt, row.removedAt)
      b.flush(row.updatedAt)
    },
    setPlace(id, place, at) {
      conn.prepare('UPDATE records SET folder = ?, personal_owner = ?, updated_at = ? WHERE company_id = ? AND id = ?')
        .run(place.folder, place.personalOwner, at, companyId, id)
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
    fileLinksTo(paths) {
      if (paths.length === 0) return []
      return (conn.prepare('SELECT source_id, name, position, target_id, target_path FROM record_links WHERE company_id = ? AND target_path IN (SELECT value FROM json_each(?)) ORDER BY source_id, name, position')
        .all(companyId, JSON.stringify(paths)) as LinkRow[]).map(toLink)
    },
    retargetFileLinks(links) {
      const update = conn.prepare('UPDATE record_links SET target_path = ? WHERE company_id = ? AND source_id = ? AND name = ? AND position = ? AND target_id IS NULL')
      for (const l of links) update.run(l.targetPath, companyId, l.sourceId, l.name, l.position)
    },
    moveFolder(from, to) {
      // At or under `from` without LIKE (folder names may hold _ and %).
      const params = { old: from, new: to }
      conn.prepare("UPDATE records SET folder = @new || substr(folder, length(@old) + 1) WHERE company_id = ? AND (folder = @old OR substr(folder, 1, length(@old) + 1) = @old || '/')")
        .run(companyId, params)
      conn.prepare("UPDATE record_links SET target_path = @new || substr(target_path, length(@old) + 1) WHERE company_id = ? AND target_id IS NULL AND (target_path = @old OR substr(target_path, 1, length(@old) + 1) = @old || '/')")
        .run(companyId, params)
      conn.prepare('UPDATE record_settings SET minutes_folder = @new WHERE company_id = ? AND minutes_folder = @old').run(companyId, params)
    },
    replaceLinks(sourceId, links) {
      conn.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(companyId, sourceId)
      const insert = conn.prepare('INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES (?, ?, ?, ?, ?, ?)')
      for (const l of links) insert.run(companyId, sourceId, l.name, l.position, l.targetId, l.targetPath)
    },

    states(ids) {
      if (ids.length === 0) return []
      const rows = (conn.prepare(`SELECT s.record_id, s.state, s.fields, s.version, s.updated_at, r.type FROM record_state s
          LEFT JOIN records r ON r.company_id = s.company_id AND r.id = s.record_id
          WHERE s.company_id = ? AND s.record_id IN (SELECT value FROM json_each(?))`)
        .all(companyId, JSON.stringify(ids)) as Array<{ record_id: string; state: string | null; fields: string; version: number; updated_at: string; type: string | null }>)
      const fields = contents.resolveFields(rows.map(r => ({ recordId: r.record_id, type: r.type, fields: r.fields })))
      return rows.map((r, i): RecordStateRow => ({ recordId: r.record_id, state: r.state, fields: fields[i], version: r.version, updatedAt: r.updated_at }))
    },

    writeState(row, expectedVersion) {
      const type = contents.typeOfRecord(row.recordId)
      const b = contents.batch(row.recordId, type)
      const stored = contents.storeFields(b, type, row.fields)
      let r
      if (expectedVersion === 0) {
        r = conn.prepare('INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(company_id, record_id) DO NOTHING')
          .run(companyId, row.recordId, row.state, stored, row.version, row.updatedAt)
      } else {
        r = conn.prepare('UPDATE record_state SET state = ?, fields = ?, version = ?, updated_at = ? WHERE company_id = ? AND record_id = ? AND version = ?')
          .run(row.state, stored, row.version, row.updatedAt, companyId, row.recordId, expectedVersion)
      }
      // The texts only when the write happened (a lost compare-and-set stores nothing).
      if (r.changes === 1) b.flush(row.updatedAt)
      return r.changes === 1
    },

    ledger(recordId) {
      const entries = (conn.prepare(`SELECT record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at, note, changes, attachments,
          decision, is_decision, type_version, reverses_version, proposed_by, conversation_id, receipt, on_behalf_of, run_id, procedure FROM record_ledger WHERE company_id = ? AND record_id = ? ORDER BY version`)
        .all(companyId, recordId) as LedgerRow[]).map(toLedger)
      return contents.resolveEntries(recordId, contents.typeOfRecord(recordId), entries)
    },
    noteTurnOpened(o) {
      return conn.prepare(`INSERT OR IGNORE INTO record_turn_opens (company_id, record_id, turn_version, holder_id, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(companyId, o.recordId, o.turnVersion, o.holderId, o.openedBy, o.openedAt).changes === 1
    },
    turnOpens(recordId) {
      return (conn.prepare(`SELECT record_id, turn_version, holder_id, opened_by, opened_at FROM record_turn_opens WHERE company_id = ? AND record_id = ? ORDER BY turn_version`)
        .all(companyId, recordId) as Array<{ record_id: string; turn_version: number; holder_id: string; opened_by: string; opened_at: string }>)
        .map(r => ({ recordId: r.record_id, turnVersion: r.turn_version, holderId: r.holder_id, openedBy: r.opened_by, openedAt: r.opened_at }))
    },
    appendLedger(entry: LedgerEntry) {
      const type = contents.typeOfRecord(entry.recordId)
      const b = contents.batch(entry.recordId, type)
      const e = contents.storeEntry(b, type, entry)
      // An entry written in an execution run copies the run's procedure as it is now (records.md
      // "Which procedure"): a later re-claim never changes what an earlier entry says.
      conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at, note,
          changes, attachments, decision, is_decision, type_version, reverses_version, proposed_by, conversation_id, receipt, on_behalf_of, run_id, procedure)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT procedure FROM ai_runs WHERE company_id = ? AND id = ?))`)
        .run(companyId, e.recordId, e.version, e.action, e.fromState, e.toState, e.actorId, e.actorKind, e.actorSource, e.at, e.note,
          JSON.stringify(e.changes), JSON.stringify(e.attachments), e.decision ? JSON.stringify(e.decision) : null, e.isDecision ? 1 : 0,
          e.typeVersion, e.reversesVersion, e.proposedBy, e.conversationId, e.receipt ? JSON.stringify(e.receipt) : null, e.onBehalfOf ?? null, e.runId ?? null,
          companyId, e.runId ?? null)
      b.flush(e.at)
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
      for (const c of filter.contains ?? []) {
        // A tags value is the JSON text of an array of strings; anything else holds no tag.
        where.push(`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(json_extract(s.fields, ?)) AND json_type(json_extract(s.fields, ?)) = 'array'
          THEN json_extract(s.fields, ?) ELSE '[]' END) t WHERE t.type = 'text' AND t.value = ?)`)
        const at = `$.${c.name}`
        params.push(at, at, at, c.tag)
      }
      for (const r of filter.ranges ?? []) {
        if (r.gte !== undefined) { where.push('json_extract(s.fields, ?) >= ?'); params.push(`$.${r.name}`, r.gte) }
        if (r.lt !== undefined) { where.push('json_extract(s.fields, ?) < ?'); params.push(`$.${r.name}`, r.lt) }
      }
      if (filter.finishedSince) {
        // Now in a final state of its type, entered (from another state) at or after `since`.
        where.push(`r.type || ' ' || s.state IN (SELECT json_extract(value, '$.type') || ' ' || json_extract(value, '$.state') FROM json_each(?))`)
        params.push(JSON.stringify(filter.finishedSince.finals))
        where.push(`EXISTS (SELECT 1 FROM record_ledger l WHERE l.company_id = r.company_id AND l.record_id = r.id AND l.to_state = s.state
          AND (l.from_state IS NULL OR l.from_state <> l.to_state) AND l.at >= ?)`)
        params.push(filter.finishedSince.since)
      }
      if (filter.link) {
        where.push('EXISTS (SELECT 1 FROM record_links k WHERE k.company_id = r.company_id AND k.source_id = r.id AND k.name = ? AND k.target_id = ?)')
        params.push(filter.link.name, filter.link.id)
      }
      if (filter.text) {
        // Title and summary are in the content store (an erased one matches nothing); a row
        // written before the store (or by an older build) still holds its text.
        where.push(`(EXISTS (SELECT 1 FROM record_contents c WHERE c.company_id = r.company_id AND c.record_id = r.id AND c.text IS NOT NULL
            AND c.id IN (substr(r.title, ${CONTENT_ID_AT}, 32), substr(r.summary, ${CONTENT_ID_AT}, 32)) AND c.text LIKE ? ESCAPE '\\')
          OR (r.title NOT LIKE '${CONTENT_REF_PREFIX}%' AND r.title LIKE ? ESCAPE '\\')
          OR (r.summary NOT LIKE '${CONTENT_REF_PREFIX}%' AND r.summary LIKE ? ESCAPE '\\'))`)
        params.push(likeAnywhere(filter.text), likeAnywhere(filter.text), likeAnywhere(filter.text))
      }
      let order = 'r.updated_at DESC, r.id'
      if (filter.sort) {
        // The field name is bound; only the direction is spliced, from a closed set. Empty values last.
        const dir = filter.sort.order === 'desc' ? 'DESC' : 'ASC'
        order = `json_extract(s.fields, ?) IS NULL, json_extract(s.fields, ?) ${dir}, ${order}`
        params.push(`$.${filter.sort.field}`, `$.${filter.sort.field}`)
      }
      params.push(limit)
      const extra = where.map(w => ` AND ${w}`).join('')
      return (conn.prepare(`
        SELECT r.id, r.type, r.scope_id, r.path, r.folder, r.personal_owner FROM records r
        LEFT JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id
        WHERE r.company_id = ? AND r.removed_at IS NULL${extra}
        ORDER BY ${order} LIMIT ?
      `).all(...params) as Array<{ id: string; type: string; scope_id: string | null; path: string | null; folder: string | null; personal_owner: string | null }>)
        .map(r => ({ id: r.id, type: r.type, scopeId: r.scope_id, path: r.path, folder: r.folder, personalOwner: r.personal_owner }))
    },
    byIds(ids) {
      if (ids.length === 0) return []
      return resolveRows((conn.prepare(`SELECT ${COLUMNS} FROM records WHERE company_id = ? AND removed_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
        .all(companyId, JSON.stringify(ids)) as Row[]).map(toRecord))
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
      conn.prepare(`INSERT INTO record_ai_tokens (id, company_id, user_id, token_hash, scope, agent, conversation_id, created_at, expires_at, revoked_at, run_id, run_generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(t.id, companyId, t.userId, t.tokenHash, t.scope, t.agent, t.conversationId, t.createdAt, t.expiresAt,
        t.runId ?? null, t.runGeneration ?? null)
    },
    aiTokenByHash(tokenHash) {
      const r = conn.prepare('SELECT id, user_id, token_hash, scope, agent, conversation_id, created_at, expires_at, revoked_at, run_id, run_generation FROM record_ai_tokens WHERE company_id = ? AND token_hash = ?')
        .get(companyId, tokenHash) as { id: string; user_id: string; token_hash: string; scope: 'read' | 'act'; agent: string; conversation_id: string; created_at: string; expires_at: string; revoked_at: string | null; run_id: string | null; run_generation: number | null } | undefined
      return r ? {
        id: r.id, userId: r.user_id, tokenHash: r.token_hash, scope: r.scope, agent: r.agent, conversationId: r.conversation_id,
        createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, runId: r.run_id, runGeneration: r.run_generation,
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
