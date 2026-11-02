/**
 * What a meeting's reading makes, made once (owner FB 29, `.claude/rules/minutes.md` "Outputs made
 * once"). Reading the minutes again (「もう一度読む」, a retry, a rerun) made the same task five
 * times. Every create of an output that names its meeting (a task's or a decision's `meeting`
 * link, a mail draft's `meetingId`) first looks for the same item of that meeting:
 *
 * - **the item key** the AI gives (`key`, its own item number or name): the record's id is
 *   derived from meeting + type + key, so the same key never makes a second record;
 * - **the title**: a record of the same type linked to the same meeting whose title is the same
 *   after `outputTitleKey` is the same item.
 *
 * Found → that record is the answer (`reused: true`), nothing is written. Only records the member
 * reads count; other meetings never match. Checked and created in one synchronous stretch, so two
 * calls at once still make one.
 *
 * For what was made twice before this rule, owner/admin list the duplicates (same meeting, type
 * and title) and merge them: each duplicate is cancelled (task) or retracted (decision) with a note
 * naming the kept one — nothing is deleted. Mail drafts are listed only (the author discards them).
 */
import { outputTitleKey } from '../../shared/core/meeting-outputs'
import { FULL_ACCESS_ROLES } from '../../shared/core/permissions'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import { newRecordId, RECORD_ID_RE } from '../../shared/core/records'
import type { MeetingDuplicateGroup, MeetingDuplicates, MeetingDuplicatesMerged } from '../../shared/types/meeting-outputs'
import type { RecordSummary } from '../../shared/types/records'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { RecordRepository, RecordRow } from '../ports/records'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader } from './record-access'
import type { ActorInput } from './record-engine/types'
import { RECORDS_DISABLED, recordSummaries } from './records'

/** The record id an item key gives (its type's prefix): one record per meeting, type and key. */
export function meetingOutputId(digest: TokenDigest, type: string, meetingId: string, key: string): string {
  return newRecordId(type, digest.digest(`meeting-output:${meetingId}:${type}:${key}`).slice(0, 24))
}

/**
 * The output of `meetingId` that is the same item: the id `byId` (from the item key) if it exists,
 * else one of `type` linked to the meeting (`linkName`) with the same title key. `readable`: only
 * records the member reads.
 */
export function findMeetingOutput(
  records: RecordRepository, readable: (r: RecordRow) => boolean,
  q: { type: string; meetingId: string; title: string; byId?: string | null; linkName?: string },
): RecordRow | null {
  if (q.byId) {
    const same = records.byIds([q.byId]).find(r => r.removedAt === null)
    if (same) return readable(same) ? same : null
  }
  const want = outputTitleKey(q.title)
  if (!want) return null
  const linked = records.candidates({ types: [q.type], link: { name: q.linkName ?? 'meeting', id: q.meetingId } }, 500)
  const rows = records.byIds(linked.map(r => r.id)).filter(r => r.removedAt === null && readable(r))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  return rows.find(r => outputTitleKey(r.title) === want) ?? null
}

/** The output types merged by an action of their own (a mail draft is the author's to discard). */
const MERGE_ACTION: Record<string, string> = { task: 'cancel', decision: 'retract' }
/** States a duplicate no longer counts in (already cancelled, retracted, discarded). */
const GONE_STATES = new Set(['cancelled', 'retracted', 'discarded'])
const OUTPUT_TYPES = ['task', 'decision', 'outbound_message']
const MAX_GROUPS = 200

export interface MeetingOutputServiceDeps {
  companyData: CompanyDataSource
  /** The engine's action (cancel / retract), as the owner/admin who merges. */
  act: (member: Member, actor: ActorInput, recordId: string, action: string, body: unknown) => Promise<Outcome<{ record: RecordSummary; entry: LedgerEntry }>>
}

