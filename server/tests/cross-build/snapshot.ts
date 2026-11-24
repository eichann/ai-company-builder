/**
 * What the cross-build check expects every build to keep as 4b-1 wrote it (SQL only, so the floor build runs it as is):
 * the versions, the watch (record, generation, its stop), the occurrences' identity (not their state: a stop may hold
 * them), the runs and their operations' identity (a stop may make one in flight unknown), the Drive receipts, the
 * notices (with a reminder's mark; not their read state), and the やること the occurrences made (nothing made twice, nothing made by a build that must not run them).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { prepare(sql: string): { all(...args: unknown[]): any[] } }

export function crossBuildSnapshot(db: Db, co: string) {
  const all = (sql: string) => db.prepare(sql).all(co)
  return {
    versions: all('SELECT * FROM ai_job_versions WHERE company_id = ? ORDER BY job_id, version'),
    watch: all(`SELECT job_id, watch_record_id, watch_start, watch_fired, watch_generation, chain_stop_code, chain_stop_record, chain_stop_at
      FROM ai_job_event_cursors WHERE company_id = ? ORDER BY job_id`),
    occurrences: all(`SELECT id, job_id, job_version, due_slot, run_id, retries, event_seq, event_record_id, event_version, watch_generation
      FROM ai_job_occurrences WHERE company_id = ? ORDER BY id`),
    runs: all("SELECT id, subject_kind, record_id, step, user_id, generation, created_at FROM ai_runs WHERE company_id = ? AND subject_kind = 'occurrence' ORDER BY id"),
    operations: all('SELECT run_id, key, kind, ref_kind, ref_id FROM ai_run_operations WHERE company_id = ? ORDER BY run_id, key'),
    puts: all('SELECT * FROM google_drive_puts WHERE company_id = ? ORDER BY id'),
    // `action`: a stop notice brought back once (its reminder) keeps its mark — no build reminds it twice.
    notices: all("SELECT id, user_id, kind, dedupe_key, action FROM notifications WHERE company_id = ? AND kind LIKE 'job_%' ORDER BY id"),
    // Member proposals (jobs.md "Member proposals"): the proposal records and their jobs as this build wrote them — no build
    // revives a withdrawn one, approves, edits or duplicates anything (SQL only: the floor runs it on the tables it never made).
    proposals: all('SELECT * FROM ai_job_proposals WHERE company_id = ? ORDER BY id'),
    proposalJobs: all(`SELECT id, name, state, acting_user_id, latest_version, approved_version, approved_fingerprint, accepted_version, accepted_consent, created_by
      FROM ai_jobs WHERE company_id = ? AND id IN (SELECT job_id FROM ai_job_proposals WHERE company_id = ai_jobs.company_id) ORDER BY id`),
    // The set watch's 「使った」 mark (4b-4 PR2): no build writes a second or changes one.
    marks: all('SELECT * FROM ai_job_meeting_reviews WHERE company_id = ? ORDER BY record_id'),
    made: all(`SELECT id FROM records WHERE company_id = ? AND type = 'task' AND id IN (SELECT 'task-' || substr(id, 5) FROM ai_job_occurrences WHERE company_id = records.company_id) ORDER BY id`),
  }
}
