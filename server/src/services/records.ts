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
import { findPrivateScope, type ScopeWithRules } from '../../shared/core/permissions'
import { aiTurnStates, normalizeTag, ONTOLOGY_NAME_RE, type FieldKind } from '../../shared/core/record-types'
import { RECORD_ID_RE } from '../../shared/core/records'
import type {
  RecordDetail, RecordFieldValue, RecordIndexProblem, RecordLinkView, RecordQueryResult, RecordSettings, RecordSummary, RecordTypeView,
} from '../../shared/types/records'
import { OLD_CONNECTION_LABEL } from '../../shared/types/records'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordFileRepo, RecordFileSource } from '../ports/record-files'
import type { RecordAccessRow, RecordCandidateFilter, RecordRepository, RecordRow } from '../ports/records'
import type { Member } from './access'
import { requireFullAccess } from './access'
import { logError } from '../lib/error-log'
import { ok, refuse, type Outcome } from './outcome'
import { linkAllowed, recordReader, type RecordReader } from './record-access'
import { currentTypes, type RecordIndexer } from './record-index'

export const RECORDS_DISABLED = { error: 'この会社では記録の機能が有効になっていません', code: 'RECORDS_DISABLED' }
export const RECORD_NOT_FOUND = { error: '記録が見つかりません', code: 'RECORD_NOT_FOUND' }
const ADMIN_ONLY = 'Only owners and admins can manage the company map'

/** Rows read from SQL before the caller's read access is applied (a count beyond it is not exact). */
export const MAX_CANDIDATES = 20000
/** Field kinds a query may compare by range or sort by (stored values order correctly as text or number). */
const ORDERED_KINDS: readonly FieldKind[] = ['date', 'datetime', 'number']
/** Records reached per hop of a link traversal. */
const MAX_NEIGHBOURS = 2000

export interface RecordServiceDeps {
  companyData: CompanyDataSource
  clock: Clock
  indexer: RecordIndexer
  /**
   * Tells whether linked files still exist (the detail's `broken`). Without
   * it (tests that read no repository) file links carry no `broken`.
   */
  recordFiles?: Pick<RecordFileSource, 'existing'>
}

/**
 * Which of these company paths exist now: each read from the repository
 * holding it (a private folder's own, else the company's). Paths in a
 * repository that cannot be read are left out of both answers.
 */
async function missingPaths(files: Pick<RecordFileSource, 'existing'>, companyId: string, paths: string[], scopes: ScopeWithRules[]): Promise<{ missing: Set<string>; known: Set<string> }> {
  const groups = new Map<string, { repo: RecordFileRepo; prefix: string; paths: string[] }>()
  for (const p of paths) {
    const s = findPrivateScope(scopes, p)
    const key = s ? `scope:${s.id}` : 'company'
    const g = groups.get(key) ?? { repo: s ? { kind: 'scope', repoId: s.repoId as string } : { kind: 'company' }, prefix: s ? s.path : '', paths: [] }
    g.paths.push(p)
    groups.set(key, g)
  }
  const missing = new Set<string>()
  const known = new Set<string>()
  for (const g of groups.values()) {
    const inside = (p: string) => (g.prefix === '' ? p : p.slice(g.prefix.length + 1))
    let found: Set<string> | null = null
    try {
      found = await files.existing(companyId, g.repo, g.paths.filter(p => p !== g.prefix).map(inside))
    } catch (err) {
      logError('records', 'Checking linked files failed', err, { company: companyId })
    }
    if (found === null) continue
    for (const p of g.paths) {
      known.add(p)
      if (p !== g.prefix && !found.has(inside(p))) missing.add(p)
    }
  }
  return { missing, known }
}

type Scalar = RecordFieldValue
const isScalar = (v: unknown): v is Scalar => v === null || ['string', 'number', 'boolean'].includes(typeof v)

interface ParsedQuery {
  type?: string
  implements?: string
  state?: string[]
  fields: Array<{ name: string; values: Scalar[] }>
  /** `{ contains: tag }` on a tags field. */
  contains: Array<{ name: string; tag: string }>
  /** `{ gte?, lt? }` on a date / datetime / number field. */
  ranges: Array<{ name: string; gte?: string | number; lt?: string | number }>
  /** Order by a date / datetime / number field (empty values last); default: most recently changed first. */
  sort?: { field: string; order: 'asc' | 'desc' }
  /** Records in a final state they entered at or after this time (ISO). */
  finishedSince?: string
  /** Records whose outgoing link `name` holds `id` (e.g. a task's `bundle`). */
  link?: { name: string; id: string }
  linkedTo?: { id: string; hops: 1 | 2 }
  text?: string
  limit: number
  offset: number
  countOnly: boolean
  includeOldConnection: boolean
}