export function createMeetingOutputService(deps: MeetingOutputServiceDeps) {
  const disabled = () => refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
  const adminOnly = () => refuse('forbidden', 'この操作は管理者だけができます', { code: 'FORBIDDEN' })

  /** Every group of the same meeting, type and title with two or more live records. */
  function groups(member: Member): MeetingDuplicateGroup[] {
    const handle = deps.companyData.forCompany(member.companyId)
    const records = handle.records
    const reader = recordReader(member, handle.scopes.listWithRules())
    const meetings = records.byIds(records.candidates({ types: ['meeting'] }, 5000).map(r => r.id)).filter(r => r.removedAt === null && reader.record(r))
    if (meetings.length === 0) return []
    const meetingTitle = new Map(meetings.map(m => [m.id, m.title]))
    const links = records.linksTo(meetings.map(m => m.id)).filter(l => l.name === 'meeting' && l.targetId)
    const sources = new Map(records.byIds([...new Set(links.map(l => l.sourceId))])
      .filter(r => r.removedAt === null && OUTPUT_TYPES.includes(r.type) && reader.record(r)).map(r => [r.id, r]))
    const states = new Map(records.states([...sources.keys()]).map(s => [s.recordId, s.state]))
    const byItem = new Map<string, { meetingId: string; rows: RecordRow[] }>()
    for (const l of links) {
      const row = sources.get(l.sourceId)
      const titleKey = row ? outputTitleKey(row.title) : ''
      if (!row || !titleKey) continue
      const k = `${l.targetId}\u0000${row.type}\u0000${titleKey}`
      const g = byItem.get(k) ?? { meetingId: l.targetId as string, rows: [] }
      if (!g.rows.some(r => r.id === row.id)) g.rows.push(row)
      byItem.set(k, g)
    }
    const out: MeetingDuplicateGroup[] = []
    for (const g of byItem.values()) {
      const live = g.rows.filter(r => !GONE_STATES.has(states.get(r.id) ?? ''))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      if (live.length < 2) continue
      const summaries = recordSummaries(records, live)
      const [keep, ...dups] = live.map(r => summaries.get(r.id) as RecordSummary)
      out.push({ meetingId: g.meetingId, meetingTitle: meetingTitle.get(g.meetingId) ?? '', type: keep.type, keep, duplicates: dups, mergeable: keep.type in MERGE_ACTION })
      if (out.length >= MAX_GROUPS) break
    }
    return out
  }

  return {
    /** GET /records/meeting-duplicates — owner/admin: what one meeting made twice (same type and title). */
    duplicates(member: Member): Outcome<MeetingDuplicates> {
      if (!FULL_ACCESS_ROLES.has(member.role)) return adminOnly()
      if (!deps.companyData.forCompany(member.companyId).records.settings().enabled) return disabled()
      return ok({ groups: groups(member) })
    },

    /**
     * POST /records/meeting-duplicates/merge { keepId, duplicateIds } — owner/admin: each duplicate
     * of the same group as `keepId` is cancelled (task) or retracted (decision) with a note naming
     * the kept one. Nothing is deleted; a duplicate that cannot move is reported, the rest go on.
     */
    async merge(member: Member, body: unknown): Promise<Outcome<MeetingDuplicatesMerged>> {
      if (!FULL_ACCESS_ROLES.has(member.role)) return adminOnly()
      const records = deps.companyData.forCompany(member.companyId).records
      if (!records.settings().enabled) return disabled()
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return refuse('bad-request', 'The body must be an object', { code: 'BAD_REQUEST' })
      for (const k of Object.keys(b)) if (k !== 'keepId' && k !== 'duplicateIds') return refuse('bad-request', `Unknown key: ${k}`, { code: 'BAD_REQUEST' })
      const ids = Array.isArray(b.duplicateIds) ? b.duplicateIds : null
      if (typeof b.keepId !== 'string' || !RECORD_ID_RE.test(b.keepId) || !ids || ids.length === 0 || ids.length > 50
        || !ids.every(i => typeof i === 'string' && RECORD_ID_RE.test(i) && i !== b.keepId)) {
        return refuse('bad-request', 'keepId: a record id; duplicateIds: 1–50 other record ids', { code: 'BAD_REQUEST' })
      }
      // Only records of one listed group: the same meeting, type and title as the kept one.
      const group = groups(member).find(g => g.keep.id === b.keepId || g.duplicates.some(d => d.id === b.keepId))
      const members = group ? [group.keep, ...group.duplicates] : []
      if (!group || !(ids as string[]).every(i => members.some(m => m.id === i))) {
        return refuse('bad-request', '同じ会議から同じ名前で作られたものだけをまとめられます', { code: 'NOT_DUPLICATES' })
      }
      const action = MERGE_ACTION[group.type]
      if (!action) return refuse('bad-request', 'この種類は、作った人が画面で取り消します', { code: 'NOT_MERGEABLE' })
      const kept = members.find(m => m.id === b.keepId) as RecordSummary
      const note = `同じ会議から重複して作られたため、こちらは使いません。残したもの：「${kept.title}」（${kept.id}）`
      const merged: string[] = []
      const failed: Array<{ id: string; code: string | null }> = []
      for (const id of ids as string[]) {
        const now = records.states([id])[0]
        const r = await deps.act(member, { kind: 'human' }, id, action, { expectedVersion: now?.version ?? 0, note })
        if (r.ok) merged.push(id)
        else failed.push({ id, code: typeof r.body.code === 'string' ? r.body.code : null })
      }
      return ok({ keptId: kept.id, merged, failed })
    },
  }
}

export type MeetingOutputService = ReturnType<typeof createMeetingOutputService>
