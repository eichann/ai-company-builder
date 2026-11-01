/**
 * The content store (中身の箱, `.claude/rules/records.md` "The content store"),
 * SQLite side. Bound to one company per call; every statement names it.
 *
 * - Writing: the records adapter (./records.ts) turns each content value (a
 *   title, a summary, a `long_text` field, a note, a decision reason —
 *   shared/core/record-contents.ts) into a reference before the row reaches
 *   `records`, `record_state` or `record_ledger`, and stores the text here.
 *   A content id is derived from the record and the text's hash, so the same
 *   text of one record is one row: storing it again changes nothing — and a
 *   text once erased stays erased when it comes back.
 * - Reading: the records adapter resolves references of the rows it returns,
 *   only to content of the same record and company. There is no other read:
 *   whoever reads the record (the services' read checks) reads its content.
 * - Erasing (`sqliteRecordContentEraser`): the operator's command and the
 *   retention run only (no route reaches it); the text is cleared, the row,
 *   its hash and the references stay (trigger `record_contents_immutable`).
 */
import type Database from 'better-sqlite3'
import {
  contentExpiry, contentFieldNames, contentRef, erasedText, parseContentRef, retentionClassOf, type RetentionClass,
} from '../../../shared/core/record-contents'
import type { LedgerChange, LedgerDecision, LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import { hashCanonical } from '../../lib/content-hash'
import type { RecordContentEraser, RecordContentInfo } from '../../ports/record-contents'

/** A copy of an incoming text inherits its expiry only when it is at least this long (a 「了解」 is not a copy). */
const INHERIT_MIN_LENGTH = 20

interface PendingContent {
  id: string
  recordId: string
  hash: string
  text: string
  retention: RetentionClass
}

/** sha256(record id, hash) → 32 hex: the same text of one record is one row. */
function contentId(recordId: string, hash: string): string {
  return hashCanonical(`${recordId}\u0000${hash}`).slice('sha256:'.length, 'sha256:'.length + 32)
}

export function sqliteContentStore(conn: Database.Database, companyId: string) {
  const typeCache = new Map<string, Set<string>>()

  /** The content fields of a type: every stored version (a field's kind never changes across versions). */
  function fieldsOfType(type: string): Set<string> {
    const cached = typeCache.get(type)
    if (cached) return cached
    const all: Record<string, { kind: string }> = {}
    for (const r of conn.prepare('SELECT definition FROM record_types WHERE company_id = ? AND name = ?').all(companyId, type) as Array<{ definition: string }>) {
      try {
        const def = JSON.parse(r.definition) as { fields?: Record<string, { kind: string }> }
        Object.assign(all, def.fields ?? {})
      } catch { /* an unreadable definition adds nothing */ }
    }
    const out = contentFieldNames(type, all)
    typeCache.set(type, out)
    return out
  }

  function typeOfRecord(recordId: string): string | null {
    const r = conn.prepare('SELECT type FROM records WHERE company_id = ? AND id = ?').get(companyId, recordId) as { type: string } | undefined
    return r?.type ?? null
  }

  /** Collects the texts of one write; `flush` stores them (after the write it belongs to succeeded). */
  function batch(recordId: string, recordType: string | null) {
    const pending = new Map<string, PendingContent>()
    const retention = retentionClassOf(recordType ?? '')
    /** The reference for `text` (empty stays empty: nothing to store). */
    const put = (text: string): string => {
      if (text === '') return text
      const hash = hashCanonical(text)
      const id = contentId(recordId, hash)
      if (!pending.has(id)) pending.set(id, { id, recordId, hash, text, retention })
      return contentRef(id, hash)
    }
    return {
      put,
      /** A value: strings become references; other scalars stay. */
      value: (v: LedgerValue): LedgerValue => (typeof v === 'string' ? put(v) : v),
      flush(at: string): void {
        const insert = conn.prepare(`INSERT OR IGNORE INTO record_contents (company_id, id, record_id, hash, text, retention_class, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        const inherited = conn.prepare(`SELECT MIN(expires_at) AS e FROM record_contents WHERE company_id = ? AND hash = ? AND expires_at IS NOT NULL`)
        for (const p of pending.values()) {
          let cls = p.retention
          let expires = contentExpiry(cls, at)
          if (p.text.length >= INHERIT_MIN_LENGTH) {
            const e = (inherited.get(companyId, p.hash) as { e: string | null }).e
            if (e !== null && (expires === null || e < expires)) { cls = 'incoming_3y'; expires = e }
          }
          insert.run(companyId, p.id, p.recordId, p.hash, p.text, cls, at, expires)
        }
        pending.clear()
      },
    }
  }

  /** Resolve references of several records at once: (record id, value) → text, the erased marker, or the value itself. */
  function resolver(values: Array<{ recordId: string; value: unknown }>) {
    const ids = [...new Set(values.map(v => parseContentRef(v.value)?.id).filter((x): x is string => !!x))]
    const rows = new Map<string, { recordId: string; hash: string; text: string | null; erasedAt: string | null }>()
    if (ids.length > 0) {
      for (const r of conn.prepare('SELECT id, record_id, hash, text, erased_at FROM record_contents WHERE company_id = ? AND id IN (SELECT value FROM json_each(?))')
        .all(companyId, JSON.stringify(ids)) as Array<{ id: string; record_id: string; hash: string; text: string | null; erased_at: string | null }>) {
        rows.set(r.id, { recordId: r.record_id, hash: r.hash, text: r.text, erasedAt: r.erased_at })
      }
    }
    return <T extends LedgerValue>(recordId: string, value: T): T | string => {
      const ref = parseContentRef(value)
      if (!ref) return value
      const row = rows.get(ref.id)
      // Only the record's own content (a reference copied elsewhere resolves to nothing).
      if (!row || row.recordId !== recordId || row.hash !== ref.hash) return ''
      return row.text ?? erasedText(row.erasedAt ?? '')
    }
  }

  return {
    fieldsOfType,
    typeOfRecord,
    batch,
    resolver,

    /** A record's server fields (JSON) with each content value stored as a reference. */
    storeFields(b: ReturnType<typeof batch>, type: string | null, fieldsJson: string): string {
      if (type === null) return fieldsJson
      const names = fieldsOfType(type)
      if (names.size === 0) return fieldsJson
      let fields: Record<string, LedgerValue>
      try { fields = JSON.parse(fieldsJson) as Record<string, LedgerValue> } catch { return fieldsJson }
      for (const name of names) if (typeof fields[name] === 'string') fields[name] = b.value(fields[name])
      return JSON.stringify(fields)
    },

    /** A ledger entry with its note, decision reason and content field values as references. */
    storeEntry(b: ReturnType<typeof batch>, type: string | null, e: LedgerEntry): LedgerEntry {
      const names = type === null ? new Set<string>() : fieldsOfType(type)
      const changes: LedgerChange[] = e.changes.map(c => names.has(c.field) ? { field: c.field, before: b.value(c.before), after: b.value(c.after) } : c)
      const decision: LedgerDecision | null = e.decision ? { ...e.decision, reason: b.put(e.decision.reason) } : null
      return { ...e, note: b.put(e.note), changes, decision }
    },

    /** The reverse of `storeEntry` for entries read back (one record). */
    resolveEntries(recordId: string, type: string | null, entries: LedgerEntry[]): LedgerEntry[] {
      const names = type === null ? new Set<string>() : fieldsOfType(type)
      const values: Array<{ recordId: string; value: unknown }> = []
      for (const e of entries) {
        values.push({ recordId, value: e.note }, { recordId, value: e.decision?.reason })
        for (const c of e.changes) if (names.has(c.field)) values.push({ recordId, value: c.before }, { recordId, value: c.after })
      }
      const resolve = resolver(values)
      return entries.map(e => ({
        ...e,
        note: resolve(recordId, e.note),
        decision: e.decision ? { ...e.decision, reason: resolve(recordId, e.decision.reason) } : null,
        changes: e.changes.map(c => names.has(c.field) ? { field: c.field, before: resolve(recordId, c.before), after: resolve(recordId, c.after) } : c),
      }))
    },

    /** Server fields JSON of several records with their content resolved. */
    resolveFields(rows: Array<{ recordId: string; type: string | null; fields: string }>): string[] {
      const parsed = rows.map(r => {
        let f: Record<string, LedgerValue> | null = null
        try { f = JSON.parse(r.fields) as Record<string, LedgerValue> } catch { f = null }
        return { ...r, f, names: r.type === null ? new Set<string>() : fieldsOfType(r.type) }
      })
      const resolve = resolver(parsed.flatMap(p => p.f ? [...p.names].map(n => ({ recordId: p.recordId, value: (p.f as Record<string, LedgerValue>)[n] })) : []))
      return parsed.map(p => {
        if (!p.f || p.names.size === 0) return p.fields
        const f = p.f
        let changed = false
        for (const n of p.names) {
          if (typeof f[n] !== 'string') continue
          const v = resolve(p.recordId, f[n])
          if (v !== f[n]) { f[n] = v; changed = true }
        }
        return changed ? JSON.stringify(f) : p.fields
      })
    },
  }
}

export type SqliteContentStore = ReturnType<typeof sqliteContentStore>

/**
 * Startup migration (records.md "The content store"): a company whose rows
 * were written before the store moves their texts into it — titles and
 * summaries, content fields, ledger notes, decision reasons and content field
 * changes. A value that already is a reference to this record's content is
 * left alone, so a second run changes nothing; the company is marked done
 * (`record_settings.content_store`) so later startups skip it.
 */
export function migrateCompanyContents(conn: Database.Database, companyId: string, at: string): { moved: number } {
  const store = sqliteContentStore(conn, companyId)
  let moved = 0
  const isOwnRef = (recordId: string, v: unknown): boolean => {
    const ref = parseContentRef(v)
    if (!ref) return false
    return !!conn.prepare('SELECT 1 FROM record_contents WHERE company_id = ? AND id = ? AND record_id = ?').get(companyId, ref.id, recordId)
  }
  const toRef = (b: ReturnType<SqliteContentStore['batch']>, recordId: string, v: LedgerValue): LedgerValue => {
    if (typeof v !== 'string' || v === '' || isOwnRef(recordId, v)) return v
    moved++
    return b.put(v)
  }
  conn.transaction(() => {
    const records = conn.prepare('SELECT id, type, title, summary FROM records WHERE company_id = ?').all(companyId) as Array<{ id: string; type: string; title: string; summary: string }>
    const types = new Map(records.map(r => [r.id, r.type]))
    const updateRecord = conn.prepare('UPDATE records SET title = ?, summary = ? WHERE company_id = ? AND id = ?')
    for (const r of records) {
      const b = store.batch(r.id, r.type)
      const title = toRef(b, r.id, r.title) as string
      const summary = toRef(b, r.id, r.summary) as string
      b.flush(at)
      if (title !== r.title || summary !== r.summary) updateRecord.run(title, summary, companyId, r.id)
    }
    const states = conn.prepare('SELECT record_id, fields FROM record_state WHERE company_id = ?').all(companyId) as Array<{ record_id: string; fields: string }>
    const updateState = conn.prepare('UPDATE record_state SET fields = ? WHERE company_id = ? AND record_id = ?')
    for (const s of states) {
      const type = types.get(s.record_id) ?? null
      if (type === null) continue
      let fields: Record<string, LedgerValue>
      try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { continue }
      const b = store.batch(s.record_id, type)
      const before = moved
      for (const name of store.fieldsOfType(type)) if (name in fields) fields[name] = toRef(b, s.record_id, fields[name])
      b.flush(at)
      if (moved !== before) updateState.run(JSON.stringify(fields), companyId, s.record_id)
    }
    const entries = conn.prepare('SELECT record_id, version, note, changes, decision FROM record_ledger WHERE company_id = ?').all(companyId) as
      Array<{ record_id: string; version: number; note: string; changes: string; decision: string | null }>
    const updateEntry = conn.prepare('UPDATE record_ledger SET note = ?, changes = ?, decision = ? WHERE company_id = ? AND record_id = ? AND version = ?')
    for (const e of entries) {
      const type = types.get(e.record_id) ?? null
      const names = type === null ? new Set<string>() : store.fieldsOfType(type)
      const b = store.batch(e.record_id, type)
      const before = moved
      const note = toRef(b, e.record_id, e.note) as string
      let changes: LedgerChange[] = []
      try { changes = JSON.parse(e.changes) as LedgerChange[] } catch { changes = [] }
      changes = changes.map(c => names.has(c.field) ? { field: c.field, before: toRef(b, e.record_id, c.before), after: toRef(b, e.record_id, c.after) } : c)
      let decision: LedgerDecision | null = null
      try { decision = e.decision ? JSON.parse(e.decision) as LedgerDecision : null } catch { decision = null }
      if (decision) decision = { ...decision, reason: toRef(b, e.record_id, decision.reason) as string }
      b.flush(at)
      if (moved !== before) updateEntry.run(note, JSON.stringify(changes), decision ? JSON.stringify(decision) : e.decision, companyId, e.record_id, e.version)
    }
    conn.prepare('UPDATE record_settings SET content_store = 1 WHERE company_id = ?').run(companyId)
  })()
  return { moved }
}

/**
 * The operator's erasure and the retention run (ports/record-contents.ts). Each
 * method is limited to the company it is given; no route or service the
 * routes see is handed this (composition.ts does not build it; the operator
 * command and the retention service do).
 */
export function sqliteRecordContentEraser(conn: Database.Database): RecordContentEraser {
  const erase = (companyId: string, where: string, params: unknown[], reason: string, at: string): string[] =>
    (conn.prepare(`UPDATE record_contents SET text = NULL, erased_at = ?, erased_reason = ? WHERE company_id = ? AND erased_at IS NULL AND ${where} RETURNING id`)
      .all(at, reason, companyId, ...params) as Array<{ id: string }>).map(r => r.id).sort()
  return {
    list(companyId, recordId) {
      return (conn.prepare('SELECT id, record_id, hash, retention_class, created_at, expires_at, erased_at, erased_reason FROM record_contents WHERE company_id = ? AND record_id = ? ORDER BY created_at, id')
        .all(companyId, recordId) as Array<{ id: string; record_id: string; hash: string; retention_class: RetentionClass; created_at: string; expires_at: string | null; erased_at: string | null; erased_reason: string | null }>)
        .map((r): RecordContentInfo => ({
          id: r.id, recordId: r.record_id, hash: r.hash, retention: r.retention_class, createdAt: r.created_at, expiresAt: r.expires_at,
          erasedAt: r.erased_at, erasedReason: r.erased_reason,
        }))
    },
    eraseRecord(companyId, recordId, reason, at) {
      return erase(companyId, 'record_id = ?', [recordId], reason, at)
    },
    eraseContents(companyId, ids, reason, at) {
      if (ids.length === 0) return []
      return erase(companyId, 'id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)], reason, at)
    },
    eraseExpired(companyId, now) {
      return erase(companyId, 'expires_at IS NOT NULL AND expires_at <= ?', [now], 'retention', now)
    },
  }
}