function parseQuery(body: unknown): ParsedQuery | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The query must be an object'
  const b = body as Record<string, unknown>
  const known = ['type', 'implements', 'state', 'fields', 'linkedTo', 'link', 'sort', 'finishedSince', 'text', 'limit', 'offset', 'countOnly', 'includeOldConnection']
  for (const k of Object.keys(b)) if (!known.includes(k)) return `Unknown query key: ${k}`
  const q: ParsedQuery = { fields: [], contains: [], ranges: [], limit: 50, offset: 0, countOnly: b.countOnly === true, includeOldConnection: false }
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
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'contains')) {
        if (Object.keys(v).length !== 1) return `Field ${name}: { contains: tag } alone`
        const tag = normalizeTag((v as { contains: unknown }).contains)
        if (tag === null) return `Field ${name}: contains takes one tag (1–40 characters)`
        q.contains.push({ name, tag })
        continue
      }
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && ('gte' in v || 'lt' in v)) {
        const r = v as Record<string, unknown>
        if (Object.keys(r).some(k => k !== 'gte' && k !== 'lt')) return `Field ${name}: { gte?, lt? } alone`
        const bound = (x: unknown) => x === undefined || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length >= 1 && x.length <= 40)
        if (!bound(r.gte) || !bound(r.lt)) return `Field ${name}: gte / lt take a date, date and time, or number`
        q.ranges.push({ name, ...(r.gte !== undefined ? { gte: r.gte as string | number } : {}), ...(r.lt !== undefined ? { lt: r.lt as string | number } : {}) })
        continue
      }
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
  if (b.link !== undefined) {
    const l = b.link as { name?: unknown; id?: unknown }
    if (typeof l !== 'object' || l === null || typeof l.name !== 'string' || !ONTOLOGY_NAME_RE.test(l.name) || typeof l.id !== 'string' || !RECORD_ID_RE.test(l.id)) {
      return 'link: { name: link name, id: record id }'
    }
    q.link = { name: l.name, id: l.id }
  }
  if (b.sort !== undefined) {
    const so = b.sort as { field?: unknown; order?: unknown }
    if (typeof so !== 'object' || so === null || typeof so.field !== 'string' || !ONTOLOGY_NAME_RE.test(so.field)) return 'sort: { field, order?: asc | desc }'
    if (so.order !== undefined && so.order !== 'asc' && so.order !== 'desc') return 'sort.order is asc or desc'
    q.sort = { field: so.field, order: (so.order as 'asc' | 'desc' | undefined) ?? 'asc' }
  }
  if (b.finishedSince !== undefined) {
    if (typeof b.finishedSince !== 'string' || b.finishedSince.length > 40 || Number.isNaN(Date.parse(b.finishedSince))) return 'finishedSince must be a date and time'
    q.finishedSince = new Date(b.finishedSince).toISOString()
  }
  if (b.text !== undefined) {
    if (typeof b.text !== 'string') return 'text must be a string'
    const t = b.text.normalize('NFC').trim()
    if (t.length > 100) return 'text: at most 100 characters'
    if (t !== '') q.text = t
  }
  if (b.includeOldConnection !== undefined) {
    if (typeof b.includeOldConnection !== 'boolean') return 'includeOldConnection must be true or false'
    q.includeOldConnection = b.includeOldConnection
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

/**
 * `old`: records imported through an earlier connection of an outside system
 * (`oldConnectionIds`), marked so that people and the AI can tell them from
 * the ones in use.
 */
export function recordSummaries(records: RecordRepository, rows: RecordRow[], old?: ReadonlySet<string>): Map<string, RecordSummary> {
  const states = new Map(records.states(rows.map(r => r.id)).map(s => [s.recordId, s]))
  return new Map(rows.map(r => {
    const s = states.get(r.id)
    let fields: Record<string, Scalar> = {}
    try { fields = s ? JSON.parse(s.fields) as Record<string, Scalar> : {} } catch { fields = {} }
    return [r.id, {
      id: r.id, type: r.type, typeVersion: r.typeVersion, title: r.title, summary: r.summary, path: r.path,
      state: s?.state ?? null, fields, version: s?.version ?? 0, updatedAt: s && s.updatedAt > r.updatedAt ? s.updatedAt : r.updatedAt,
      ...(old?.has(r.id) ? { fromOldConnection: true as const, notice: OLD_CONNECTION_LABEL } : {}),
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

export function createRecordService(deps: RecordServiceDeps) {
  const { companyData, clock, indexer } = deps
  const handleOf = (member: Member) => companyData.forCompany(member.companyId)
  /** Records of an earlier connection of an outside system (plugins.md "Connections"). */
  const oldConnectionIds = (member: Member): Set<string> => new Set(handleOf(member).plugins.oldConnectionRecordIds())
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
          if (def.fields[f.name].kind === 'tags') return refuse('bad-request', `Field ${f.name} holds tags: use { contains: tag }`)
        }
        if (q.state && !q.state.every(s => def.states.includes(s))) return refuse('bad-request', `Unknown state of ${q.type}`)
      }
      if (q.contains.length > 0) {
        // Only types whose field of that name holds tags (a text field that happens to look like a list is never searched).
        const withTags = [...types].filter(([, t]) => q.contains.every(c => t.definition.fields[c.name]?.kind === 'tags')).map(([n]) => n)
        if (q.type && types.has(q.type) && !withTags.includes(q.type)) {
          return refuse('bad-request', `contains: ${q.contains.map(c => c.name).join(', ')} must be tags fields of ${q.type}`)
        }
        filter.types = filter.types ? filter.types.filter(t => withTags.includes(t)) : withTags
        filter.contains = q.contains
      }
      // Ranges and sorting: only types whose field of that name is ordered (date, date and time, number).
      const orderedFields = [...q.ranges.map(r => r.name), ...(q.sort ? [q.sort.field] : [])]
      if (orderedFields.length > 0) {
        const fit = [...types].filter(([, t]) => orderedFields.every(n => t.definition.fields[n]?.source === 'server' && ORDERED_KINDS.includes(t.definition.fields[n].kind))).map(([n]) => n)
        if (q.type && types.has(q.type) && !fit.includes(q.type)) return refuse('bad-request', `${orderedFields.join(', ')} must be date, date-and-time or number fields of ${q.type}`)
        filter.types = filter.types ? filter.types.filter(t => fit.includes(t)) : fit
        if (q.ranges.length > 0) filter.ranges = q.ranges
        if (q.sort) filter.sort = q.sort
      }
      if (q.finishedSince) {
        // Final states differ per type: the pairs (type, final state); a type without any is never finished.
        const finals = [...types].flatMap(([n, t]) => t.definition.final.map(s => ({ type: n, state: s })))
        const withFinal = new Set(finals.map(f => f.type))
        filter.types = (filter.types ?? [...types.keys()]).filter(t => withFinal.has(t))
        filter.finishedSince = { since: q.finishedSince, finals }
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
      // By a link (a task's bundle): the target must be one the member reads, as linkedTo; a link that
      // may not be followed (public → private) never matches.
      let linkTarget: RecordAccessRow | undefined
      if (q.link) {
        linkTarget = records.byIds([q.link.id]).find(r => reader.record(r))
        if (!linkTarget) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
        filter.link = q.link
      }
      if (filter.types?.length === 0 || filter.ids?.length === 0) return ok({ total: 0, records: [] })

      const old = oldConnectionIds(member)
      const visible = records.candidates(filter, MAX_CANDIDATES)
        .filter(r => reader.record(r) && (q.includeOldConnection || !old.has(r.id)) && (!linkTarget || linkAllowed(r, linkTarget)))
      if (q.countOnly) return ok({ total: visible.length, records: [] })
      const page = visible.slice(q.offset, q.offset + q.limit)
      const byId = recordSummaries(records, records.byIds(page.map(r => r.id)), old)
      return ok({ total: visible.length, records: page.map(r => byId.get(r.id)).filter((s): s is RecordSummary => !!s) })
    },

    /**
     * 「あなたの番」 (4-4): records of every type implementing `request` that
     * wait for the member — `next_actor` is them, or nobody is next and they
     * are the `assignee` — in a state that is not final. The type does not
     * matter: a new kind of request appears here without changing this.
     */
    myTurn(member: Member): Outcome<RecordQueryResult> {
      const records = handleOf(member).records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const types = [...currentTypes(records)].filter(([, t]) => t.definition.implements.includes('request'))
      if (types.length === 0) return ok({ total: 0, records: [] })
      const names = types.map(([n]) => n)
      // Not final, and not the AI's turn (a task being prepared reaches the person when the AI hands it over).
      const finalOf = new Map(types.map(([n, t]) => [n, new Set([...t.definition.final, ...aiTurnStates(t.definition)])]))
      const reader = recordReader(member, handleOf(member).scopes.listWithRules())
      const mine = records.candidates({ types: names, fields: [{ name: 'next_actor', values: [member.userId] }] }, MAX_CANDIDATES)
      const assigned = records.candidates({
        types: names, fields: [{ name: 'assignee', values: [member.userId] }, { name: 'next_actor', values: [null] }],
      }, MAX_CANDIDATES)
      const seen = new Set<string>()
      // A record of an earlier connection waits for nobody: it is no longer used.
      const old = oldConnectionIds(member)
      const visible = [...mine, ...assigned].filter(r => !seen.has(r.id) && (seen.add(r.id), true) && !old.has(r.id) && reader.record(r))
      const states = new Map(records.states(visible.map(r => r.id)).map(s => [s.recordId, s.state]))
      const waiting = visible.filter(r => !finalOf.get(r.type)?.has(states.get(r.id) ?? ''))
      const page = waiting.slice(0, 200)
      const byId = recordSummaries(records, records.byIds(page.map(r => r.id)))
      return ok({ total: waiting.length, records: page.map(r => byId.get(r.id)).filter((s): s is RecordSummary => !!s) })
    },

    /**
     * 「AI の番」 (milestone 4, design §3-1 / q16): records whose current
     * state has an action only the AI may do (`who` exactly `[ai]`), for which
     * the member is the `assignee` or `next_actor`, readable by them. Nothing
     * new in the type format and no type named here: a state with an AI-only
     * action left is the AI's turn.
     */
    aiTurn(member: Member): Outcome<RecordQueryResult> {
      const records = handleOf(member).records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const aiStates = new Map<string, Set<string>>()
      for (const [name, t] of currentTypes(records)) {
        const states = aiTurnStates(t.definition)
        if (states.size > 0) aiStates.set(name, states)
      }
      if (aiStates.size === 0) return ok({ total: 0, records: [] })
      const names = [...aiStates.keys()]
      const reader = recordReader(member, handleOf(member).scopes.listWithRules())
      const seen = new Set<string>()
      const visible = ['assignee', 'next_actor']
        .flatMap(field => records.candidates({ types: names, fields: [{ name: field, values: [member.userId] }] }, MAX_CANDIDATES))
        .filter(r => !seen.has(r.id) && (seen.add(r.id), true) && reader.record(r))
      const states = new Map(records.states(visible.map(r => r.id)).map(s => [s.recordId, s.state]))
      const waiting = visible.filter(r => aiStates.get(r.type)?.has(states.get(r.id) ?? ''))
      const page = waiting.slice(0, 200)
      const byId = recordSummaries(records, records.byIds(page.map(r => r.id)))
      return ok({ total: waiting.length, records: page.map(r => byId.get(r.id)).filter((s): s is RecordSummary => !!s) })
    },

    async get(member: Member, recordId: string): Promise<Outcome<RecordDetail>> {
      const records = handleOf(member).records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const scopes = handleOf(member).scopes.listWithRules()
      const reader = recordReader(member, scopes)
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
      const sums = recordSummaries(records, [row, ...shown.values()], oldConnectionIds(member))
      // Only paths already shown to this reader are looked up.
      const filePaths = links.flatMap(l => (l.path !== undefined ? [l.path] : []))
      const files = deps.recordFiles && filePaths.length > 0
        ? await missingPaths(deps.recordFiles, member.companyId, filePaths, scopes)
        : null
      return ok({
        record: sums.get(row.id)!,
        links: links.map((l): RecordLinkView => (l.id
          ? { name: l.name, direction: l.direction, record: sums.get(l.id)! }
          : { name: l.name, direction: l.direction, path: l.path!, ...(files?.known.has(l.path!) ? { broken: files.missing.has(l.path!) } : {}) })),
      })
    },
  }
}

export type RecordService = ReturnType<typeof createRecordService>
