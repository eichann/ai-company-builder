import type Database from 'better-sqlite3'
import type { JobPauseReason } from '../../../shared/core/jobs'
import type { JobState } from '../../../shared/types/jobs'
import type { JobRepository, JobRow, JobVersionRow } from '../../ports/jobs'

interface JobDbRow {
  id: string; name: string; state: string; acting_user_id: string; latest_version: number
  approved_version: number | null; approved_fingerprint: string | null; accepted_version: number | null; accepted_consent: string | null
  paused_reason: string | null; paused_by: string | null; paused_at: string | null
  created_by: string; created_at: string; updated_at: string
}
interface VersionDbRow {
  job_id: string; version: number; schema: number; definition: string; fingerprint: string; consent_fingerprint: string
  acting_user_id: string; created_by: string; created_at: string
  approved_by: string | null; approved_at: string | null; accepted_by: string | null; accepted_at: string | null
}

const JOB_COLUMNS = `id, name, state, acting_user_id, latest_version, approved_version, approved_fingerprint, accepted_version, accepted_consent,
  paused_reason, paused_by, paused_at, created_by, created_at, updated_at`
const VERSION_COLUMNS = `job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at,
  approved_by, approved_at, accepted_by, accepted_at`

const jobOf = (r: JobDbRow): JobRow => ({
  id: r.id, name: r.name, state: r.state as JobState, actingUserId: r.acting_user_id, latestVersion: r.latest_version,
  approvedVersion: r.approved_version, approvedFingerprint: r.approved_fingerprint, acceptedVersion: r.accepted_version,
  acceptedConsent: r.accepted_consent, pausedReason: r.paused_reason as JobPauseReason | null, pausedBy: r.paused_by, pausedAt: r.paused_at,
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
        conn.prepare(`INSERT INTO ai_jobs (company_id, ${JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`)
          .run(companyId, job.id, job.name, job.state, job.actingUserId, job.latestVersion, job.createdBy, job.createdAt, job.updatedAt)
        insertVersion(first)
      })()
    },
    addVersion(v, at) {
      conn.transaction(() => {
        insertVersion(v)
        const name = (JSON.parse(v.definition) as { name: string }).name
        conn.prepare(`UPDATE ai_jobs SET latest_version = ?, name = ?, acting_user_id = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
          .run(v.version, name, v.actingUserId, at, companyId, v.jobId)
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
        conn.prepare(`UPDATE ai_jobs SET approved_version = ?, approved_fingerprint = ?, state = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
          .run(version, fingerprint, state, at, companyId, jobId)
        conn.prepare(`UPDATE ai_job_versions SET approved_by = ?, approved_at = ? WHERE company_id = ? AND job_id = ? AND version = ? AND approved_at IS NULL`)
          .run(by, at, companyId, jobId, version)
      })()
    },
    accept(jobId, version, consentFingerprint, by, at) {
      conn.transaction(() => {
        conn.prepare(`UPDATE ai_jobs SET accepted_version = ?, accepted_consent = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
          .run(version, consentFingerprint, at, companyId, jobId)
        conn.prepare(`UPDATE ai_job_versions SET accepted_by = ?, accepted_at = ? WHERE company_id = ? AND job_id = ? AND version = ? AND accepted_at IS NULL`)
          .run(by, at, companyId, jobId, version)
      })()
    },
    setState(jobId, state, reason, by, at) {
      conn.prepare(`UPDATE ai_jobs SET state = ?, paused_reason = ?, paused_by = ?, paused_at = ?, updated_at = ? WHERE company_id = ? AND id = ?`)
        .run(state, reason, reason === null ? null : by, reason === null ? null : at, at, companyId, jobId)
    },
    stopped() {
      const r = conn.prepare(`SELECT stopped FROM ai_job_settings WHERE company_id = ?`).get(companyId) as { stopped: number } | undefined
      return r?.stopped === 1
    },
    setStopped(stopped, by, at) {
      conn.prepare(`INSERT INTO ai_job_settings (company_id, stopped, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET stopped = excluded.stopped, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(companyId, stopped ? 1 : 0, by, at)
    },
  }
}
