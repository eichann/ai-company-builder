/**
 * SQLite storage of writes within frames (ports/browser-frames.ts), bound to one company — built only by the company
 * handle (adapters/sqlite/company-data.ts), every statement limited to `companyId`. Every state move is a
 * compare-and-set; the CHECKs and triggers of db/schema/browser-frames.ts refuse anything else.
 */
import type Database from 'better-sqlite3'
import type { BrowserFrameRepository, FrameRow, FrameRunRow, FrameWriteRow } from '../../ports/browser-frames'

type RunDb = {
  id: string; user_id: string; host: string; device_id: string | null; conversation_id: string | null; source: string
  skill: string | null; declaration_hash: string | null; files: string | null; approval_seq: number | null; plan_hash: string; approval_token_hash: string | null; state: string
  approval: string | null; approved_at: string | null; end_reason: string | null; created_at: string; expires_at: string; ended_at: string | null
}
const RUN_COLUMNS = 'id, user_id, host, device_id, conversation_id, source, skill, declaration_hash, files, approval_seq, plan_hash, approval_token_hash, state, approval, approved_at, end_reason, created_at, expires_at, ended_at'
const toRun = (r: RunDb): FrameRunRow => ({
  id: r.id, userId: r.user_id, host: r.host, deviceId: r.device_id, conversationId: r.conversation_id, source: r.source as FrameRunRow['source'],
  skill: r.skill, declarationHash: r.declaration_hash, files: r.files, approvalSeq: r.approval_seq, planHash: r.plan_hash, approvalTokenHash: r.approval_token_hash, state: r.state as FrameRunRow['state'],
  approval: r.approval as FrameRunRow['approval'], approvedAt: r.approved_at, endReason: r.end_reason, createdAt: r.created_at,
  expiresAt: r.expires_at, endedAt: r.ended_at,
})

/**
 * A frame's query as the column keeps it (agent-browser.md "A query value not fixed"). The column's CHECK (added in place,
 * so it cannot change) allows only `A–Z a–z 0–9 . _ ~ = & -`; a value placeholder (`={n}`, `={x}`, the whole value) is kept
 * as `==n` / `==x` — a spelling the query grammar never allows (a value never begins with `=`), so the two forms never
 * meet. An older server reading such a row asks the grammar, which refuses it: the frame then fits nothing (safe side).
 */
const PLACEHOLDER_STORED: ReadonlyArray<[string, string]> = [['={n}', '==n'], ['={x}', '==x']]
export const storedFrameQuery = (query: string | null): string | null => (query === null ? null
  : query.split('&').map(p => PLACEHOLDER_STORED.reduce((s, [from, to]) => (s.endsWith(from) && s.indexOf('=') === s.length - from.length ? s.slice(0, -from.length) + to : s), p)).join('&'))
export const frameQueryFromStored = (stored: string | null): string | null => (stored === null ? null
  : stored.split('&').map(p => PLACEHOLDER_STORED.reduce((s, [from, to]) => (s.endsWith(to) && s.indexOf('=') === s.length - to.length ? s.slice(0, -to.length) + from : s), p)).join('&'))

type WriteDb = {
  seq: number; frame_idx: number; state: string; reason: string | null; permitted_at: string; permitted_mono_ms: number | null
  permitted_boot: string | null; settled_at: string | null
}
const toWrite = (r: WriteDb): FrameWriteRow => ({
  seq: r.seq, frameIdx: r.frame_idx, state: r.state as FrameWriteRow['state'], reason: r.reason, permittedAt: r.permitted_at,
  permittedMonoMs: r.permitted_mono_ms, permittedBoot: r.permitted_boot, settledAt: r.settled_at,
})

