/**
 * 「決めたこと」 (decision records, milestone 4; `.claude/rules/records.md`
 * "Decisions"): a server record, like every record (owner decision
 * 2026-11-01: record data lives only on the server; no file, no commit). The
 * service creates it with its state (`unconfirmed`) through the service
 * writer.
 *
 * Rules (design §3-3, §9 q14):
 * - the place is a department folder the member may write, never a private
 *   folder nor inside one, and never wider than a linked record's folder;
 *   every refusal of a place says the same words and never names it. The
 *   folder decides who may read the decision (those who can read it);
 * - links name a まとまり (`bundle`: any type implementing it), the meeting and
 *   the approval request it came from — never a business plugin's type;
 * - `exception` (例外（この件だけ）): a judgement for its linked thing only, never
 *   a precedent; set here or later by the `set_exception` action (who may confirm);
 * - an optional idempotency `key` (`meeting-…:decision:2`) records the same
 *   item once: the id is derived from it and it is kept in the `source_key` field.
 *   With a meeting link the key is the meeting's (`<meeting id>:<key>`, unless it starts
 *   with the meeting's id already), so another meeting's `1` is never this one; and a
 *   decision of the same meeting with the same title is the same item too
 *   (minutes.md "Outputs made once");
 * - decision version 6 (owner decision 2026-11-07 「決めたことを人が確かめる」): it starts as
 *   「決めたことの案」 — `decided_by` stays empty until a person confirms it (the engine fills it with
 *   the confirmer); `owner` (残した人) is the member only for a decision with no meeting (who decides
 *   when there is no まとまりの責任者: the meeting's readers, else they); `said_by` / `objection` are
 *   what the AI read in the minutes (who said it, whether anyone objected) — outside text.
 */
