/**
 * Titles, summaries and content fields are references in the tables (the
 * content store, records.md): tests that look at rows directly get them
 * resolved here (the text of the record's own content; no adapter imported,
 * so a test's environment set before `src/` loads stays in force).
 */
import type Database from 'better-sqlite3'
import { parseContentRef } from '../../../shared/core/record-contents'

/** Raw rows (with `id`) with references in `title`, `summary` and `fields` (JSON text) replaced by their text. */
export function withRecordText<T extends { id: string }>(conn: Database.Database, companyId: string, rows: T[]): T[] {
  const text = (recordId: string, v: unknown): unknown => {
    const ref = parseContentRef(v)
    if (!ref) return v
    const r = conn.prepare('SELECT text FROM record_contents WHERE company_id = ? AND id = ? AND record_id = ?').get(companyId, ref.id, recordId) as { text: string | null } | undefined
    return r?.text ?? null
  }
  return rows.map(r => {
    const out: Record<string, unknown> = { ...r }
    for (const k of ['title', 'summary']) if (k in out) out[k] = text(r.id, out[k])
    if (typeof out.fields === 'string') {
      const f = JSON.parse(out.fields) as Record<string, unknown>
      for (const k of Object.keys(f)) f[k] = text(r.id, f[k])
      out.fields = JSON.stringify(f)
    }
    return out as T
  })
}
