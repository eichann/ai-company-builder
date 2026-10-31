/**
 * The company map's API (stage 4-2, `.claude/rules/records.md`; contract
 * `shared/types/records.ts`): the per-company switch, type definitions, and
 * the fixed-shape query — by type or interface, state, server-field values,
 * links up to two hops, text in title and summary, counts. No free SQL.
 *
 * Every answer holds only what the caller may read (services/record-access.ts):
 * counts and link traversals included, so a private record is never even
 * counted for someone who cannot read it. The handle is the caller's company
 * (`member.companyId`): another company's record id is a record that does not exist.
 */
import { ONTOLOGY_NAME_RE } from '../../shared/core/record-types'
import { RECORD_ID_RE } from '../../shared/core/records'
import type {
  RecordDetail, RecordFieldValue, RecordIndexProblem, RecordLinkView, RecordQueryResult, RecordSettings, RecordSummary, RecordTypeView,
} from '../../shared/types/records'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordAccessRow, RecordCandidateFilter, RecordRepository, RecordRow } from '../ports/records'
import type { Member } from './access'
import { requireFullAccess } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { linkAllowed, recordReader, type RecordReader } from './record-access'
import { currentTypes, type RecordIndexer } from './record-index'

export const RECORDS_DISABLED = { error: 'この会社では記録の機能が有効になっていません', code: 'RECORDS_DISABLED' }
export const RECORD_NOT_FOUND = { error: '記録が見つかりません', code: 'RECORD_NOT_FOUND' }
const ADMIN_ONLY = 'Only owners and admins can manage the company map'

/** Rows read from SQL before the caller's read access is applied (a count beyond it is not exact). */
export const MAX_CANDIDATES = 20000
/** Records reached per hop of a link traversal. */
const MAX_NEIGHBOURS = 2000

export interface RecordServiceDeps {
  companyData: CompanyDataSource
  clock: Clock
  indexer: RecordIndexer
}

type Scalar = RecordFieldValue
const isScalar = (v: unknown): v is Scalar => v === null || ['string', 'number', 'boolean'].includes(typeof v)

interface ParsedQuery {
  type?: string
  implements?: string
  state?: string[]
  fields: Array<{ name: string; values: Scalar[] }>
  linkedTo?: { id: string; hops: 1 | 2 }
  text?: string
  limit: number
  offset: number
  countOnly: boolean
}

function parseQuery(body: unknown): ParsedQuery | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The query must be an object'
  const b = body as Record<string, unknown>
  const known = ['type', 'implements', 'state', 'fields', 'linkedTo', 'text', 'limit', 'offset', 'countOnly']
  for (const k of Object.keys(b)) if (!known.includes(k)) return `Unknown query key: ${k}`
  const q: ParsedQuery = { fields: [], limit: 50, offset: 0, countOnly: b.countOnly === true }
  if (b.type !== undefined) {
    if (typeof b.type !== 'string' || !ONTOLOGY_NAME_RE.test(b.type)) return 'type must be a type name'
    q.type = b.type
  }
  if (b.implements !== undefined) {
    if (typeof b.implements !== 'string' || !ONTOLOGY_NAME_RE.test(b.implements)) return 'implements must be an interface name'
    q.implements = b.implements
  }
  if (b.state !== undefined) {
    if (!Array.isArray(b.state) || b.state.length === 0 || b.state.length > 20 || !b.state.every(s => typeof s === 'string' && ONTOLOGY_NAME_RE.test(s))) return 'state must be a list of state names'
    q.state = b.state as string[]
  }
  if (b.fields !== undefined) {
    if (typeof b.fields !== 'object' || b.fields === null || Array.isArray(b.fields)) return 'fields must be an object'
    const entries = Object.entries(b.fields as Record<string, unknown>)
    if (entries.length > 10) return 'At most 10 field filters'
    for (const [name, v] of entries) {
      if (!ONTOLOGY_NAME_RE.test(name)) return 'Field names are lower-case English'
      let values: unknown[]
      if (isScalar(v)) values = [v]
      else if (typeof v === 'object' && v !== null && Array.isArray((v as { in?: unknown }).in)) values = (v as { in: unknown[] }).in
      else return `Field ${name}: a value or { in: [...] }`
      if (values.length === 0 || values.length > 50 || !values.every(isScalar)) return `Field ${name}: 1–50 plain values`
      if (values.some(x => typeof x === 'string' && x.length > 200)) return `Field ${name}: value too long`
      q.fields.push({ name, values: values as Scalar[] })
    }
  }
  if (b.linkedTo !== undefined) {
    const l = b.linkedTo as { id?: unknown; hops?: unknown }
    if (typeof l !== 'object' || l === null || typeof l.id !== 'string' || !RECORD_ID_RE.test(l.id)) return 'linkedTo.id must be a record id'
    if (l.hops !== undefined && l.hops !== 1 && l.hops !== 2) return 'linkedTo.hops is 1 or 2'
    q.linkedTo = { id: l.id, hops: (l.hops as 1 | 2 | undefined) ?? 1 }
  }
  if (b.text !== undefined) {
    if (typeof b.text !== 'string') return 'text must be a string'
    const t = b.text.normalize('NFC').trim()
    if (t.length > 100) return 'text: at most 100 characters'
    if (t !== '') q.text = t
  }
  if (b.limit !== undefined) {
    if (typeof b.limit !== 'number' || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > 200) return 'limit is 1–200'
    q.limit = b.limit
  }
  if (b.offset !== undefined) {
    if (typeof b.offset !== 'number' || !Number.isInteger(b.offset) || b.offset < 0 || b.offset > 10000) return 'offset is 0–10000'
    q.offset = b.offset
  }
  return q
}

