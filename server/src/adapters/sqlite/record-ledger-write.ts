/**
 * The one writer of `record_ledger` rows (records.md "Delivery order", stage 4-0 of event-triggered jobs).
 *
 * Every row gets the company's next **delivery number** (`delivery_seq`) in the same transaction as its
 * insert: a per-company counter (`record_ledger_seq.next_seq`) that only grows, so a reader that remembers
 * "up to N" never misses a row written later with an earlier time (`at` is taken before the write and many
 * migration rows share one). The number is an ordinary column — never `INTEGER PRIMARY KEY` — so a company
 * archive restores it as it was (`restoreLedgerSequence` then puts the counter above every stored number).
 * Rows written before this existed keep NULL: they are never events.
 *
 * `origin` marks a row that is not an ordinary change (`LedgerOrigin`: a migration's, the server's own actors').
 *
 * No other module may `INSERT INTO record_ledger` (tests/unit/record-ledger-delivery.test.ts scans server/src).
 */
import type Database from 'better-sqlite3'
import type { LedgerOrigin } from '../../../shared/core/record-ledger'

/** The company's next delivery number, taken now (call inside the transaction that inserts the row). */
function takeDeliverySeq(conn: Database.Database, companyId: string): number {
  const row = conn.prepare(`INSERT INTO record_ledger_seq (company_id, next_seq) VALUES (?, 2)
      ON CONFLICT(company_id) DO UPDATE SET next_seq = next_seq + 1 RETURNING next_seq`).get(companyId) as { next_seq: number }
  return row.next_seq - 1
}

/** A row of the engine's ledger, every column (the records adapter's `appendLedger`). */
export interface LedgerInsert {
  recordId: string; version: number; action: string; fromState: string | null; toState: string | null
  actorId: string; actorKind: string; actorSource: string | null; at: string; note: string
  changes: string; attachments: string; decision: string | null; isDecision: 0 | 1; typeVersion: number | null
  reversesVersion: number | null; proposedBy: string | null; conversationId: string | null; receipt: string | null
  onBehalfOf: string | null; runId: string | null; skills: string | null; via: string | null
  origin: LedgerOrigin | null
}

/** Insert one engine ledger row with its delivery number (one transaction: a savepoint inside the caller's). */
export function insertLedgerRow(conn: Database.Database, companyId: string, e: LedgerInsert): number {
  return conn.transaction(() => {
    const seq = takeDeliverySeq(conn, companyId)
    // An entry written in an execution run copies the run's procedure as it is now (records.md "Which procedure").
    conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at, note,
        changes, attachments, decision, is_decision, type_version, reverses_version, proposed_by, conversation_id, receipt, on_behalf_of, run_id, procedure, skills, via,
        delivery_seq, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT procedure FROM ai_runs WHERE company_id = ? AND id = ?), ?, ?, ?, ?)`)
      .run(companyId, e.recordId, e.version, e.action, e.fromState, e.toState, e.actorId, e.actorKind, e.actorSource, e.at, e.note,
        e.changes, e.attachments, e.decision, e.isDecision, e.typeVersion, e.reversesVersion, e.proposedBy, e.conversationId, e.receipt, e.onBehalfOf, e.runId,
        companyId, e.runId, e.skills, e.via, seq, e.origin)
    return seq
  })()
}

/**
 * A startup migration's ledger row (records.md "Outside time", "A まとまり chosen later"): only the columns every
 * database had when those migrations were written (later columns — `via`… — may not exist yet when they run),
 * with its delivery number and the `migration` mark.
 */
export function insertMigrationLedgerRow(conn: Database.Database, companyId: string, e: {
  recordId: string; version: number; action: string; fromState: string | null; toState: string | null
  actorId: string; actorKind: string; actorSource: string | null; at: string; changes: string; typeVersion: number
}): number {
  return conn.transaction(() => {
    const seq = takeDeliverySeq(conn, companyId)
    conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, actor_source, at,
        note, changes, attachments, is_decision, type_version, delivery_seq, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '[]', 0, ?, ?, 'migration')`)
      .run(companyId, e.recordId, e.version, e.action, e.fromState, e.toState, e.actorId, e.actorKind, e.actorSource, e.at, e.changes, e.typeVersion, seq)
    return seq
  })()
}

/**
 * After a company's rows were restored (adapters/sqlite/company-archive.ts): the counter at least one above every
 * stored number, never lower than the archived counter — numbers are never given twice, and none is renumbered.
 * An archive from before delivery numbers has neither: its rows stay NULL and the first write starts the counter at 1
 * (a company with no numbered row gets no counter row here, exactly as before the restore).
 */
export function restoreLedgerSequence(conn: Database.Database, companyId: string): void {
  conn.prepare(`INSERT INTO record_ledger_seq (company_id, next_seq)
      SELECT ?, MAX(delivery_seq) + 1 FROM record_ledger WHERE company_id = ? HAVING MAX(delivery_seq) IS NOT NULL
      ON CONFLICT(company_id) DO UPDATE SET next_seq = MAX(next_seq, excluded.next_seq)`).run(companyId, companyId)
}