import { FEATURE_OFF } from '../../shared/core/features'
import { nameKey, normalizeRepoPath, isSameOrAncestorPath } from '../../shared/core/paths'
import { findPrivateScope, resolveAccess, type PermissionRepository } from '../../shared/core/permissions'
import type { LedgerValue } from '../../shared/core/record-ledger'
import { newRecordId, RECORD_ID_RE } from '../../shared/core/records'
import { INTERFACES } from '../../shared/core/record-types'
import type { RecordSummary } from '../../shared/types/records'
import type { IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { RecordRow } from '../ports/records'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { MEETING_OUTPUT_REUSED_NOTE } from '../../shared/core/meeting-outputs'
import { slotQuote } from '../../shared/core/source-slot-candidates'
import { neutralizeOutsideText } from '../../shared/core/outside-text'
import { decideSlot, slotScope } from './source-slot-candidates'
import { recordReader } from './record-access'
import { ASSIGNEE_CANNOT_READ, type ActorInput, type ServiceRecordWriter } from './record-engine'
import { currentTypes } from './record-index'
import { RECORDS_DISABLED, recordSummaries } from './records'

export interface DecisionServiceDeps {
  companyData: CompanyDataSource
  writer: ServiceRecordWriter
  tokenDigest: TokenDigest
  ids: IdGenerator
  /**
   * 「使う機能」 決めたこと is on (records.md "Features on and off"). Off: nothing is recorded,
   * by a person or the AI (409 FEATURE_OFF); earlier decisions stay readable. Absent → on.
   */
  enabled?: (companyId: string) => boolean
}

/** Says nothing about the place (a private folder's name or existence never leaks). */
export const DECISION_PLACE_REFUSED = {
  error: 'この場所には決めたことを残せません。書き込める部署のフォルダを選んでください。',
  code: 'DECISION_PLACE_REFUSED',
}

const TITLE_MAX = 120
const WHY_MAX = 1000
const SOURCE_MAX = 300
const KEY_MAX = 200
const SUMMARY_MAX = 300
const SAID_BY_MAX = 60
/** `objection` (decision version 6): whether anyone objected, as the minutes say. */
const OBJECTIONS = ['none', 'raised', 'unknown']
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

const bad = (error: string, code = 'BAD_REQUEST') => refuse('bad-request', error, { code })

/** One line of text: whitespace runs (newlines too) folded to one space; null when unusable. */
function line(raw: unknown, max: number, required: boolean): string | null | undefined {
  if (raw === undefined || raw === null) return required ? null : undefined
  if (typeof raw !== 'string') return null
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (CONTROL.test(s) || s.length > max || (required && s === '')) return null
  return s === '' ? undefined : s
}

export function createDecisionService(deps: DecisionServiceDeps) {
  const { companyData, writer } = deps

  return {
    /**
     * Record a decision: `{ folder, title, why, source, links?: { bundle?, meeting?, approval? },
     * important?, exception?, key? }` (`exception`: 例外（この件だけ）, never a precedent; no `folder` — and none allowed — from a members-only meeting). The person's own call (session) or their AI's (record token, `actor.kind: ai`).
     */
    async record(member: Member, actor: ActorInput, body: unknown): Promise<Outcome<{ record: RecordSummary; created: boolean; reused?: true; note?: string }>> {
      const handle = companyData.forCompany(member.companyId)
      const records = handle.records
      if (!records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      if (deps.enabled && !deps.enabled(member.companyId)) return refuse('conflict', FEATURE_OFF.error, { code: FEATURE_OFF.code })
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      const known = ['folder', 'title', 'why', 'source', 'links', 'important', 'exception', 'key', 'quote', 'said_by', 'objection']
      for (const k of Object.keys(b)) if (!known.includes(k)) return bad(`Unknown key: ${k}`)
      const title = line(b.title, TITLE_MAX, true)
      if (!title) return bad(`title: 1–${TITLE_MAX} characters on one line`)
      if (title.startsWith('#')) return bad('title: plain text')
      const why = line(b.why, WHY_MAX, true)
      if (!why) return bad(`why: 1–${WHY_MAX} characters`)
      const source = line(b.source, SOURCE_MAX, true)
      if (!source) return bad(`source: 1–${SOURCE_MAX} characters`)
      if (b.important !== undefined && typeof b.important !== 'boolean') return bad('important: true or false')
      if (b.exception !== undefined && typeof b.exception !== 'boolean') return bad('exception: true or false')
      // Who said it and whether anyone objected (decision version 6): what the minutes say — outside
      // text, kept on one line with its brackets neutralized like every outside text (outside-text.ts).
      const saidByLine = line(b.said_by, SAID_BY_MAX, false)
      if (saidByLine === null) return bad(`said_by: who said it, up to ${SAID_BY_MAX} characters on one line`)
      const saidBy = saidByLine === undefined ? null : neutralizeOutsideText(saidByLine)
      if (b.objection !== undefined && b.objection !== null && (typeof b.objection !== 'string' || !OBJECTIONS.includes(b.objection))) return bad(`objection: ${OBJECTIONS.join(' / ')}`)
      const objection = typeof b.objection === 'string' ? b.objection : null
      const givenKey = line(b.key, KEY_MAX, false)
      if (givenKey === null) return bad(`key: up to ${KEY_MAX} characters`)
      // The basis quote (the source's slot, minutes.md "Outputs made once"): its identity in the meeting's slot.
      const quote = b.quote === undefined || b.quote === null ? null : slotQuote(b.quote)
      if (b.quote !== undefined && b.quote !== null && quote === null) return bad('quote: the minutes text it rests on, copied as is (6–300 characters)', 'BAD_QUOTE')
      if (b.folder !== undefined && typeof b.folder !== 'string') return bad('folder: a department folder')

      // Links: readable records of the type the link names (`bundle`: of any type implementing it).
      const reader = recordReader(member, handle.scopes.listWithRules())
      const rawLinks = (b.links ?? {}) as Record<string, unknown>
      if (typeof rawLinks !== 'object' || rawLinks === null || Array.isArray(rawLinks)) return bad('links: { bundle?, meeting?, approval? }')
      const links: Record<string, string> = {}
      const linked: RecordRow[] = []
      const types = currentTypes(records)
      const fits = (name: string, type: string) => (name === 'bundle'
        ? types.get(type)?.definition.implements.includes('bundle') === true
        : type === name)
      for (const [name, value] of Object.entries(rawLinks)) {
        if (!['bundle', 'meeting', 'approval'].includes(name)) return bad(`links: ${name} is not a link of a decision`)
        if (value === undefined || value === null) continue
        const row = typeof value === 'string' && RECORD_ID_RE.test(value) ? records.byIds([value]).find(r => r.removedAt === null && reader.record(r)) : undefined
        if (!row || !fits(name, row.type)) {
          return bad(`links.${name}: a ${name === 'bundle' ? `${INTERFACES.bundle.label} (bundle)` : name} record you can read`, 'BAD_LINK')
        }
        links[name] = row.id
        linked.push(row)
      }

      // From a members-only meeting (records.md "Members-only records"): the meeting's members read
      // it — the service writer inherits the list, and refuses a folder with it (bad-place below).
      const fromListedMeeting = linked.some(r => r.type === 'meeting' && r.members !== null)
      if (!fromListedMeeting && typeof b.folder !== 'string') return bad('folder: a department folder')

      // The place: a department folder the member may write, not private, not wider than a linked record.
      // Its readers are the decision's readers.
      const scopes = handle.scopes.listWithRules()
      const wanted = typeof b.folder === 'string' ? normalizeRepoPath(b.folder) : null
      const department = wanted ? handle.departments.folders().find(d => nameKey(d.folder) === nameKey(wanted)) : undefined
      const perms: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => scopes }
      if (quote !== null && !links.meeting) return bad('quote: only for a decision linked to its meeting (links.meeting)', 'QUOTE_NEEDS_MEETING')
      // What an AI records from a meeting is a candidate in the meeting's slot (出どころの枠): the slot
      // module decides new or already there. A person's decision keeps the key rule below.
      const bySlot = links.meeting !== undefined && actor.kind === 'ai'
      // A meeting's item key is that meeting's: another meeting's `1` is never this one.
      let key = givenKey !== undefined && links.meeting && !givenKey.startsWith(`${links.meeting}:`) ? `${links.meeting}:${givenKey}` : givenKey
      // With a key, the id is the key's: two calls at once still make one record.
      let id = key !== undefined && !bySlot
        ? newRecordId('decision', deps.tokenDigest.digest(`decision-key:${key}`).slice(0, 24))
        : newRecordId('decision', deps.ids.newToken().slice(0, 16))
      const folder = department?.folder ?? null
      const placeOk = fromListedMeeting || (folder !== null
        && !findPrivateScope(scopes, folder)
        && resolveAccess(member.companyId, member.userId, folder, perms).write
        && linked.every(r => r.folder === null || isSameOrAncestorPath(r.folder, folder)))
      if (!placeOk) return bad(DECISION_PLACE_REFUSED.error, DECISION_PLACE_REFUSED.code)

      if (bySlot) {
        const slot = decideSlot(records, r => reader.record(r), deps.tokenDigest, {
          slot: { sourceId: links.meeting as string, linkName: 'meeting', kind: 'decision' }, title, quote, serialKey: givenKey ?? null, scope: slotScope(actor),
        })
        if (slot.kind === 'existing') {
          return ok({ record: recordSummaries(records, [slot.row]).get(slot.row.id) as RecordSummary, created: false, reused: true, note: slot.note })
        }
        if (slot.id !== null) id = slot.id
        key = slot.key !== null ? `${links.meeting}:${slot.key}` : undefined
      }
      // The same item once: an earlier decision with this key is the answer.
      if (key !== undefined && !bySlot) {
        const earlier = records.candidates({ types: ['decision'], fields: [{ name: 'source_key', values: [key] }] }, 1)[0]
          ?? (records.find(id) ? { id } : undefined)
        if (earlier) {
          const row = records.byIds([earlier.id]).find(r => reader.record(r))
          if (!row) return refuse('conflict', 'この目印の決めたことは、すでにほかの場所にあります', { code: 'KEY_TAKEN' })
          return ok({ record: recordSummaries(records, [row]).get(row.id) as RecordSummary, created: false, reused: true, note: MEETING_OUTPUT_REUSED_NOTE })
        }
      }

      // 残した人 (decision version 6): only without a meeting — with one, the meeting's readers decide
      // when there is no まとまりの責任者, and the meeting's assignee has no part of it.
      const owner: LedgerValue = links.meeting ? null : member.userId
      const input = {
        // The summary is what text search reads: the start of why.
        type: 'decision', id, title, summary: why.slice(0, SUMMARY_MAX), folder,
        fields: {
          // 決めた人 is whoever confirms it (the engine, `confirm`): nobody yet.
          recorded_by: actor.kind === 'ai' ? 'ai' : 'human', important: b.important === true, exception: b.exception === true, decided_by: null,
          owner, source_key: key ?? null, why, source, said_by: saidBy, objection,
        },
        links: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, [v]])),
        actor: { id: member.userId, kind: actor.kind, source: actor.source ?? null, conversationId: actor.conversationId ?? null, proposedBy: actor.proposedBy ?? null, runId: actor.runId ?? null },
      }
      const made = writer.create(member.companyId, input)
      if (made.ok) return ok({ record: made.record, created: true })
      if (made.reason === 'assignee-cannot-read') return bad(ASSIGNEE_CANNOT_READ, 'ASSIGNEE_CANNOT_READ')
      if (made.reason === 'bad-place') return bad(DECISION_PLACE_REFUSED.error, DECISION_PLACE_REFUSED.code)
      // The same key at the same moment: the other call made it.
      const row = records.byIds([id]).find(r => reader.record(r))
      if (made.reason === 'exists' && row) return ok({ record: recordSummaries(records, [row]).get(row.id) as RecordSummary, created: false })
      return bad('決めたことを記録できませんでした', 'DECISION_REFUSED')
    },
  }
}

export type DecisionService = ReturnType<typeof createDecisionService>
