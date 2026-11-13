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
import type { ExternalReceipt, LedgerEntry, LedgerVia } from '../../../shared/core/record-ledger'
import { parseSkillUses } from '../../../shared/core/skill-uses'
import type {
  DriveLinkMeta, RecordAccessRow, RecordCandidateFilter, RecordLinkRow, RecordMemberSet, RecordProblemRow, RecordRepoKey, RecordRepository,
  RecordRow, RecordStateRow, RecordTypeRow,
  MeetingEventRow,
} from '../../ports/records'
import { BUNDLE_PART_ENDED_ACTION, coreTypeDefinitions, DECISION_VERSION, MIGRATION_ACTOR, OUTSIDE_TIME_ACTION, TASK_VERSION } from '../../../shared/core/core-types'
import { canonicalTypeJson } from '../../../shared/core/record-types'
import { CONTENT_REF_PREFIX } from '../../../shared/core/record-contents'
import { sqliteContentStore } from './record-contents'
import { skillUsesJson } from './skill-uses'

/**
 * Members-only records (「この人たちだけ」, records.md "Members-only records"): marked by this value
 * in `personal_owner`, their readers in `record_viewers`. An older server build reads the marker
 * as an owner id no member has, so it shows the record to nobody (fails closed). It never leaves
 * this module: rows come out as `personalOwner: null, members: [...]`.
 */
const MEMBERS_ONLY = '@members'
/** The list of a marked row (`alias`: the records table's name in the statement), oldest added first. */
const membersColumn = (alias: string) => `CASE WHEN ${alias}.personal_owner = '${MEMBERS_ONLY}' THEN (SELECT json_group_array(user_id) FROM
  (SELECT v.user_id FROM record_viewers v WHERE v.company_id = ${alias}.company_id AND v.record_id = ${alias}.id ORDER BY v.added_at, v.user_id)) END AS members_json`
const membersOf = (json: string | null): string[] | null => {
  if (json === null) return null
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
const ownerOf = (personalOwner: string | null) => personalOwner === MEMBERS_ONLY ? null : personalOwner
/**
 * The groups and departments on a marked row's list (`record_viewer_sets`), each with who is in it
 * now — read here, never stored, like a place rule's `memberIds` (permission-store.ts): changing a
 * group or who belongs to a department changes who reads at once.
 */
const memberSetsColumn = (alias: string) => `CASE WHEN ${alias}.personal_owner = '${MEMBERS_ONLY}' THEN (SELECT json_group_array(json_object(
    'type', s.subject_type, 'id', s.subject_id, 'memberIds', json(CASE s.subject_type
      WHEN 'group' THEN (SELECT json_group_array(g.user_id) FROM member_group_members g WHERE g.company_id = s.company_id AND g.group_id = s.subject_id)
      ELSE (SELECT json_group_array(d.user_id) FROM department_members d WHERE d.company_id = s.company_id AND d.department_id = s.subject_id) END)))
  FROM (SELECT * FROM record_viewer_sets v WHERE v.company_id = ${alias}.company_id AND v.record_id = ${alias}.id ORDER BY v.added_at, v.subject_type, v.subject_id) s) END AS sets_json`
const memberSetsOf = (json: string | null): RecordMemberSet[] | undefined => {
  if (json === null) return undefined
  try {
    const list = JSON.parse(json) as unknown
    if (!Array.isArray(list)) return []
    return list.flatMap((x: Record<string, unknown>) => (x && (x.type === 'group' || x.type === 'department') && typeof x.id === 'string')
      ? [{ type: x.type, id: x.id, memberIds: Array.isArray(x.memberIds) ? x.memberIds.filter((u): u is string => typeof u === 'string') : [] }]
      : [])
  } catch { return [] }
}

type Row = {
  id: string; type: string; type_version: number | null; scope_id: string | null; path: string | null; folder: string | null; personal_owner: string | null
  members_json: string | null; sets_json: string | null; title: string; summary: string; created_at: string; updated_at: string; removed_at: string | null
}
const COLUMNS = `id, type, type_version, scope_id, path, folder, personal_owner, ${membersColumn('records')}, ${memberSetsColumn('records')}, title, summary, created_at, updated_at, removed_at`
/** `memberSets` only on a marked row that has some (absent otherwise, so a row of people reads exactly as before). */
const withSets = (json: string | null) => { const sets = memberSetsOf(json); return sets === undefined || sets.length === 0 ? {} : { memberSets: sets } }
const toRecord = (r: Row): RecordRow => ({
  id: r.id, type: r.type, typeVersion: r.type_version, scopeId: r.scope_id, path: r.path, folder: r.folder, personalOwner: ownerOf(r.personal_owner),
  members: membersOf(r.members_json), ...withSets(r.sets_json), title: r.title, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at, removedAt: r.removed_at,
})
type LinkRow = { source_id: string; name: string; position: number; target_id: string | null; target_path: string | null; created_by: string | null; target_meta: string | null }
/** A Drive link's kept facts (records.md "Drive and PC file links"); anything unreadable is none. */
function driveMetaOf(text: string | null): DriveLinkMeta | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    if (typeof v !== 'object' || v === null || typeof v.name !== 'string' || typeof v.linkedAt !== 'string') return null
    return {
      name: v.name, linkedAt: v.linkedAt,
      revisionId: typeof v.revisionId === 'string' ? v.revisionId : null,
      sha256: typeof v.sha256 === 'string' ? v.sha256 : null,
      mimeType: typeof v.mimeType === 'string' ? v.mimeType : null,
    }
  } catch {
    return null
  }
}
const toLink = (r: LinkRow): RecordLinkRow => {
  const drive = driveMetaOf(r.target_meta)
  return { sourceId: r.source_id, name: r.name, position: r.position, targetId: r.target_id, targetPath: r.target_path, createdBy: r.created_by ?? null, ...(drive ? { drive } : {}) }
}

