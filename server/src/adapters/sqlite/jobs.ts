import type Database from 'better-sqlite3'
import { EVENT_OCCURRENCE_SLOT_PREFIX, JOB_SCHEMAS, type JobDeliveryPlace, type JobPauseReason, type LedgerEventRow } from '../../../shared/core/jobs'
import type { JobState } from '../../../shared/types/jobs'
import type { JobCandidateRow, JobEventCursor, JobEventGap, JobOccurrenceRow, JobProposalRow, JobRepository, JobRow, JobVersionRow } from '../../ports/jobs'

/** A discarded candidate's fingerprint (member proposals' 「やめる」): never a `sha256:` value, so no fingerprint sent matches it. */
const DISCARDED_MARK = 'discarded'

interface JobDbRow {
  id: string; name: string; state: string; acting_user_id: string; latest_version: number
  approved_version: number | null; approved_fingerprint: string | null; accepted_version: number | null; accepted_consent: string | null
  accepted_place: string | null
  paused_reason: string | null; paused_by: string | null; paused_at: string | null
  created_by: string; created_at: string; updated_at: string
}
interface VersionDbRow {
  job_id: string; version: number; schema: number; definition: string; fingerprint: string; consent_fingerprint: string
  acting_user_id: string; created_by: string; created_at: string
  approved_by: string | null; approved_at: string | null; accepted_by: string | null; accepted_at: string | null
}

const JOB_COLUMNS = `id, name, state, acting_user_id, latest_version, approved_version, approved_fingerprint, accepted_version, accepted_consent, accepted_place,
  paused_reason, paused_by, paused_at, created_by, created_at, updated_at`
const VERSION_COLUMNS = `job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at,
  approved_by, approved_at, accepted_by, accepted_at`

interface OccurrenceDbRow {
  id: string; job_id: string; job_version: number; due_slot: string; time_zone: string; due_at: string; expires_at: string
  state: string; run_id: string | null; outcome_code: string | null; checked_until: string | null; checked_commit: string | null; created_at: string; updated_at: string
  retries: number; retried_by: string | null; retried_at: string | null
  event_seq: number | null; event_record_id: string | null; event_version: number | null; event_day: string | null
  watch_generation: number | null
}
const OCCURRENCE_COLUMNS = 'id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, run_id, outcome_code, created_at, updated_at'
const OCCURRENCE_READ = `${OCCURRENCE_COLUMNS}, checked_until, checked_commit, retries, retried_by, retried_at, event_seq, event_record_id, event_version, event_day, watch_generation`
/**
 * Newest first, by when each came: a time slot by its time (`due_at`; a job of time slots only reads exactly as it did,
 * newest slot first), an event one by when it was made (`created_at`: a scan only ever moves forward), so a job whose
 * trigger changed shows its newest occurrence first whichever kind it is (Codex review of #700); events made together
 * by their delivery number (a number: never `ev:9` after `ev:10` as text).
 */
const OCCURRENCE_ORDER = `CASE WHEN event_seq IS NULL THEN due_at ELSE created_at END DESC, COALESCE(event_seq, -1) DESC, due_slot DESC, id`
/**
 * An event occurrence (`ev:<delivery number>` slot, `isEventOccurrenceSlot`). Stage 4-0.1 (the rollback floor) left every
 * one out of this repository: it cannot check who reads its source record. **4a reads and writes them here** — the
 * clock, the runner and 「もう一度」 need them — and every answer to a person applies its own reader check instead
 * (`eventShown`, `shownOccurrences` / `occurrencesOf`, the notices; jobs.md "Event-triggered jobs"). Kept from 4-0.1:
 * `isHiddenOccurrence` (a PC run on one is a missing run: 4a has none) and `holdEventOccurrences`. Built from the core's
 * prefix (it has no `%` / `_`; `substr` compares exactly, unlike `LIKE`).
 */
const NOT_EVENT = `substr(due_slot, 1, ${EVENT_OCCURRENCE_SLOT_PREFIX.length}) <> '${EVENT_OCCURRENCE_SLOT_PREFIX}'`
/**
 * Stage 4b-0.5 (the rollback floor, jobs.md "Shapes this build does not know"): an occurrence is **frozen** when the
 * version it is pinned to is of a shape this build does not know — its `schema` column not in `JOB_SCHEMAS`, or a
 * stored text that does not say the same schema (`storedJobDefinition` reads such a version as nothing). A later
 * build wrote it; this one neither shows, counts, tells, expires, runs, claims, retries nor reconciles it: every
 * read and move below leaves it out **in SQL, before any limit**, so frozen rows never take a batch's place. Only a
 * pause / the company's stop / a restore reaches them (`holdFrozen`). The schemas are this build's constant (built
 * from the core's list: digits only).
 */
