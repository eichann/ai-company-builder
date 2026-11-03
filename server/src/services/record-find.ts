/**
 * 探す, the left tab (records.md "探す"; contract `RecordFindResult` / `RecordFindHome` in
 * shared/types/records.ts): the records whose title or summary holds the words, each with what the
 * tab narrows and labels by — its department, whether the caller is in it, its 案件 — and, for a
 * 相手 / 案件 whose name holds them, a summary (counts, next meeting, last move). With nothing
 * typed: the caller's unfinished 案件 and this week's meetings.
 *
 * Everything goes through the caller's reader (services/record-access.ts): hits, totals, the
 * linked records counted and the files counted are only what they may read, and a link from
 * outside a private folder into it is never followed (`linkAllowed`), so a summary never counts
 * what the caller could not open.
 */
import { foldAsciiCase } from '../../shared/core/paths'
import { fileLinkShown } from '../../shared/core/records'
import type { TypeDefinition } from '../../shared/core/record-types'
import type { RecordFindHit, RecordFindHome, RecordFindHub, RecordFindResult, RecordSummary } from '../../shared/types/records'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordAccessRow, RecordRepository } from '../ports/records'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { linkAllowed, recordReader, type RecordReader } from './record-access'
import { currentTypes, type CurrentType } from './record-index'
import { MAX_CANDIDATES, neighbours, RECORDS_DISABLED, recordSummaries } from './records'

export interface RecordFindDeps {
  companyData: CompanyDataSource
}

/** Hits answered (newest first); `total` still counts every readable match. */
export const FIND_MAX_HITS = 200
/** Summary cards per search, and 案件 on the empty tab. */
export const FIND_MAX_HUBS = 5
const HOME_MAX = 5
/** Linked ids handed back per summary (for this PC's consultations). */
const MAX_MEMBER_IDS = 300
const DAY = /^\d{4}-\d{2}-\d{2}$/

type Defs = Map<string, CurrentType>

/** The department folder of a record: the first part of its path, or of a server-only record's folder. */
export function departmentOf(r: Pick<RecordAccessRow, 'path' | 'folder'>): string | null {
  const where = r.path ?? r.folder ?? ''
  const i = where.indexOf('/')
  if (r.path !== null) return i > 0 ? where.slice(0, i) : null
  return where === '' ? null : i > 0 ? where.slice(0, i) : where
}

function attendeeIds(raw: unknown): string[] {
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) as unknown : null
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** The caller is in it: owner-only for them, named in a person field of its type, or a meeting's attendee. */
export function involves(userId: string, r: RecordSummary, def: TypeDefinition | undefined): boolean {
  if (r.personal) return true
  for (const [name, f] of Object.entries(def?.fields ?? {})) {
    if (f.kind === 'person' && r.fields[name] === userId) return true
  }
  return attendeeIds(r.fields.attendees).includes(userId)
}

const isHubType = (def: TypeDefinition | undefined) => !!def && (def.implements.includes('bundle') || def.implements.includes('counterpart'))
const meetingAt = (r: RecordSummary): string | null => {
  const v = r.fields.meeting_at ?? r.fields.occurred_at
  return typeof v === 'string' && v ? v : null
}