type LedgerRow = {
  record_id: string; version: number; action: string; from_state: string | null; to_state: string | null; actor_id: string
  actor_kind: LedgerEntry['actorKind']; actor_source: string | null; at: string; note: string; changes: string; attachments: string
  decision: string | null; is_decision: number; type_version: number | null; reverses_version: number | null
  proposed_by: string | null; conversation_id: string | null; receipt: string | null; on_behalf_of: string | null; run_id: string | null
  procedure: string | null; skills: string | null; via: string | null
}
const toLedger = (r: LedgerRow): LedgerEntry => ({
  recordId: r.record_id, version: r.version, action: r.action, fromState: r.from_state, toState: r.to_state, actorId: r.actor_id,
  actorKind: r.actor_kind, actorSource: r.actor_source, at: r.at, note: r.note, changes: JSON.parse(r.changes), attachments: JSON.parse(r.attachments),
  decision: r.decision ? JSON.parse(r.decision) : null, isDecision: r.is_decision === 1, typeVersion: r.type_version, reversesVersion: r.reverses_version,
  proposedBy: r.proposed_by === 'ai' ? 'ai' : null, conversationId: r.conversation_id,
  receipt: r.receipt ? JSON.parse(r.receipt) as ExternalReceipt : null,
  runId: r.run_id,
  ...(r.run_id ? { procedure: parseAiRunProcedure(r.procedure) } : {}),
  ...(r.skills ? { skills: parseSkillUses(r.skills) } : {}),
  ...(r.on_behalf_of ? { onBehalfOf: r.on_behalf_of } : {}),
  ...(r.via ? { via: parseLedgerVia(r.via) } : {}),
})

/** A stored `via` (`{ plugin, version }`), or null when it is not that shape. */
function parseLedgerVia(text: string): LedgerVia | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    return v && typeof v.plugin === 'string' && typeof v.version === 'string' ? { plugin: v.plugin, version: v.version } : null
  } catch { return null }
}

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