const KNOWN_SCHEMAS_SQL = JOB_SCHEMAS.map(n => String(Number(n))).join(', ')
const known = (table: string) => `EXISTS (SELECT 1 FROM ai_job_versions v WHERE v.company_id = ${table}.company_id AND v.job_id = ${table}.job_id
  AND v.version = ${table}.job_version AND v.schema IN (${KNOWN_SCHEMAS_SQL}) AND json_valid(v.definition) AND json_extract(v.definition, '$.schema') = v.schema)`
const KNOWN = known('ai_job_occurrences')
const occurrenceOf = (r: OccurrenceDbRow): JobOccurrenceRow => ({
  id: r.id, jobId: r.job_id, jobVersion: r.job_version, dueSlot: r.due_slot, timeZone: r.time_zone, dueAt: r.due_at, expiresAt: r.expires_at,
  state: r.state as JobOccurrenceRow['state'], runId: r.run_id, outcomeCode: r.outcome_code, checkedUntil: r.checked_until, checkedCommit: r.checked_commit, retries: r.retries, retriedBy: r.retried_by, retriedAt: r.retried_at,
  eventSeq: r.event_seq, eventRecordId: r.event_record_id, eventVersion: r.event_version, eventDay: r.event_day, watchGeneration: r.watch_generation,
  createdAt: r.created_at, updatedAt: r.updated_at,
})

interface ProposalDbRow {
  id: string; job_id: string; proposer_id: string; candidate_id: string; submitted_version: number; submitted_fingerprint: string
  state: string; return_reason: string | null; decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string
}
const PROPOSAL_COLUMNS = `id, job_id, proposer_id, candidate_id, submitted_version, submitted_fingerprint, state, return_reason, decided_by, decided_at, created_at, updated_at`
const proposalOf = (r: ProposalDbRow): JobProposalRow => ({
  id: r.id, jobId: r.job_id, proposerId: r.proposer_id, candidateId: r.candidate_id, submittedVersion: r.submitted_version,
  submittedFingerprint: r.submitted_fingerprint, state: r.state as JobProposalRow['state'], returnReason: r.return_reason,
  decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at, updatedAt: r.updated_at,
})

/** The stored place, read strictly (anything else is no place). */
function placeOf(text: string | null): JobDeliveryPlace | null {
  if (text === null) return null
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    return typeof v.connector === 'string' && typeof v.kind === 'string' && typeof v.ref === 'string' ? { connector: v.connector, kind: v.kind, ref: v.ref } : null
  } catch {
    return null
  }
}

const jobOf = (r: JobDbRow): JobRow => ({
  id: r.id, name: r.name, state: r.state as JobState, actingUserId: r.acting_user_id, latestVersion: r.latest_version,
  approvedVersion: r.approved_version, approvedFingerprint: r.approved_fingerprint, acceptedVersion: r.accepted_version,
  acceptedConsent: r.accepted_consent, acceptedPlace: placeOf(r.accepted_place), pausedReason: r.paused_reason as JobPauseReason | null, pausedBy: r.paused_by, pausedAt: r.paused_at,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
})
const versionOf = (r: VersionDbRow): JobVersionRow => ({
  jobId: r.job_id, version: r.version, schema: r.schema, definition: r.definition, fingerprint: r.fingerprint,
  consentFingerprint: r.consent_fingerprint, actingUserId: r.acting_user_id, createdBy: r.created_by, createdAt: r.created_at,
  approvedBy: r.approved_by, approvedAt: r.approved_at, acceptedBy: r.accepted_by, acceptedAt: r.accepted_at,
})

/**
 * One company's scheduled jobs (ai_jobs, ai_job_versions, ai_job_settings; ports/jobs.ts). Built only
 * by the company handle (./company-data.ts); every statement names the company. No statement updates
 * a version's definition (the table's trigger would refuse it anyway).
 */