export function sqliteBrowserFrameRepository(conn: Database.Database, companyId: string): BrowserFrameRepository {
  return {
    run(runId) {
      const r = conn.prepare(`SELECT ${RUN_COLUMNS} FROM browser_frame_runs WHERE company_id = ? AND id = ?`).get(companyId, runId) as RunDb | undefined
      return r ? toRun(r) : null
    },
    liveRunOn(host) {
      const r = conn.prepare(`SELECT ${RUN_COLUMNS} FROM browser_frame_runs WHERE company_id = ? AND host = ? AND state <> 'ended'`).get(companyId, host) as RunDb | undefined
      return r ? toRun(r) : null
    },
    unsettledRunsOf(userId) {
      return (conn.prepare(`SELECT ${RUN_COLUMNS} FROM browser_frame_runs r WHERE r.company_id = ? AND r.user_id = ? AND (r.state <> 'ended'
          OR EXISTS (SELECT 1 FROM browser_frame_writes w WHERE w.company_id = ? AND w.run_id = r.id AND w.state = 'permitted'))
        ORDER BY r.created_at, r.id`).all(companyId, userId, companyId) as RunDb[]).map(toRun)
    },
    runsInFlightOn(host) {
      return (conn.prepare(`SELECT ${RUN_COLUMNS} FROM browser_frame_runs r WHERE r.company_id = ? AND r.host = ?
          AND EXISTS (SELECT 1 FROM browser_frame_writes w WHERE w.company_id = ? AND w.run_id = r.id AND w.state = 'permitted')
        ORDER BY r.created_at, r.id`).all(companyId, host, companyId) as RunDb[]).map(toRun)
    },
    insertRun(run, frames) {
      conn.prepare(`INSERT INTO browser_frame_runs (company_id, ${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        companyId, run.id, run.userId, run.host, run.deviceId, run.conversationId, run.source, run.skill, run.declarationHash, run.files, run.approvalSeq,
        run.planHash, run.approvalTokenHash, run.state, run.approval, run.approvedAt, run.endReason, run.createdAt, run.expiresAt, run.endedAt,
      )
      const insert = conn.prepare('INSERT INTO browser_frames (company_id, run_id, idx, method, path, query, fields, max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const f of frames) insert.run(companyId, run.id, f.idx, f.method, f.path, storedFrameQuery(f.query), f.fields, f.max)
    },
    frames(runId) {
      return (conn.prepare('SELECT idx, method, path, query, fields, max, used FROM browser_frames WHERE company_id = ? AND run_id = ? ORDER BY idx')
        .all(companyId, runId) as FrameRow[]).map(f => ({ ...f, query: frameQueryFromStored(f.query) }))
    },
    writes(runId) {
      return (conn.prepare(`SELECT seq, frame_idx, state, reason, permitted_at, permitted_mono_ms, permitted_boot, settled_at
        FROM browser_frame_writes WHERE company_id = ? AND run_id = ? ORDER BY seq`).all(companyId, runId) as WriteDb[]).map(toWrite)
    },
    setRunState(runId, from, to, change) {
      const sets = ['state = ?']
      const values: unknown[] = [to]
      if (change.approval !== undefined) { sets.push('approval = ?', 'approved_at = ?'); values.push(change.approval, change.approvedAt ?? null) }
      if (change.endReason !== undefined) { sets.push('end_reason = ?'); values.push(change.endReason) }
      if (change.endedAt !== undefined) { sets.push('ended_at = ?'); values.push(change.endedAt) }
      return conn.prepare(`UPDATE browser_frame_runs SET ${sets.join(', ')} WHERE company_id = ? AND id = ? AND state = ?`)
        .run(...values, companyId, runId, from).changes === 1
    },
    takeUnit(runId, idx) {
      return conn.prepare('UPDATE browser_frames SET used = used + 1 WHERE company_id = ? AND run_id = ? AND idx = ? AND used < max')
        .run(companyId, runId, idx).changes === 1
    },
    insertWrite(runId, w) {
      conn.prepare(`INSERT INTO browser_frame_writes (company_id, run_id, seq, frame_idx, state, permitted_at, permitted_mono_ms, permitted_boot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, runId, w.seq, w.frameIdx, w.state, w.permittedAt, w.permittedMonoMs, w.permittedBoot)
    },
    confirms(runId) {
      return (conn.prepare('SELECT seq, answer, confirmed_by, confirmed_at FROM browser_frame_write_confirms WHERE company_id = ? AND run_id = ? ORDER BY seq')
        .all(companyId, runId) as Array<{ seq: number; answer: 'done' | 'not_done'; confirmed_by: string; confirmed_at: string }>)
        .map(r => ({ seq: r.seq, answer: r.answer, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at }))
    },
    made(runId) {
      return (conn.prepare('SELECT seq, frame_idx, made FROM browser_frame_made WHERE company_id = ? AND run_id = ? ORDER BY seq')
        .all(companyId, runId) as Array<{ seq: number; frame_idx: number; made: string }>)
        .map(r => ({ seq: r.seq, frameIdx: r.frame_idx, made: r.made }))
    },
    insertMade(runId, row, recordedAt) {
      conn.prepare('INSERT INTO browser_frame_made (company_id, run_id, seq, frame_idx, made, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(companyId, runId, row.seq, row.frameIdx, row.made, recordedAt)
    },
    insertConfirm(runId, row) {
      return conn.prepare(`INSERT OR IGNORE INTO browser_frame_write_confirms (company_id, run_id, seq, answer, confirmed_by, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(companyId, runId, row.seq, row.answer, row.confirmedBy, row.confirmedAt).changes === 1
    },
    insertLedger(row, recordedAt) {
      conn.prepare(`INSERT INTO browser_write_ledger (company_id, run_id, seq, user_id, host, account, target, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, row.runId, row.seq, row.userId, row.host, row.account, row.target, recordedAt)
    },
    ledgerDoubts(host, account, target) {
      return (conn.prepare(`SELECT l.run_id, l.seq, l.target, w.state, w.permitted_at, f.method, f.path, f.query, f.fields
        FROM browser_write_ledger l
        JOIN browser_frame_writes w ON w.company_id = l.company_id AND w.run_id = l.run_id AND w.seq = l.seq
        JOIN browser_frames f ON f.company_id = w.company_id AND f.run_id = w.run_id AND f.idx = w.frame_idx
        WHERE l.company_id = ? AND l.host = ? AND l.account = ? AND (? IS NULL OR l.target = ?) AND w.state IN ('permitted', 'unknown')
          AND NOT EXISTS (SELECT 1 FROM browser_frame_write_confirms c WHERE c.company_id = ? AND c.run_id = l.run_id AND c.seq = l.seq)
        ORDER BY w.permitted_at, l.run_id, l.seq`).all(companyId, host, account, target ?? null, target ?? null, companyId) as Array<{
        run_id: string; seq: number; target: string; state: 'permitted' | 'unknown'; permitted_at: string
        method: FrameRow['method']; path: string; query: string | null; fields: string
      }>).map(r => ({
        runId: r.run_id, seq: r.seq, target: r.target, state: r.state, permittedAt: r.permitted_at,
        frame: { method: r.method, path: r.path, query: frameQueryFromStored(r.query), fields: r.fields },
      }))
    },
    setWriteState(runId, seq, from, to, change) {
      return conn.prepare('UPDATE browser_frame_writes SET state = ?, settled_at = ?, reason = COALESCE(?, reason) WHERE company_id = ? AND run_id = ? AND seq = ? AND state = ?')
        .run(to, change.settledAt, change.reason ?? null, companyId, runId, seq, from).changes === 1
    },
  }
}