/**
 * Meeting version 2 (records.md "Outside time"): every meeting whose server values have
 * `meeting_at` but no `occurred_at` gets it, as a new ledger entry (action
 * OUTSIDE_TIME_ACTION, the server's migration actor) with a compare-and-set on the
 * version — the ledger stays the record's history and replays to the same values.
 * Idempotent: a meeting carried over (or written by the version 2 intake) is skipped.
 */
export function migrateCompanyOutsideTimes(conn: Database.Database, companyId: string, at: string): number {
  return conn.transaction(() => {
    const rows = conn.prepare(`
      SELECT s.record_id, s.state, s.version, json_extract(s.fields, '$.meeting_at') AS meeting_at FROM record_state s
      JOIN records r ON r.company_id = s.company_id AND r.id = s.record_id
      WHERE s.company_id = ? AND r.type = 'meeting' AND json_valid(s.fields)
        AND json_type(s.fields, '$.meeting_at') = 'text' AND json_type(s.fields, '$.occurred_at') IS NULL
    `).all(companyId) as Array<{ record_id: string; state: string | null; version: number; meeting_at: string }>
    const write = conn.prepare(`
      UPDATE record_state SET fields = json_set(fields, '$.occurred_at', ?), version = version + 1, updated_at = ?
      WHERE company_id = ? AND record_id = ? AND version = ?
    `)
    const entry = conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at,
        note, changes, attachments, is_decision, type_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '[]', 0, 2)`)
    // The record now holds what version 2 asks (the index row says which version it was made under).
    const version2 = conn.prepare(`UPDATE records SET type_version = 2 WHERE company_id = ? AND id = ? AND (type_version IS NULL OR type_version < 2)`)
    let moved = 0
    for (const r of rows) {
      if (write.run(r.meeting_at, at, companyId, r.record_id, r.version).changes !== 1) continue
      version2.run(companyId, r.record_id)
      entry.run(companyId, r.record_id, r.version + 1, OUTSIDE_TIME_ACTION, r.state, r.state, MIGRATION_ACTOR.id, MIGRATION_ACTOR.kind,
        MIGRATION_ACTOR.source, at, JSON.stringify([{ field: 'occurred_at', before: null, after: r.meeting_at }]))
      moved++
    }
    return moved
  })()
}

/**
 * Meeting version 4 (minutes.md "A まとまり chosen later"): a meeting left in version 3's
 * `bundle_waiting` / `bundle_working` (an AI run for the まとまり's part, which is no more) goes back
 * to `read`, as a new ledger entry (action BUNDLE_PART_ENDED_ACTION, the server's migration
 * actor — cause `system`, never a person) with a compare-and-set on the version. Idempotent:
 * nothing is left in those states afterwards.
 */
export function migrateCompanyBundleParts(conn: Database.Database, companyId: string, at: string): number {
  return conn.transaction(() => {
    const rows = conn.prepare(`
      SELECT s.record_id, s.state, s.version FROM record_state s
      JOIN records r ON r.company_id = s.company_id AND r.id = s.record_id
      WHERE s.company_id = ? AND r.type = 'meeting' AND s.state IN ('bundle_waiting', 'bundle_working')
    `).all(companyId) as Array<{ record_id: string; state: string; version: number }>
    const write = conn.prepare(`UPDATE record_state SET state = 'read', version = version + 1, updated_at = ? WHERE company_id = ? AND record_id = ? AND version = ?`)
    const entry = conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at,
        note, changes, attachments, is_decision, type_version) VALUES (?, ?, ?, ?, ?, 'read', ?, ?, ?, ?, '', ?, '[]', 0, 4)`)
    const version4 = conn.prepare(`UPDATE records SET type_version = 4 WHERE company_id = ? AND id = ? AND (type_version IS NULL OR type_version < 4)`)
    let moved = 0
    for (const r of rows) {
      if (write.run(at, companyId, r.record_id, r.version).changes !== 1) continue
      version4.run(companyId, r.record_id)
      entry.run(companyId, r.record_id, r.version + 1, BUNDLE_PART_ENDED_ACTION, r.state, MIGRATION_ACTOR.id, MIGRATION_ACTOR.kind, MIGRATION_ACTOR.source, at,
        JSON.stringify([{ field: 'state', before: r.state, after: 'read' }]))
      moved++
    }
    return moved
  })()
}