export function sqliteJobRepository(conn: Database.Database, companyId: string): JobRepository {
  // The newest delivery number given (records.md "Delivery order": the counter holds the next one), 0 when none yet.
  // What this build writes of a job or of the company's stop is stamped on the event cursors (none when the job has
  // none): a write that is not stamped is a build before 4a's (jobs.md "Event-triggered jobs"). A cursor takes the new
  // stamp only when it held the one before this write — one that already differs (an older build wrote since) keeps the
  // difference until its own scan has looked at nothing from then (Codex review of #700).
  const jobUpdatedAt = (jobId: string): string =>
    (conn.prepare(`SELECT updated_at FROM ai_jobs WHERE company_id = ? AND id = ?`).get(companyId, jobId) as { updated_at: string } | undefined)?.updated_at ?? ''
  const stopUpdatedAt = (): string =>
    (conn.prepare(`SELECT updated_at FROM ai_job_settings WHERE company_id = ?`).get(companyId) as { updated_at: string } | undefined)?.updated_at ?? ''
  const stampJob = (jobId: string, before: string) => conn.prepare(`UPDATE ai_job_event_cursors SET job_stamp = ? WHERE company_id = ? AND job_id = ? AND job_stamp = ?`)
    .run(jobUpdatedAt(jobId), companyId, jobId, before)
  const stampStop = (before: string) => conn.prepare(`UPDATE ai_job_event_cursors SET stop_stamp = ? WHERE company_id = ? AND stop_stamp = ?`)
    .run(stopUpdatedAt(), companyId, before)
  const seqNow = (): number => {
    const r = conn.prepare(`SELECT next_seq FROM record_ledger_seq WHERE company_id = ?`).get(companyId) as { next_seq: number } | undefined
    return r ? r.next_seq - 1 : 0
  }
  const insertVersion = (v: JobVersionRow) => {
    conn.prepare(`INSERT INTO ai_job_versions (company_id, ${VERSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
      .run(companyId, v.jobId, v.version, v.schema, v.definition, v.fingerprint, v.consentFingerprint, v.actingUserId, v.createdBy, v.createdAt)
  }
  return {
    list() {
      return (conn.prepare(`SELECT ${JOB_COLUMNS} FROM ai_jobs WHERE company_id = ? ORDER BY created_at DESC, id`).all(companyId) as JobDbRow[]).map(jobOf)
    },
    listFor(userId) {
      return (conn.prepare(`
        SELECT ${JOB_COLUMNS} FROM ai_jobs j WHERE j.company_id = ? AND (j.acting_user_id = ? OR EXISTS (
          SELECT 1 FROM ai_job_versions v WHERE v.company_id = ? AND v.job_id = j.id AND v.version = j.approved_version AND v.acting_user_id = ?))
        ORDER BY j.created_at DESC, j.id
      `).all(companyId, userId, companyId, userId) as JobDbRow[]).map(jobOf)
    },
    find(jobId) {
      const r = conn.prepare(`SELECT ${JOB_COLUMNS} FROM ai_jobs WHERE company_id = ? AND id = ?`).get(companyId, jobId) as JobDbRow | undefined
      return r ? jobOf(r) : null
    },
    create(job, first) {
      conn.transaction(() => {
        conn.prepare(`INSERT INTO ai_jobs (company_id, ${JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`)
          .run(companyId, job.id, job.name, job.state, job.actingUserId, job.latestVersion, job.createdBy, job.createdAt, job.updatedAt)
        insertVersion(first)
      })()
    },
    addVersion(v, at) {
      conn.transaction(() => {
        insertVersion(v)
        const name = (JSON.parse(v.definition) as { name: string }).name
        const before = jobUpdatedAt(v.jobId)
        conn.prepare(`UPDATE ai_jobs SET latest_version = ?, name = ?, acting_user_id = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
          .run(v.version, name, v.actingUserId, at, companyId, v.jobId)
        stampJob(v.jobId, before)
      })()
    },
    versions(jobId) {
      return (conn.prepare(`SELECT ${VERSION_COLUMNS} FROM ai_job_versions WHERE company_id = ? AND job_id = ? ORDER BY version DESC`)
        .all(companyId, jobId) as VersionDbRow[]).map(versionOf)
    },
    version(jobId, version) {
      const r = conn.prepare(`SELECT ${VERSION_COLUMNS} FROM ai_job_versions WHERE company_id = ? AND job_id = ? AND version = ?`)
        .get(companyId, jobId, version) as VersionDbRow | undefined
      return r ? versionOf(r) : null
    },
    approve(jobId, version, fingerprint, by, at, state) {
      conn.transaction(() => {
        const before = jobUpdatedAt(jobId)
        conn.prepare(`UPDATE ai_jobs SET approved_version = ?, approved_fingerprint = ?, state = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
          .run(version, fingerprint, state, at, companyId, jobId)
        conn.prepare(`UPDATE ai_job_versions SET approved_by = ?, approved_at = ? WHERE company_id = ? AND job_id = ? AND version = ? AND approved_at IS NULL`)
          .run(by, at, companyId, jobId, version)
        stampJob(jobId, before)
      })()
    },
    accept(jobId, version, consentFingerprint, by, at, place) {
      conn.transaction(() => {
        const before = jobUpdatedAt(jobId)
        conn.prepare(`UPDATE ai_jobs SET accepted_version = ?, accepted_consent = ?, accepted_place = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
          .run(version, consentFingerprint, place ? JSON.stringify({ connector: place.connector, kind: place.kind, ref: place.ref }) : null, at, companyId, jobId)
        conn.prepare(`UPDATE ai_job_versions SET accepted_by = ?, accepted_at = ? WHERE company_id = ? AND job_id = ? AND version = ? AND accepted_at IS NULL`)
          .run(by, at, companyId, jobId, version)
        stampJob(jobId, before)
      })()
    },
    setState(jobId, state, reason, by, at) {
      conn.transaction(() => {
        const before = jobUpdatedAt(jobId)
        conn.prepare(`UPDATE ai_jobs SET state = ?, paused_reason = ?, paused_by = ?, paused_at = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
          .run(state, reason, reason === null ? null : by, reason === null ? null : at, at, companyId, jobId)
        stampJob(jobId, before)
      })()
    },
    resume(jobId, from, to, at) {
      return conn.transaction(() => {
        const before = jobUpdatedAt(jobId)
        const moved = conn.prepare(`
          UPDATE ai_jobs SET state = ?, paused_reason = NULL, paused_by = NULL, paused_at = NULL, updated_at = ?
          WHERE company_id = ? AND id = ? AND state = 'paused'
            AND paused_reason IS ? AND paused_by IS ? AND paused_at IS ? AND approved_version IS ?
        `).run(to, at, companyId, jobId, from.pausedReason, from.pausedBy, from.pausedAt, from.approvedVersion).changes === 1
        if (moved) stampJob(jobId, before)
        return moved
      })()
    },
    stopped() {
      const r = conn.prepare(`SELECT stopped FROM ai_job_settings WHERE company_id = ?`).get(companyId) as { stopped: number } | undefined
      return r?.stopped === 1
    },
    setStopped(stopped, by, at) {
      conn.transaction(() => {
        const before = stopUpdatedAt()
        conn.prepare(`INSERT INTO ai_job_settings (company_id, stopped, updated_by, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(company_id) DO UPDATE SET stopped = excluded.stopped, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(companyId, stopped ? 1 : 0, by, at)
        stampStop(before)
      })()
    },
    stopStamp() {
      return stopUpdatedAt()
    },

    insertOccurrence(o) {
      // A time slot names no event (its columns stay NULL, as an older build writes it).
      if (o.eventSeq === undefined || o.eventSeq === null) {
        return conn.prepare(`INSERT OR IGNORE INTO ai_job_occurrences (company_id, ${OCCURRENCE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(companyId, o.id, o.jobId, o.jobVersion, o.dueSlot, o.timeZone, o.dueAt, o.expiresAt, o.state, o.runId, o.outcomeCode, o.createdAt, o.updatedAt)
          .changes === 1
      }
      return conn.prepare(`INSERT OR IGNORE INTO ai_job_occurrences (company_id, ${OCCURRENCE_COLUMNS}, event_seq, event_record_id, event_version, event_day, watch_generation)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, o.id, o.jobId, o.jobVersion, o.dueSlot, o.timeZone, o.dueAt, o.expiresAt, o.state, o.runId, o.outcomeCode, o.createdAt, o.updatedAt,
          o.eventSeq, o.eventRecordId ?? null, o.eventVersion ?? null, o.eventDay ?? null, o.watchGeneration ?? null)
        .changes === 1
    },
    occurrence(occurrenceId) {
      const r = conn.prepare(`SELECT ${OCCURRENCE_READ} FROM ai_job_occurrences WHERE company_id = ? AND id = ? AND ${KNOWN}`).get(companyId, occurrenceId) as OccurrenceDbRow | undefined
      return r ? occurrenceOf(r) : null
    },
    occurrences(jobId, limit, offset = 0) {
      return (conn.prepare(`SELECT ${OCCURRENCE_READ} FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND ${KNOWN}
          ORDER BY ${OCCURRENCE_ORDER} LIMIT ? OFFSET ?`)
        .all(companyId, jobId, limit, offset) as OccurrenceDbRow[]).map(occurrenceOf)
    },
    dueOccurrences(limit, jobId = null) {
      return (conn.prepare(`SELECT ${OCCURRENCE_READ} FROM ai_job_occurrences WHERE company_id = ? AND state = 'due' AND (? IS NULL OR job_id = ?) AND ${KNOWN}
          ORDER BY due_at, id LIMIT ?`)
        .all(companyId, jobId, jobId, limit) as OccurrenceDbRow[]).map(occurrenceOf)
    },
    runningOccurrences(limit, jobId = null) {
      return (conn.prepare(`SELECT ${OCCURRENCE_READ} FROM ai_job_occurrences WHERE company_id = ? AND state = 'running' AND (? IS NULL OR job_id = ?) AND ${KNOWN}
          ORDER BY due_at, id LIMIT ?`)
        .all(companyId, jobId, jobId, limit) as OccurrenceDbRow[]).map(occurrenceOf)
    },
    otherRunning(jobId, exceptId) {
      return conn.prepare(`SELECT 1 FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND state = 'running' AND id <> ? AND ${KNOWN} LIMIT 1`)
        .get(companyId, jobId, exceptId) !== undefined
    },
    eventRecordsPinnedTo(userId, limit, offset = 0) {
      return (conn.prepare(`SELECT o.event_record_id AS id FROM ai_job_occurrences o JOIN ai_job_versions v
          ON v.company_id = o.company_id AND v.job_id = o.job_id AND v.version = o.job_version
          WHERE o.company_id = ? AND v.acting_user_id = ? AND o.event_record_id IS NOT NULL AND ${known('o')}
          GROUP BY o.event_record_id ORDER BY MAX(o.event_seq) DESC, o.event_record_id LIMIT ? OFFSET ?`).all(companyId, userId, limit, offset) as Array<{ id: string }>).map(r => r.id)
    },
    occurrencesPinnedTo(userId, records, limit) {
      return (conn.prepare(`SELECT ${OCCURRENCE_READ.split(', ').map(c => `o.${c.trim()}`).join(', ')} FROM ai_job_occurrences o JOIN ai_job_versions v
          ON v.company_id = o.company_id AND v.job_id = o.job_id AND v.version = o.job_version
          WHERE o.company_id = ? AND v.acting_user_id = ? AND o.event_record_id IN (SELECT value FROM json_each(?)) AND ${known('o')}
          ORDER BY o.created_at DESC, o.event_seq DESC, o.id LIMIT ?`).all(companyId, userId, JSON.stringify(records), limit) as OccurrenceDbRow[]).map(occurrenceOf)
    },
    holdFrozen(jobId, code, at) {
      // Every one, no limit (a stop must reach all of them): the runs of the running ones are returned for the caller to end.
      const runs = (conn.prepare(`SELECT run_id FROM ai_job_occurrences WHERE company_id = ? AND state = 'running' AND (? IS NULL OR job_id = ?) AND NOT (${KNOWN})
          AND run_id IS NOT NULL`).all(companyId, jobId, jobId) as Array<{ run_id: string }>).map(r => r.run_id)
      conn.prepare(`UPDATE ai_job_occurrences SET state = 'held', outcome_code = ?, updated_at = ?
          WHERE company_id = ? AND state IN ('due', 'running') AND (? IS NULL OR job_id = ?) AND NOT (${KNOWN})`).run(code, at, companyId, jobId, jobId)
      return runs
    },
    retryOccurrence(occurrenceId, from, expiresAt, by, at) {
      return conn.prepare(`UPDATE ai_job_occurrences SET state = 'due', outcome_code = NULL, run_id = NULL, expires_at = ?,
          retries = retries + 1, retried_by = ?, retried_at = ?, updated_at = ?
          WHERE company_id = ? AND id = ? AND state IN (SELECT value FROM json_each(?)) AND ${KNOWN}`)
        .run(expiresAt, by, at, at, companyId, occurrenceId, JSON.stringify(from)).changes === 1
    },
    holdEventOccurrences(jobId, code, at) {
      conn.prepare(`UPDATE ai_job_occurrences SET state = 'held', outcome_code = ?, updated_at = ?
          WHERE company_id = ? AND state = 'due' AND NOT (${NOT_EVENT}) AND (? IS NULL OR job_id = ?)`)
        .run(code, at, companyId, jobId, jobId)
    },
    isHiddenOccurrence(occurrenceId) {
      return conn.prepare(`SELECT 1 FROM ai_job_occurrences WHERE company_id = ? AND id = ? AND (NOT (${NOT_EVENT}) OR NOT (${KNOWN}))`).get(companyId, occurrenceId) !== undefined
    },
    moveOccurrence(occurrenceId, from, to, change, at) {
      const runId = change.runId === undefined ? null : change.runId
      // checked_until / checked_commit are set once (the first claim) and never moved afterwards.
      return conn.prepare(`UPDATE ai_job_occurrences SET state = ?, outcome_code = ?, run_id = CASE WHEN ? THEN ? ELSE run_id END,
          checked_until = COALESCE(checked_until, ?), checked_commit = CASE WHEN checked_until IS NULL THEN ? ELSE checked_commit END, updated_at = ?
          WHERE company_id = ? AND id = ? AND state IN (SELECT value FROM json_each(?)) AND ${KNOWN}`)
        .run(to, change.outcomeCode, change.runId === undefined ? 0 : 1, runId, change.checkedUntil ?? null, change.checkedCommit ?? null, at, companyId, occurrenceId, JSON.stringify(from)).changes === 1
    },

    ledgerSeqNow() {
      return seqNow()
    },
    watchedEvents(recordId, afterSeq, upToSeq, limit) {
      // Delivery order (records.md "Delivery order"): a row written later with an earlier time is never passed by. The
      // ledger's key starts (company, record): one record's rows are found without reading anyone else's.
      const rows = conn.prepare(`SELECT l.delivery_seq AS seq, l.record_id, l.version, r.type, l.action, l.from_state, l.to_state, l.actor_kind, l.actor_id,
          l.run_id, l.origin, l.via, l.at
          FROM record_ledger l JOIN records r ON r.company_id = l.company_id AND r.id = l.record_id
          WHERE l.company_id = ? AND l.record_id = ? AND l.delivery_seq IS NOT NULL AND l.delivery_seq > ? AND l.delivery_seq <= ?
          ORDER BY l.delivery_seq LIMIT ?`)
        .all(companyId, recordId, afterSeq, upToSeq, limit) as Array<{
          seq: number; record_id: string; version: number; type: string; action: string; from_state: string | null; to_state: string | null
          actor_kind: string; actor_id: string; run_id: string | null; origin: string | null; via: string | null; at: string
        }>
      return rows.map((r): LedgerEventRow => ({
        seq: r.seq, recordId: r.record_id, version: r.version, type: r.type, action: r.action, fromState: r.from_state, toState: r.to_state,
        actorKind: r.actor_kind, actorId: r.actor_id, runId: r.run_id, origin: r.origin, via: r.via, at: r.at,
      }))
    },
    eventRecordsOf(jobId, limit) {
      return (conn.prepare(`SELECT event_record_id AS id FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND event_record_id IS NOT NULL AND ${KNOWN}
          GROUP BY event_record_id ORDER BY MAX(event_seq) DESC LIMIT ?`).all(companyId, jobId, limit) as Array<{ id: string }>).map(r => r.id)
    },
    occurrencesOf(jobId, records, limit) {
      return (conn.prepare(`SELECT ${OCCURRENCE_READ} FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND ${KNOWN}
          AND ((event_record_id IS NULL AND ${NOT_EVENT}) OR event_record_id IN (SELECT value FROM json_each(?)))
          ORDER BY ${OCCURRENCE_ORDER} LIMIT ?`)
        .all(companyId, jobId, JSON.stringify(records), limit) as OccurrenceDbRow[]).map(occurrenceOf)
    },
    eventCursor(jobId) {
      const r = conn.prepare(`SELECT seen_seq, watch_record_id, watch_start, watch_fired, job_stamp, stop_stamp, chain_stop_code, chain_stop_record, chain_stop_at,
          watch_generation FROM ai_job_event_cursors WHERE company_id = ? AND job_id = ?`)
        .get(companyId, jobId) as {
          seen_seq: number; watch_record_id: string; watch_start: string; watch_fired: number; job_stamp: string; stop_stamp: string
          chain_stop_code: string | null; chain_stop_record: string | null; chain_stop_at: string | null; watch_generation: number | null
        } | undefined
      return r ? ({
        seen: r.seen_seq, watch: r.watch_record_id, start: r.watch_start, fired: r.watch_fired === 1, jobStamp: r.job_stamp, stopStamp: r.stop_stamp,
        chainStop: r.chain_stop_code !== null && r.chain_stop_record !== null && r.chain_stop_at !== null ? { code: r.chain_stop_code, record: r.chain_stop_record, at: r.chain_stop_at } : null,
        generation: r.watch_generation,
      } satisfies JobEventCursor) : null
    },
    startEventCursor(jobId, startRecord, at) {
      // A new start record (a version the responsible person accepted) starts the watch over; the same one keeps where the chain is.
      // A new watch is a new generation (stage 4b-0.5): an occurrence of the earlier watch never moves or stops this one.
      conn.prepare(`INSERT INTO ai_job_event_cursors (company_id, job_id, seen_seq, watch_record_id, watch_start, watch_fired, updated_at, watch_generation) VALUES (?, ?, ?, ?, ?, 0, ?, 1)
          ON CONFLICT(company_id, job_id) DO UPDATE SET seen_seq = MAX(seen_seq, excluded.seen_seq),
            watch_generation = CASE WHEN watch_start = excluded.watch_start THEN watch_generation ELSE COALESCE(watch_generation, 0) + 1 END,
            watch_record_id = CASE WHEN watch_start = excluded.watch_start THEN watch_record_id ELSE excluded.watch_record_id END,
            watch_fired = CASE WHEN watch_start = excluded.watch_start THEN watch_fired ELSE 0 END,
            chain_stop_code = CASE WHEN watch_start = excluded.watch_start THEN chain_stop_code ELSE NULL END,
            chain_stop_record = CASE WHEN watch_start = excluded.watch_start THEN chain_stop_record ELSE NULL END,
            chain_stop_at = CASE WHEN watch_start = excluded.watch_start THEN chain_stop_at ELSE NULL END,
            watch_start = excluded.watch_start, updated_at = excluded.updated_at`)
        .run(companyId, jobId, seqNow(), startRecord, startRecord, at)
      // Its cursor is at now: it takes what is written now — this job's only (another job keeps its own difference).
      conn.prepare(`UPDATE ai_job_event_cursors SET job_stamp = ?, stop_stamp = ? WHERE company_id = ? AND job_id = ?`)
        .run(jobUpdatedAt(jobId), stopUpdatedAt(), companyId, jobId)
    },
    restartWatch(jobId, recordId, at) {
      conn.prepare(`UPDATE ai_job_event_cursors SET seen_seq = MAX(seen_seq, ?), watch_record_id = ?, watch_start = ?, watch_fired = 0,
          watch_generation = COALESCE(watch_generation, 0) + 1, chain_stop_code = NULL, chain_stop_record = NULL, chain_stop_at = NULL, job_stamp = ?, stop_stamp = ?, updated_at = ?
          WHERE company_id = ? AND job_id = ?`).run(seqNow(), recordId, recordId, jobUpdatedAt(jobId), stopUpdatedAt(), at, companyId, jobId)
    },
    markWatchFired(jobId, recordId, at) {
      return conn.prepare(`UPDATE ai_job_event_cursors SET watch_fired = 1, updated_at = ? WHERE company_id = ? AND job_id = ? AND watch_record_id = ? AND watch_fired = 0`)
        .run(at, companyId, jobId, recordId).changes === 1
    },
    moveWatch(jobId, from, to, at, generation) {
      return conn.prepare(`UPDATE ai_job_event_cursors SET watch_record_id = ?, watch_fired = 0, chain_stop_code = NULL, chain_stop_record = NULL, chain_stop_at = NULL,
          watch_generation = watch_generation + 1, updated_at = ? WHERE company_id = ? AND job_id = ? AND watch_record_id = ? AND watch_generation = ?`)
        .run(to, at, companyId, jobId, from, generation).changes === 1
    },
    stopChain(jobId, code, recordId, at) {
      // Only the chain of the record watched now: an occurrence left from an earlier watch (a new start record chosen
      // since) never stops the new one (Codex review of #700).
      return conn.prepare(`UPDATE ai_job_event_cursors SET chain_stop_code = ?, chain_stop_record = ?, chain_stop_at = ?
          WHERE company_id = ? AND job_id = ? AND watch_record_id = ? AND chain_stop_code IS NULL`).run(code, recordId, at, companyId, jobId, recordId).changes === 1
    },
    clearChainStop(jobId, recordId, generation) {
      conn.prepare(`UPDATE ai_job_event_cursors SET chain_stop_code = NULL, chain_stop_record = NULL, chain_stop_at = NULL
          WHERE company_id = ? AND job_id = ? AND chain_stop_record = ? AND watch_generation = ?`).run(companyId, jobId, recordId, generation)
    },
    moveEventCursor(jobId, from, to, at) {
      return conn.prepare(`UPDATE ai_job_event_cursors SET seen_seq = ?, updated_at = ? WHERE company_id = ? AND job_id = ? AND seen_seq = ?`)
        .run(to, at, companyId, jobId, from).changes === 1
    },
    eventGaps(jobId) {
      return (conn.prepare(`SELECT from_seq, until_seq FROM ai_job_event_gaps WHERE company_id = ? AND job_key IN (?, '')`)
        .all(companyId, jobId) as Array<{ from_seq: number; until_seq: number | null }>)
        .map((g): JobEventGap => ({ from: g.from_seq, until: g.until_seq }))
    },
    openGapKeys(jobId) {
      return (conn.prepare(`SELECT DISTINCT job_key FROM ai_job_event_gaps WHERE company_id = ? AND job_key IN (?, '') AND until_seq IS NULL`)
        .all(companyId, jobId) as Array<{ job_key: string }>).map(r => r.job_key)
    },
    openEventGap(jobId, id, at) {
      const key = jobId ?? ''
      conn.prepare(`INSERT INTO ai_job_event_gaps (company_id, id, job_key, from_seq, until_seq, opened_at, closed_at)
          SELECT ?, ?, ?, ?, NULL, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM ai_job_event_gaps WHERE company_id = ? AND job_key = ? AND until_seq IS NULL)`)
        .run(companyId, id, key, seqNow(), at, companyId, key)
    },
    closeEventGaps(jobId, at, untilSeq) {
      return conn.prepare(`UPDATE ai_job_event_gaps SET until_seq = MAX(from_seq, ?), closed_at = ? WHERE company_id = ? AND job_key = ? AND until_seq IS NULL`)
        .run(untilSeq ?? seqNow(), at, companyId, jobId ?? '').changes
    },
    resyncEventCursors(jobId, at) {
      conn.transaction(() => {
        conn.prepare(`UPDATE ai_job_event_cursors SET seen_seq = MAX(seen_seq, ?), updated_at = ? WHERE company_id = ? AND (? IS NULL OR job_id = ?)`)
          .run(seqNow(), at, companyId, jobId, jobId)
        conn.prepare(`UPDATE ai_job_event_cursors SET job_stamp = COALESCE((SELECT j.updated_at FROM ai_jobs j WHERE j.company_id = ai_job_event_cursors.company_id
            AND j.id = ai_job_event_cursors.job_id), job_stamp) WHERE company_id = ? AND (? IS NULL OR job_id = ?)`).run(companyId, jobId, jobId)
        // Only the cursors moved here take the stop's stamp: another job still has to find an older build's stop itself.
        conn.prepare(`UPDATE ai_job_event_cursors SET stop_stamp = COALESCE((SELECT updated_at FROM ai_job_settings WHERE company_id = ?), '')
            WHERE company_id = ? AND (? IS NULL OR job_id = ?)`).run(companyId, companyId, jobId, jobId)
      })()
    },
    // Frozen occurrences (a later build's shape) count toward the day's limit too: the safe side (fewer runs, never more).
    eventOccurrencesOn(jobId, day) {
      return (conn.prepare(`SELECT COUNT(*) AS n FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND event_day = ?`)
        .get(companyId, jobId, day) as { n: number }).n
    },

    // Member proposals (jobs.md "Member proposals").
    candidate(candidateId, createdBy, now) {
      const r = conn.prepare(`SELECT id, created_by, definition, fingerprint, created_at, expires_at FROM ai_job_candidates
        WHERE company_id = ? AND id = ? AND created_by = ? AND expires_at > ?`).get(companyId, candidateId, createdBy, now) as
        { id: string; created_by: string; definition: string; fingerprint: string; created_at: string; expires_at: string } | undefined
      // A discarded candidate keeps its row until its time with the mark in place of its fingerprint (no schema change).
      return r ? { id: r.id, createdBy: r.created_by, definition: r.definition, fingerprint: r.fingerprint, createdAt: r.created_at, expiresAt: r.expires_at, discarded: r.fingerprint === DISCARDED_MARK } : null
    },
    discardCandidate(candidateId, createdBy) {
      return conn.prepare(`UPDATE ai_job_candidates SET fingerprint = ? WHERE company_id = ? AND id = ? AND created_by = ? AND fingerprint <> ?`)
        .run(DISCARDED_MARK, companyId, candidateId, createdBy, DISCARDED_MARK).changes > 0
    },
    liveCandidates(createdBy, now) {
      return (conn.prepare(`SELECT COUNT(*) AS n FROM ai_job_candidates WHERE company_id = ? AND created_by = ? AND expires_at > ?`)
        .get(companyId, createdBy, now) as { n: number }).n
    },
    insertCandidate(row: JobCandidateRow) {
      conn.prepare(`INSERT INTO ai_job_candidates (company_id, id, created_by, definition, fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.id, row.createdBy, row.definition, row.fingerprint, row.createdAt, row.expiresAt)
    },
    dropExpiredCandidates(now) {
      return conn.prepare(`DELETE FROM ai_job_candidates WHERE company_id = ? AND expires_at <= ?`).run(companyId, now).changes
    },
    proposal(proposalId) {
      const r = conn.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM ai_job_proposals WHERE company_id = ? AND id = ?`).get(companyId, proposalId) as ProposalDbRow | undefined
      return r ? proposalOf(r) : null
    },
    proposalOfJob(jobId) {
      const r = conn.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM ai_job_proposals WHERE company_id = ? AND job_id = ?`).get(companyId, jobId) as ProposalDbRow | undefined
      return r ? proposalOf(r) : null
    },
    proposalOfCandidate(proposerId, candidateId) {
      const r = conn.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM ai_job_proposals WHERE company_id = ? AND proposer_id = ? AND candidate_id = ?`)
        .get(companyId, proposerId, candidateId) as ProposalDbRow | undefined
      return r ? proposalOf(r) : null
    },
    proposals(filter, limit) {
      return (conn.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM ai_job_proposals WHERE company_id = ? AND (? IS NULL OR proposer_id = ?) AND (? IS NULL OR state = ?)
        ORDER BY created_at DESC, id LIMIT ?`).all(companyId, filter.proposerId ?? null, filter.proposerId ?? null, filter.state ?? null, filter.state ?? null, limit) as ProposalDbRow[])
        .map(proposalOf)
    },
    countProposals(proposerId, filter) {
      return (conn.prepare(`SELECT COUNT(*) AS n FROM ai_job_proposals WHERE company_id = ? AND proposer_id = ? AND (? IS NULL OR state = ?) AND (? IS NULL OR created_at >= ?)`)
        .get(companyId, proposerId, filter.state ?? null, filter.state ?? null, filter.since ?? null, filter.since ?? null) as { n: number }).n
    },
    insertProposal(row: JobProposalRow) {
      conn.prepare(`INSERT INTO ai_job_proposals (company_id, ${PROPOSAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.id, row.jobId, row.proposerId, row.candidateId, row.submittedVersion, row.submittedFingerprint, row.state, row.returnReason,
          row.decidedBy, row.decidedAt, row.createdAt, row.updatedAt)
    },
    decideProposal(proposalId, to, change) {
      return conn.prepare(`UPDATE ai_job_proposals SET state = ?, return_reason = ?, decided_by = ?, decided_at = ?, updated_at = ?
        WHERE company_id = ? AND id = ? AND state = 'submitted'`).run(to, change.reason, change.by, change.at, change.at, companyId, proposalId).changes === 1
    },
  }
}