function summaries(records: RecordRepository, rows: RecordRow[]): Map<string, RecordSummary> {
  const states = new Map(records.states(rows.map(r => r.id)).map(s => [s.recordId, s]))
  return new Map(rows.map(r => {
    const s = states.get(r.id)
    let fields: Record<string, Scalar> = {}
    try { fields = s ? JSON.parse(s.fields) as Record<string, Scalar> : {} } catch { fields = {} }
    return [r.id, {
      id: r.id, type: r.type, typeVersion: r.typeVersion, title: r.title, summary: r.summary, path: r.path,
      state: s?.state ?? null, fields, version: s?.version ?? 0, updatedAt: s && s.updatedAt > r.updatedAt ? s.updatedAt : r.updatedAt,
    } satisfies RecordSummary]
  }))
}

/** Readable records linked to `from` (either direction), the link allowed for anyone. */
function neighbours(records: RecordRepository, reader: RecordReader, from: RecordAccessRow[]): RecordAccessRow[] {
  const ids = from.map(r => r.id)
  const byId = new Map(from.map(r => [r.id, r]))
  const out = records.linksFrom(ids).filter(l => l.targetId !== null)
  const inn = records.linksTo(ids)
  const otherIds = [...new Set([...out.map(l => l.targetId as string), ...inn.map(l => l.sourceId)])].filter(id => !byId.has(id)).slice(0, MAX_NEIGHBOURS)
  const others = new Map(records.byIds(otherIds).map(r => [r.id, r]))
  const found = new Map<string, RecordAccessRow>()
  for (const l of out) {
    const t = others.get(l.targetId as string)
    if (t && linkAllowed(byId.get(l.sourceId)!, t) && reader.record(t)) found.set(t.id, t)
  }
  for (const l of inn) {
    const s = others.get(l.sourceId)
    if (s && linkAllowed(s, byId.get(l.targetId as string)!) && reader.record(s)) found.set(s.id, s)
  }
  return [...found.values()]
}