export function createRecordFind(deps: RecordFindDeps) {
  const handleOf = (member: Member) => deps.companyData.forCompany(member.companyId)

  function hitsOf(records: RecordRepository, reader: RecordReader, defs: Defs, member: Member, rows: RecordAccessRow[], old: ReadonlySet<string>): RecordFindHit[] {
    const sums = recordSummaries(records, records.byIds(rows.map(r => r.id)), old)
    // Each one's 案件: its outgoing `bundle` link, shown only when the caller reads it and may follow it.
    const bundleLinks = records.linksFrom(rows.map(r => r.id)).filter(l => l.name === 'bundle' && l.targetId !== null)
    const targets = new Map(records.byIds([...new Set(bundleLinks.map(l => l.targetId as string))]).map(t => [t.id, t]))
    const byRow = new Map(rows.map(r => [r.id, r]))
    const bundleOf = new Map<string, { id: string; title: string }>()
    for (const l of bundleLinks) {
      const t = targets.get(l.targetId as string)
      const s = byRow.get(l.sourceId)
      if (t && s && linkAllowed(s, t) && reader.record(t)) bundleOf.set(l.sourceId, { id: t.id, title: t.title || '（名前なし）' })
    }
    return rows.flatMap(row => {
      const record = sums.get(row.id)
      if (!record) return []
      const bundle = bundleOf.get(row.id)
      return [{ record, department: departmentOf(row), mine: involves(member.userId, record, defs.get(row.type)?.definition), ...(bundle ? { bundle } : {}) }]
    })
  }

  /** A 相手's or 案件's summary over what the caller reads (a 相手: its 案件 and what is in them too). */
  function hubOf(records: RecordRepository, reader: RecordReader, defs: Defs, hub: RecordAccessRow, today: string, viewerId: string): RecordFindHub {
    const def = defs.get(hub.type)?.definition
    const hop1 = neighbours(records, reader, [hub])
    const bundles = hop1.filter(r => defs.get(r.type)?.definition.implements.includes('bundle'))
    const linked = def?.implements.includes('counterpart') && bundles.length > 0
      ? [...new Map([...hop1, ...neighbours(records, reader, bundles)].filter(r => r.id !== hub.id).map(r => [r.id, r])).values()]
      : hop1
    const sums = recordSummaries(records, records.byIds([hub.id, ...linked.map(r => r.id)]))
    const list = linked.flatMap(r => { const s = sums.get(r.id); return s ? [s] : [] })
    const finalOf = (s: RecordSummary) => (s.state !== null && defs.get(s.type)?.definition.final.includes(s.state)) ?? false
    const meetings = list.filter(s => s.type === 'meeting')
    const next = meetings.map(meetingAt).filter((at): at is string => !!at && at.slice(0, 10) >= today).sort()[0] ?? null
    const sources = new Map([hub, ...bundles].map(r => [r.id, r]))
    const fileLinks = records.linksFrom([hub.id, ...bundles.map(b => b.id)])
      .filter(l => l.targetPath !== null && reader.file(l.targetPath) && fileLinkShown(viewerId, sources.get(l.sourceId) ?? { personalOwner: null }, l))
    const moved = [sums.get(hub.id)?.updatedAt ?? '', ...list.map(s => s.updatedAt)].sort()
    return {
      id: hub.id,
      counts: {
        bundles: def?.implements.includes('counterpart') ? bundles.length : 0,
        openTasks: list.filter(s => s.type === 'task' && !finalOf(s)).length,
        meetings: meetings.length,
        decisions: list.filter(s => s.type === 'decision').length,
        files: new Set(fileLinks.map(l => l.targetPath)).size,
      },
      nextMeetingAt: next,
      lastMovedAt: moved[moved.length - 1] ?? '',
      memberIds: list.filter(s => s.type === 'task' || defs.get(s.type)?.definition.implements.includes('bundle')).map(s => s.id).slice(0, MAX_MEMBER_IDS),
    }
  }

  function context(member: Member) {
    const handle = handleOf(member)
    const records = handle.records
    if (!records.settings().enabled) return null
    return {
      records,
      reader: recordReader(member, handle.scopes.listWithRules()),
      defs: currentTypes(records),
      old: new Set(handle.plugins.oldConnectionRecordIds()),
    }
  }

  return {
    find(member: Member, body: unknown): Outcome<RecordFindResult> {
      const b = (typeof body === 'object' && body !== null ? body : {}) as { text?: unknown; today?: unknown }
      const text = typeof b.text === 'string' ? b.text.normalize('NFC').trim() : ''
      if (text.length === 0 || text.length > 100) return refuse('bad-request', 'text: 1–100 characters')
      if (typeof b.today !== 'string' || !DAY.test(b.today)) return refuse('bad-request', 'today must be a date (YYYY-MM-DD)')
      const c = context(member)
      if (!c) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const visible = c.records.candidates({ text }, MAX_CANDIDATES).filter(r => c.reader.record(r) && !c.old.has(r.id))
      const hits = hitsOf(c.records, c.reader, c.defs, member, visible.slice(0, FIND_MAX_HITS), c.old)
      const words = foldAsciiCase(text)
      const hubs = hits
        .filter(h => isHubType(c.defs.get(h.record.type)?.definition) && foldAsciiCase(h.record.title.normalize('NFC')).includes(words))
        .slice(0, FIND_MAX_HUBS)
        .map(h => hubOf(c.records, c.reader, c.defs, visible.find(r => r.id === h.record.id)!, b.today as string, member.userId))
      return ok({ total: visible.length, hits, hubs })
    },

    home(member: Member, body: unknown): Outcome<RecordFindHome> {
      const b = (typeof body === 'object' && body !== null ? body : {}) as { today?: unknown; from?: unknown; to?: unknown }
      if (![b.today, b.from, b.to].every(d => typeof d === 'string' && DAY.test(d))) return refuse('bad-request', 'today, from and to must be dates (YYYY-MM-DD)')
      const c = context(member)
      if (!c) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const bundleTypes = [...c.defs].filter(([, t]) => t.definition.implements.includes('bundle')).map(([n]) => n)
      const readable = (rows: RecordAccessRow[]) => rows.filter(r => c.reader.record(r) && !c.old.has(r.id))
      // Newest first already; only the caller's own and unfinished, read until five are found.
      const bundles: RecordFindHome['bundles'] = []
      const candidates = bundleTypes.length > 0 ? readable(c.records.candidates({ types: bundleTypes }, MAX_CANDIDATES)) : []
      for (let i = 0; i < candidates.length && bundles.length < HOME_MAX; i += 50) {
        for (const h of hitsOf(c.records, c.reader, c.defs, member, candidates.slice(i, i + 50), c.old)) {
          const def = c.defs.get(h.record.type)?.definition
          if (bundles.length >= HOME_MAX || !h.mine || (h.record.state !== null && def?.final.includes(h.record.state))) continue
          bundles.push({ ...h, hub: hubOf(c.records, c.reader, c.defs, candidates.find(r => r.id === h.record.id)!, b.today as string, member.userId) })
        }
      }
      const meetingRows = readable(c.records.candidates({ types: ['meeting'], ranges: [{ name: 'meeting_at', gte: b.from as string, lt: b.to as string }] }, MAX_CANDIDATES))
      const meetings = hitsOf(c.records, c.reader, c.defs, member, meetingRows.slice(0, 500), c.old)
        .filter(h => h.mine)
        .sort((x, y) => (meetingAt(x.record) ?? '').localeCompare(meetingAt(y.record) ?? ''))
        .slice(0, HOME_MAX)
      return ok({ bundles, meetings })
    },
  }
}

export type RecordFind = ReturnType<typeof createRecordFind>