/**
 * Task versions 9 and up (records.md "Task version 9"): every task of a company whose map holds the task
 * type is moved to `TASK_VERSION`. The core definition of that version is stored first when no
 * version at least as new is there (as `ensureCoreTypes` would on the next index run), so the
 * engine answers by it from the first request. Only the index row's `type_version` changes — no
 * value does (9 only adds), so no ledger entry and nothing in the 経緯. Idempotent; returns the
 * tasks moved.
 */
export function migrateCompanyTaskVersion(conn: Database.Database, companyId: string, at: string): number {
  return migrateCompanyCoreTypeVersion(conn, companyId, 'task', TASK_VERSION, at)
}

/**
 * The same for decisions (decision version 6, records.md "Decisions": `DECISION_VERSION`). Additive:
 * no value changes, no ledger entry.
 */
export function migrateCompanyDecisionVersion(conn: Database.Database, companyId: string, at: string): number {
  return migrateCompanyCoreTypeVersion(conn, companyId, 'decision', DECISION_VERSION, at)
}

/** One core type's records moved to `version` (the core definition stored first when missing). */
function migrateCompanyCoreTypeVersion(conn: Database.Database, companyId: string, type: string, version: number, at: string): number {
  return conn.transaction(() => {
    const stored = conn.prepare(`SELECT MAX(version) AS v FROM record_types WHERE company_id = ? AND name = ?`).get(companyId, type) as { v: number | null }
    if (stored.v === null) return 0
    if (stored.v < version) {
      const def = coreTypeDefinitions().find(d => d.name === type)
      if (!def || def.version !== version) throw new Error(`core ${type} definition is not at version ${version}`)
      conn.prepare(`INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES (?, ?, ?, ?, 'core', NULL, ?)`)
        .run(companyId, type, def.version, canonicalTypeJson(def), at)
    }
    return conn.prepare(`UPDATE records SET type_version = ? WHERE company_id = ? AND type = ? AND (type_version IS NULL OR type_version < ?)`)
      .run(version, companyId, type, version).changes
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
  /** One calendar event as the minutes' discovery knows it (`meeting_events`). */
  function meetingEventRow(eventKey: string): MeetingEventRow | null {
    const r = conn.prepare('SELECT event_key, record_id, private, tries, next_at FROM meeting_events WHERE company_id = ? AND event_key = ?').get(companyId, eventKey) as
      { event_key: string; record_id: string | null; private: number; tries: number; next_at: string | null } | undefined
    return r ? { eventKey: r.event_key, recordId: r.record_id, private: r.private === 1, tries: r.tries, nextAt: r.next_at } : null
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
    meetingBundleDays() {
      const r = conn.prepare('SELECT meeting_bundle_days FROM record_settings WHERE company_id = ?').get(companyId) as { meeting_bundle_days: number | null } | undefined
      return r?.meeting_bundle_days ?? null
    },
    setMeetingBundleDays(days, by, at) {
      // A new row keeps the feature off (enabled 0); an existing row keeps its switch.
      conn.prepare(`
        INSERT INTO record_settings (company_id, enabled, updated_at, updated_by, meeting_bundle_days) VALUES (?, 0, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET meeting_bundle_days = excluded.meeting_bundle_days, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(companyId, at, by, days)
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
      if (Array.isArray(row.members) && row.personalOwner) throw new Error('a record is owner-only or members-only, not both')
      if (Array.isArray(row.members)) {
        // Members-only is written on insert only: an existing row keeps its place, so asking for a
        // list on one that is not already members-only would leave it wider than asked (fail closed).
        const was = conn.prepare('SELECT personal_owner FROM records WHERE company_id = ? AND id = ?').get(companyId, row.id) as { personal_owner: string | null } | undefined
        if (was && was.personal_owner !== MEMBERS_ONLY) throw new Error('members asked for an existing record that is not members-only')
      }
      const b = contents.batch(row.id, row.type)
      const title = b.put(row.title)
      const summary = b.put(row.summary)
      conn.prepare(`
        INSERT INTO records (company_id, id, type, type_version, scope_id, path, folder, personal_owner, title, summary, created_at, updated_at, removed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, id) DO UPDATE SET type = excluded.type, type_version = excluded.type_version, scope_id = excluded.scope_id,
          path = excluded.path, folder = excluded.folder, title = excluded.title, summary = excluded.summary,
          updated_at = excluded.updated_at, removed_at = excluded.removed_at
      `).run(companyId, row.id, row.type, row.typeVersion, row.scopeId, row.path, row.folder, Array.isArray(row.members) ? MEMBERS_ONLY : row.personalOwner ?? null,
        title, summary, row.createdAt, row.updatedAt, row.removedAt)
      b.flush(row.updatedAt)
    },
    setPlace(id, place, at) {
      conn.prepare('UPDATE records SET folder = ?, personal_owner = ?, updated_at = ? WHERE company_id = ? AND id = ?')
        .run(place.folder, place.personalOwner, at, companyId, id)
      // No longer members-only: its list goes (the ledger keeps who was on it).
      conn.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ?').run(companyId, id)
      conn.prepare('DELETE FROM record_viewer_sets WHERE company_id = ? AND record_id = ?').run(companyId, id)
    },
    addMembers(id, userIds, by, at) {
      const marked = conn.prepare('SELECT 1 FROM records WHERE company_id = ? AND id = ? AND personal_owner = ?').get(companyId, id, MEMBERS_ONLY)
      // Never quietly nothing: the caller believes the record is read by a list (fail closed, inside its transaction).
      if (!marked) throw new Error('not a members-only record')
      const add = conn.prepare('INSERT OR IGNORE INTO record_viewers (company_id, record_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?, ?)')
      return [...new Set(userIds)].filter(userId => add.run(companyId, id, userId, at, by).changes > 0)
    },
    addMemberSets(id, sets, by, at) {
      const marked = conn.prepare('SELECT 1 FROM records WHERE company_id = ? AND id = ? AND personal_owner = ?').get(companyId, id, MEMBERS_ONLY)
      if (!marked) throw new Error('not a members-only record')
      const add = conn.prepare('INSERT OR IGNORE INTO record_viewer_sets (company_id, record_id, subject_type, subject_id, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?)')
      const seen = new Set<string>()
      return sets.filter(s => {
        const key = `${s.type}:${s.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return add.run(companyId, id, s.type, s.id, at, by).changes > 0
      }).map(s => ({ type: s.type, id: s.id }))
    },
    removeMembers(id, userIds, sets) {
      const marked = conn.prepare('SELECT 1 FROM records WHERE company_id = ? AND id = ? AND personal_owner = ?').get(companyId, id, MEMBERS_ONLY)
      if (!marked) throw new Error('not a members-only record')
      const dropUser = conn.prepare('DELETE FROM record_viewers WHERE company_id = ? AND record_id = ? AND user_id = ?')
      const dropSet = conn.prepare('DELETE FROM record_viewer_sets WHERE company_id = ? AND record_id = ? AND subject_type = ? AND subject_id = ?')
      return {
        users: [...new Set(userIds)].filter(u => dropUser.run(companyId, id, u).changes > 0),
        sets: sets.filter(s => dropSet.run(companyId, id, s.type, s.id).changes > 0).map(s => ({ type: s.type, id: s.id })),
      }
    },
    forgetMember(userId) {
      conn.prepare('DELETE FROM record_viewers WHERE company_id = ? AND user_id = ?').run(companyId, userId)
      conn.prepare('DELETE FROM meeting_auto_series WHERE company_id = ? AND user_id = ?').run(companyId, userId)
    },
    meetingEvent(eventKey) {
      return meetingEventRow(eventKey)
    },
    setMeetingEvent(eventKey, change, at) {
      const now = meetingEventRow(eventKey) ?? { eventKey, recordId: null, private: false, tries: 0, nextAt: null }
      const next = { ...now, ...change }
      conn.prepare(`
        INSERT INTO meeting_events (company_id, event_key, record_id, private, tries, next_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, event_key) DO UPDATE SET record_id = excluded.record_id, private = excluded.private, tries = excluded.tries,
          next_at = excluded.next_at, updated_at = excluded.updated_at
      `).run(companyId, eventKey, next.recordId, next.private ? 1 : 0, next.tries, next.nextAt, at)
    },
    listedRecordIds(userId, type) {
      return (conn.prepare(`SELECT v.record_id FROM record_viewers v JOIN records r ON r.company_id = v.company_id AND r.id = v.record_id
        WHERE v.company_id = ? AND v.user_id = ? AND r.type = ? AND r.removed_at IS NULL`).all(companyId, userId, type) as Array<{ record_id: string }>).map(r => r.record_id)
    },
    meetingAutoSeries(userId) {
      return (conn.prepare('SELECT series_key FROM meeting_auto_series WHERE company_id = ? AND user_id = ? ORDER BY series_key').all(companyId, userId) as Array<{ series_key: string }>)
        .map(r => r.series_key)
    },
    setMeetingAutoSeries(userId, seriesKey, auto, at) {
      if (auto) conn.prepare('INSERT OR IGNORE INTO meeting_auto_series (company_id, user_id, series_key, created_at) VALUES (?, ?, ?, ?)').run(companyId, userId, seriesKey, at)
      else conn.prepare('DELETE FROM meeting_auto_series WHERE company_id = ? AND user_id = ? AND series_key = ?').run(companyId, userId, seriesKey)
    },
    markRemoved(id, at) {
      conn.prepare('UPDATE records SET removed_at = ?, updated_at = ? WHERE company_id = ? AND id = ? AND removed_at IS NULL').run(at, at, companyId, id)
      conn.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(companyId, id)
    },

    driveFileFixed(fileId) {
      // The ledger keeps materials / attachments as JSON; a Drive one carries `"kind":"drive","fileId":"<id>"`. The id is
      // Google's (letters, digits, - and _): `_` is escaped for LIKE.
      const like = `%"fileId":"${fileId.replace(/[\\%_]/g, ch => `\\${ch}`)}"%`
      return conn.prepare(`SELECT 1 FROM record_ledger WHERE company_id = ? AND (attachments LIKE ? ESCAPE '\\' OR decision LIKE ? ESCAPE '\\') LIMIT 1`)
        .get(companyId, like, like) !== undefined
    },
    linksFrom(ids) {
      if (ids.length === 0) return []
      return (conn.prepare('SELECT source_id, name, position, target_id, target_path, created_by, target_meta FROM record_links WHERE company_id = ? AND source_id IN (SELECT value FROM json_each(?)) ORDER BY source_id, name, position')
        .all(companyId, JSON.stringify(ids)) as LinkRow[]).map(toLink)
    },
    linksTo(ids) {
      if (ids.length === 0) return []
      return (conn.prepare('SELECT source_id, name, position, target_id, target_path, created_by, target_meta FROM record_links WHERE company_id = ? AND target_id IN (SELECT value FROM json_each(?)) ORDER BY source_id, name, position')
        .all(companyId, JSON.stringify(ids)) as LinkRow[]).map(toLink)
    },
    fileLinksTo(paths) {
      if (paths.length === 0) return []
      return (conn.prepare('SELECT source_id, name, position, target_id, target_path, created_by, target_meta FROM record_links WHERE company_id = ? AND target_path IN (SELECT value FROM json_each(?)) ORDER BY source_id, name, position')
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
    placedIn(folder) {
      // At or under `folder` without LIKE (folder names may hold _ and %), as moveFolder.
      return (conn.prepare("SELECT id FROM records WHERE company_id = ? AND removed_at IS NULL AND (folder = @f OR substr(folder, 1, length(@f) + 1) = @f || '/')")
        .all(companyId, { f: folder }) as Array<{ id: string }>).map(r => r.id)
    },
    replaceLinks(sourceId, links) {
      conn.prepare('DELETE FROM record_links WHERE company_id = ? AND source_id = ?').run(companyId, sourceId)
      const insert = conn.prepare('INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path, created_by, target_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const l of links) insert.run(companyId, sourceId, l.name, l.position, l.targetId, l.targetPath, l.createdBy ?? null, l.drive ? JSON.stringify(l.drive) : null)
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
          decision, is_decision, type_version, reverses_version, proposed_by, conversation_id, receipt, on_behalf_of, run_id, procedure, skills, via FROM record_ledger WHERE company_id = ? AND record_id = ? ORDER BY version`)
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
      // The AI's entry copies the Skills its consultation had used by now (records.md "Which Skill").
      conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at, note,
          changes, attachments, decision, is_decision, type_version, reverses_version, proposed_by, conversation_id, receipt, on_behalf_of, run_id, procedure, skills, via)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT procedure FROM ai_runs WHERE company_id = ? AND id = ?), ?, ?)`)
        .run(companyId, e.recordId, e.version, e.action, e.fromState, e.toState, e.actorId, e.actorKind, e.actorSource, e.at, e.note,
          JSON.stringify(e.changes), JSON.stringify(e.attachments), e.decision ? JSON.stringify(e.decision) : null, e.isDecision ? 1 : 0,
          e.typeVersion, e.reversesVersion, e.proposedBy, e.conversationId, e.receipt ? JSON.stringify(e.receipt) : null, e.onBehalfOf ?? null, e.runId ?? null,
          companyId, e.runId ?? null, e.actorKind === 'ai' ? skillUsesJson(conn, companyId, e.actorId, e.conversationId) : null,
          e.via ? JSON.stringify({ plugin: e.via.plugin, version: e.via.version }) : null)
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
      // Most recently changed first: an action moves only record_state, so its time counts too
      // (the summary's updatedAt is the later of the two; an archived task sorts by when it was archived).
      let order = 'max(r.updated_at, coalesce(s.updated_at, r.updated_at)) DESC, r.id'
      if (filter.sort) {
        // The field name is bound; only the direction is spliced, from a closed set. Empty values last.
        const dir = filter.sort.order === 'desc' ? 'DESC' : 'ASC'
        order = `json_extract(s.fields, ?) IS NULL, json_extract(s.fields, ?) ${dir}, ${order}`
        params.push(`$.${filter.sort.field}`, `$.${filter.sort.field}`)
      }
      params.push(limit)
      const extra = where.map(w => ` AND ${w}`).join('')
      return (conn.prepare(`
        SELECT r.id, r.type, r.scope_id, r.path, r.folder, r.personal_owner, ${membersColumn('r')}, ${memberSetsColumn('r')} FROM records r
        LEFT JOIN record_state s ON s.company_id = r.company_id AND s.record_id = r.id
        WHERE r.company_id = ? AND r.removed_at IS NULL${extra}
        ORDER BY ${order} LIMIT ?
      `).all(...params) as Array<{ id: string; type: string; scope_id: string | null; path: string | null; folder: string | null; personal_owner: string | null; members_json: string | null; sets_json: string | null }>)
        .map(r => ({ id: r.id, type: r.type, scopeId: r.scope_id, path: r.path, folder: r.folder, personalOwner: ownerOf(r.personal_owner), members: membersOf(r.members_json), ...withSets(r.sets_json) }))
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
