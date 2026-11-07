/**
 * 「部署に出す」: an owner-only or members-only record shared to a folder (records.md "Owner-only
 * records", "Members-only records"); 「招待する」: members added to a members-only record.
 */
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { listLedgerValue, listSubjects } from './members'
import { listedUserIds, onList, recordReader } from '../record-access'
import { FULL_ACCESS_ROLES } from '../../../shared/core/permissions'
import type { RecordSetSubject } from '../../ports/records'
import { ASSIGNEE_CANNOT_READ, REVIEWER_CANNOT_READ, bad, conflict } from './refusals'
import type { ActorInput } from './types'
import { NOTE_MAX, provenance } from './values'
import { BUNDLE_PLACED_TYPES, NAMED_PERSON_CANNOT_READ, linkedBundle } from './bundle-place'
import { pathKey } from '../../../shared/core/paths'
import { similarInSlot } from '../source-slot-candidates'

/** The ledger action of sharing an owner-only or members-only record to a folder. */
export const SHARE_ACTION = 'share'
/** The ledger action of adding members to a members-only record. */
export const INVITE_ACTION = 'invite'
/** The ledger action of taking people, groups or departments off a members-only record's list. */
export const REMOVE_MEMBERS_ACTION = 'remove_members'

const STALE = 'ほかの人が先に変えました。最新の状態を見てからもう一度お試しください'
/** The groups and departments on a row's list, as subjects (without who is in them). */
const setsOf = (row: { memberSets?: readonly RecordSetSubject[] }): RecordSetSubject[] => (row.memberSets ?? []).map(s => ({ type: s.type, id: s.id }))