export function createRecordService({ companyData, clock, indexer }: RecordServiceDeps) {
  const handleOf = (member: Member) => companyData.forCompany(member.companyId)
  const enabled = (member: Member) => handleOf(member).records.settings().enabled

  function settingsView(member: Member): RecordSettings {
    const s = handleOf(member).records.settings()
    return { enabled: s.enabled, updatedAt: s.updatedAt }
  }

  return {
    settings(member: Member): Outcome<RecordSettings> {
      const allowed = requireFullAccess(member, ADMIN_ONLY)
      if (!allowed.ok) return allowed
      return ok(settingsView(member))
    },

    updateSettings(member: Member, body: unknown): Outcome<RecordSettings> {
      const allowed = requireFullAccess(member, ADMIN_ONLY)
      if (!allowed.ok) return allowed
      const value = (body as { enabled?: unknown } | null)?.enabled
      if (typeof body !== 'object' || body === null || typeof value !== 'boolean') return refuse('bad-request', 'enabled must be true or false')
      handleOf(member).records.setEnabled(value, member.userId, clock.now())
      if (value) void indexer.schedule(member.companyId)
      return ok(settingsView(member))
    },

    problems(member: Member): Outcome<{ problems: RecordIndexProblem[] }> {
      const allowed = requireFullAccess(member, ADMIN_ONLY)
      if (!allowed.ok) return allowed
      if (!enabled(member)) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      return ok({ problems: handleOf(member).records.problems(500) })
    },

    /** `{ full: true }`: forget what was indexed and read every repository again. */
    reindex(member: Member, body: unknown): Outcome<{ scheduled: true }> {
      const allowed = requireFullAccess(member, ADMIN_ONLY)
      if (!allowed.ok) return allowed
      if ((body as { full?: unknown } | null)?.full !== true) return refuse('bad-request', 'Send { "full": true } to rebuild the index from the files')
      if (!enabled(member)) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      handleOf(member).records.clearHeads()
      void indexer.schedule(member.companyId)
      return ok({ scheduled: true })
    },

    /** After an accepted push to any of the company's repositories (git-http). Never throws. */
    afterPush(member: Member): void {
      try {
        if (enabled(member)) void indexer.schedule(member.companyId)
      } catch {
        // The index catches up at the next push.
      }
    },

    /** Index the member's company now and resolve when it is current (operators, tests). */
    refreshIndex(member: Member): Promise<void> {
      return indexer.schedule(member.companyId)
    },

    types(member: Member): Outcome<{ types: RecordTypeView[] }> {
      const records = handleOf(member).records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const versions = new Map<string, number[]>()
      for (const row of records.typeVersions()) versions.set(row.name, [...(versions.get(row.name) ?? []), row.version])
      const types = [...currentTypes(records)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, t]): RecordTypeView => ({
        definition: t.definition, source: t.source, versions: versions.get(name) ?? [t.version],
      }))
      return ok({ types })
    },

    query(member: Member, body: unknown): Outcome<RecordQueryResult> {
      const records = handleOf(member).records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const q = parseQuery(body)
      if (typeof q === 'string') return refuse('bad-request', q)
      const types = currentTypes(records)
      const filter: RecordCandidateFilter = {}
      if (q.type) filter.types = [q.type]
      if (q.implements) {
        const implementing = [...types].filter(([, t]) => t.definition.implements.includes(q.implements!)).map(([n]) => n)
        filter.types = filter.types ? filter.types.filter(t => implementing.includes(t)) : implementing
      }
      if (q.type && types.has(q.type)) {
        const def = types.get(q.type)!.definition
        for (const f of q.fields) {
          if (def.fields[f.name]?.source !== 'server') return refuse('bad-request', `Field ${f.name} is not a server field of ${q.type}`)
        }
        if (q.state && !q.state.every(s => def.states.includes(s))) return refuse('bad-request', `Unknown state of ${q.type}`)
      }
      if (q.state) filter.states = q.state
      if (q.fields.length > 0) filter.fields = q.fields
      if (q.text) filter.text = q.text

      const reader = recordReader(member, handleOf(member).scopes.listWithRules())
      if (q.linkedTo) {
        const start = records.byIds([q.linkedTo.id]).filter(r => reader.record(r))
        if (start.length === 0) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
        const hop1 = neighbours(records, reader, start)
        const reached = new Map(hop1.map(r => [r.id, r]))
        if (q.linkedTo.hops === 2) for (const r of neighbours(records, reader, hop1)) reached.set(r.id, r)
        reached.delete(q.linkedTo.id)
        filter.ids = [...reached.keys()]
      }
      if (filter.types?.length === 0 || filter.ids?.length === 0) return ok({ total: 0, records: [] })

      const visible = records.candidates(filter, MAX_CANDIDATES).filter(r => reader.record(r))
      if (q.countOnly) return ok({ total: visible.length, records: [] })
      const page = visible.slice(q.offset, q.offset + q.limit)
      const byId = summaries(records, records.byIds(page.map(r => r.id)))
      return ok({ total: visible.length, records: page.map(r => byId.get(r.id)).filter((s): s is RecordSummary => !!s) })
    },

    get(member: Member, recordId: string): Outcome<RecordDetail> {
      const records = handleOf(member).records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const reader = recordReader(member, handleOf(member).scopes.listWithRules())
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const out = records.linksFrom([row.id])
      const inn = records.linksTo([row.id])
      const otherIds = [...new Set([...out.flatMap(l => (l.targetId ? [l.targetId] : [])), ...inn.map(l => l.sourceId)])].slice(0, MAX_NEIGHBOURS)
      const others = new Map(records.byIds(otherIds).map(r => [r.id, r]))
      const shown = new Map<string, RecordRow>()
      const links: Array<{ name: string; direction: 'out' | 'in'; id?: string; path?: string }> = []
      for (const l of out) {
        if (l.targetPath !== null) { if (reader.file(l.targetPath)) links.push({ name: l.name, direction: 'out', path: l.targetPath }); continue }
        const t = others.get(l.targetId as string)
        if (t && linkAllowed(row, t) && reader.record(t)) { shown.set(t.id, t); links.push({ name: l.name, direction: 'out', id: t.id }) }
      }
      for (const l of inn) {
        const s = others.get(l.sourceId)
        if (s && linkAllowed(s, row) && reader.record(s)) { shown.set(s.id, s); links.push({ name: l.name, direction: 'in', id: s.id }) }
      }
      const sums = summaries(records, [row, ...shown.values()])
      return ok({
        record: sums.get(row.id)!,
        links: links.map((l): RecordLinkView => (l.id ? { name: l.name, direction: l.direction, record: sums.get(l.id)! } : { name: l.name, direction: l.direction, path: l.path! })),
      })
    },
  }
}

export type RecordService = ReturnType<typeof createRecordService>