export function sharing(ctx: EngineContext) {
  const { deps, companyData, transactions, clock, open, canRead, placeFolder, stateOf, summaryOf, changed } = ctx

  /** The record as the member reads it (else the answer for a record that does not exist). */
  function readable(member: Member, recordId: string) {
    const opened = open(member)
    if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
    const { records, reader } = opened
    const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
    if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
    return { ok: true as const, records, reader, row }
  }

  /** The body's object, `expectedVersion` and `note`, or the refusal. */
  function bodyOf(body: unknown): { b: Record<string, unknown>; expected: number; note: string } | Outcome<never> {
    const b = body as Record<string, unknown> | null
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
    if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
    const note = b.note === undefined ? '' : b.note
    if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)
    return { b, expected: b.expectedVersion as number, note }
  }

  /**
   * May the member widen a members-only list by a group or a department (owner direction
   * 2026-11-08)? The record's 責任者 — its `assignee`, or a まとまり's `owner` —, a 部署の管理役 (of
   * any department) or an owner / admin. Being on the list is the caller's own check (readable).
   */
  function mayWiden(member: Member, def: { implements: readonly string[] }, fields: Record<string, unknown>): boolean {
    if (FULL_ACCESS_ROLES.has(member.role)) return true
    if (fields.assignee === member.userId) return true
    if (def.implements.includes('bundle') && fields.owner === member.userId) return true
    return deps.managedFolders(member.companyId, member.userId).length > 0
  }

  return {
    /**
     * 「部署に出す／案件につなぐ」 (records.md "Owner-only records", "Members-only records"): an
     * owner-only or members-only record becomes visible to the readers of `folder` (a department
     * folder the member reads, never a private one — except the folder of the まとまり it links to; or,
     * with `toBundle`, that まとまり's place). Only its owner / a listed member — nobody
     * else can even find it — and only the person, with their session (the route has no AI
     * twin). A ledger entry `share` with `place.personal_owner` (or `place.members`) /
     * `place.folder` before / after; never undone. Made from a meeting (its `meeting` link): the answer
     * adds `similar` when a live item of that meeting the member reads has a close title
     * (「似ているやることがあります」, 出どころの枠 §10 — a hint only, the share is never refused).
     */
    share(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry; similar?: { id: string; title: string } }> {
      const found = readable(member, recordId)
      if (!found.ok) return found
      const { records, reader, row } = found
      // Readable and owner-only means it is the member's own (the reader shows it to nobody else);
      // readable and members-only means the member is on its list.
      if (row.personalOwner !== member.userId && row.members === null) return conflict('この記録はもうほかの人にも見えています', 'NOT_PERSONAL')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const parsed = bodyOf(body)
      if (!('b' in parsed)) return parsed
      const { b, expected, note } = parsed
      // ［プロジェクトの人に見せる］ (records.md "A task and its 案件・プロジェクト"): the まとまり the task
      // links to gives the place — its folder, a private one included (the member reads the まとまり, so
      // its folder), or the whole company. `toBundle: true` names it without a path.
      const bundle = BUNDLE_PLACED_TYPES.includes(row.type) ? linkedBundle(records, def, records.linksFrom([row.id]), r => reader.record(r)) : null
      let folder: string | null
      if (b.toBundle === true) {
        if (!bundle) return bad('つながっている案件・プロジェクトがありません', 'NO_BUNDLE')
        if (bundle.personalOwner !== null || bundle.members !== null) return conflict('つなぐ先は見る人を選んだものなので、ここからは見せられません', 'BUNDLE_NOT_PLACED')
        folder = bundle.folder
      } else {
        if (b.folder === undefined || b.folder === null) return bad('folder: the department folder whose readers will see it', 'FOLDER_REQUIRED')
        const bundleFolder = bundle && bundle.personalOwner === null && bundle.members === null ? bundle.folder : null
        const placed = placeFolder(member, row.type, b.folder, reader, f => bundleFolder !== null && pathKey(f) === pathKey(bundleFolder))
        if (typeof placed !== 'string') return placed
        folder = placed
      }
      const current = stateOf(records, row, def)
      // A members-only record's assignee / reviewer may be someone other than the member sharing it:
      // they must still read it in its new place (as on create; the place is never named).
      const place = { id: row.id, type: row.type, scopeId: null, path: null, folder, personalOwner: null, members: null }
      if (typeof current.fields.assignee === 'string' && !canRead(member.companyId, current.fields.assignee, place)) {
        return bad(ASSIGNEE_CANNOT_READ, 'ASSIGNEE_CANNOT_READ')
      }
      if (typeof current.fields.reviewer === 'string' && !canRead(member.companyId, current.fields.reviewer, place)) {
        return bad(REVIEWER_CANNOT_READ, 'REVIEWER_CANNOT_READ')
      }
      if (expected !== current.version) return conflict(STALE, 'VERSION_CONFLICT', { version: current.version })
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: SHARE_ACTION, fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [
          row.members !== null
            ? { field: 'place.members', before: listLedgerValue(row.members, setsOf(row)), after: null }
            : { field: 'place.personal_owner', before: member.userId, after: null },
          { field: 'place.folder', before: row.folder, after: folder },
        ],
        attachments: [], decision: null, isDecision: false, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
      }
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) return false
        records.setPlace(row.id, { folder, personalOwner: null }, at)
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict(STALE, 'VERSION_CONFLICT')
      changed(member.companyId, row.id)
      const meetingId = def.links.meeting?.target === 'meeting' ? records.linksFrom([row.id]).find(l => l.name === 'meeting' && l.targetId)?.targetId ?? null : null
      const similar = meetingId ? similarInSlot(records, r => reader.record(r), { slot: { sourceId: meetingId, linkName: 'meeting', kind: row.type }, title: row.title, self: row.id }) : null
      return ok({ record: summaryOf(records, row.id), entry, ...(similar ? { similar } : {}) })
    },

    /**
     * 「招待する」 (records.md "Members-only records"): someone on a members-only record's list adds
     * to it — people (any reader, as before) and, written in a place rule's subjects, groups and
     * departments (who is in them read at read time). Adding a group or a department widens the
     * record to whoever joins it later, so only the record's 責任者 (its `assignee`, or a まとまり's
     * `owner`), a 部署の管理役 or an owner / admin may — each also on the list, since nobody else can
     * find it (403 `LIST_WIDENING_NOT_ALLOWED`). Only the person, with their session (no AI route).
     * A ledger entry `invite` with `place.members` before / after; never undone (the added may have
     * seen it). The added hear of it through the `records` signal; the change also goes to
     * `permission_history` (`record-members`).
     */
    invite(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{
      record: RecordSummary; entry: LedgerEntry; added: string[]; addedSets: RecordSetSubject[]
    }> {
      const found = readable(member, recordId)
      if (!found.ok) return found
      const { records, row } = found
      if (row.members === null) return conflict('この記録は見る人を選んだ記録ではありません', 'NOT_MEMBERS_ONLY')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const parsed = bodyOf(body)
      if (!('b' in parsed)) return parsed
      const { b, expected, note } = parsed
      const handle = companyData.forCompany(member.companyId)
      const list = listSubjects(b.add, 'add', s => s.type === 'user' ? deps.isMember(member.companyId, s.id)
        : s.type === 'group' ? handle.groups.find(s.id) !== null : handle.departments.find(s.id) !== undefined)
      if ('error' in list) return bad(list.error, list.code)
      if (list.users.length + list.sets.length === 0) return bad('add: at least one member')
      const current = stateOf(records, row, def)
      if (list.sets.length > 0 && !mayWiden(member, def, current.fields)) {
        return refuse('forbidden', 'まとまりや部署で見る人を足せるのは、この記録の責任者・部署の管理役・管理者だけです', { code: 'LIST_WIDENING_NOT_ALLOWED' })
      }
      if (expected !== current.version) return conflict(STALE, 'VERSION_CONFLICT', { version: current.version })
      const beforeSets = setsOf(row)
      const afterUsers = [...new Set([...row.members, ...list.users])]
      const afterSets = [...beforeSets, ...list.sets.filter(s => !beforeSets.some(x => x.type === s.type && x.id === s.id))]
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: INVITE_ACTION, fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [{ field: 'place.members', before: listLedgerValue(row.members, beforeSets), after: listLedgerValue(afterUsers, afterSets) }],
        attachments: [], decision: null, isDecision: false, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
      }
      let added: string[] = []
      let addedSets: RecordSetSubject[] = []
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) return false
        added = records.addMembers(row.id, list.users, member.userId, at)
        addedSets = list.sets.length > 0 ? records.addMemberSets(row.id, list.sets, member.userId, at) : []
        records.appendLedger(entry)
        if (added.length + addedSets.length > 0) {
          handle.permissionHistory.append({
            action: 'record-members', at, byUser: member.userId,
            detail: { recordId: row.id, via: 'invite', added: { users: added, sets: addedSets } },
          })
        }
        return true
      })
      if (!written) return conflict(STALE, 'VERSION_CONFLICT')
      changed(member.companyId, row.id)
      return ok({ record: summaryOf(records, row.id), entry, added, addedSets })
    },

    /**
     * 「見る人を減らす」 (records.md "Members-only records"): someone on a members-only record's list
     * takes people, groups or departments off it. Narrowing is free for whoever reads it (owner
     * direction 2026-11-08), with two guards: everyone the record names (担当・頼んだ人・確かめる人…)
     * must still read it (400 `NAMED_PERSON_CANNOT_READ`), and someone in the company must (400
     * `LIST_WOULD_BE_EMPTY`: a record nobody reads could never be found again). Ledger action
     * `remove_members` (`place.members` before / after, never undone), `permission_history`
     * `record-members`. `record` is null when the caller took themself off.
     */
    removeMembers(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{
      record: RecordSummary | null; entry: LedgerEntry; removed: string[]; removedSets: RecordSetSubject[]
    }> {
      const found = readable(member, recordId)
      if (!found.ok) return found
      const { records, row } = found
      if (row.members === null) return conflict('この記録は見る人を選んだ記録ではありません', 'NOT_MEMBERS_ONLY')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const parsed = bodyOf(body)
      if (!('b' in parsed)) return parsed
      const { b, expected, note } = parsed
      const list = listSubjects(b.remove, 'remove', () => true)
      if ('error' in list) return bad(list.error, list.code)
      const beforeSets = setsOf(row)
      const goneUsers = list.users.filter(u => row.members?.includes(u))
      const goneSets = beforeSets.filter(s => list.sets.some(x => x.type === s.type && x.id === s.id))
      if (goneUsers.length + goneSets.length === 0) return bad('外す人が、見る人の中にいません', 'NOT_ON_LIST')
      const after = {
        members: row.members.filter(u => !goneUsers.includes(u)),
        memberSets: (row.memberSets ?? []).filter(s => !goneSets.some(x => x.type === s.type && x.id === s.id)),
      }
      const current = stateOf(records, row, def)
      const named = Object.entries(current.fields).filter(([f, v]) => def.fields[f]?.kind === 'person' && typeof v === 'string' && v !== '')
      if (!listedUserIds(after).some(u => deps.isMember(member.companyId, u))) {
        return bad('この記録を見られる人がだれもいなくなります。ほかの人を残してください', 'LIST_WOULD_BE_EMPTY')
      }
      if (named.some(([, v]) => deps.isMember(member.companyId, v as string) && !onList(after, v as string))) {
        return bad(NAMED_PERSON_CANNOT_READ.error, NAMED_PERSON_CANNOT_READ.code)
      }
      if (expected !== current.version) return conflict(STALE, 'VERSION_CONFLICT', { version: current.version })
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: REMOVE_MEMBERS_ACTION, fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [{ field: 'place.members', before: listLedgerValue(row.members, beforeSets), after: listLedgerValue(after.members, setsOf(after)) }],
        attachments: [], decision: null, isDecision: false, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
      }
      const handle = companyData.forCompany(member.companyId)
      let removed: { users: string[]; sets: RecordSetSubject[] } = { users: [], sets: [] }
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) return false
        removed = records.removeMembers(row.id, goneUsers, goneSets)
        records.appendLedger(entry)
        handle.permissionHistory.append({
          action: 'record-members', at, byUser: member.userId,
          detail: { recordId: row.id, via: 'remove', removed },
        })
        return true
      })
      if (!written) return conflict(STALE, 'VERSION_CONFLICT')
      changed(member.companyId, row.id)
      const still = records.byIds([row.id]).find(r => recordReader(member, handle.scopes.listWithRules()).record(r))
      return ok({ record: still ? summaryOf(records, row.id) : null, entry, removed: removed.users, removedSets: removed.sets })
    },

    /**
     * What the caller may put on a members-only record's list besides people (the app's 「招待する」):
     * the company's groups and departments — only for one who may widen by them (`mayWiden`); else
     * none (a member is never shown the groups' names, groups PR 2026-11-07). And the current list's
     * groups and departments by name, for a reader of the record.
     */
    listChoices(member: Member, recordId: string): Outcome<{
      maySets: boolean
      groups: Array<{ id: string; name: string }>
      departments: Array<{ id: string; name: string }>
      listed: Array<{ type: 'group' | 'department'; id: string; name: string }>
    }> {
      const found = readable(member, recordId)
      if (!found.ok) return found
      const { records, row } = found
      if (row.members === null) return conflict('この記録は見る人を選んだ記録ではありません', 'NOT_MEMBERS_ONLY')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const handle = companyData.forCompany(member.companyId)
      const groups = handle.groups.list().map(g => ({ id: g.id, name: g.name }))
      const departments = handle.departments.list().map(d => ({ id: d.id, name: d.name }))
      const maySets = mayWiden(member, def, stateOf(records, row, def).fields)
      const listed = setsOf(row).map(s => ({
        ...s, name: (s.type === 'group' ? groups : departments).find(x => x.id === s.id)?.name ?? '',
      }))
      return ok({ maySets, groups: maySets ? groups : [], departments: maySets ? departments : [], listed })
    },
  }
}
