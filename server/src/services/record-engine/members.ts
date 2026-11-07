/**
 * Members-only records (「この人たちだけ」, records.md "Members-only records", owner decision
 * 2026-11-04): the list rules the generic create, the service writer and 「招待する」 share.
 *
 * - A list names members of the company only, at most `MEMBERS_MAX` at once.
 * - What is made from a members-only meeting (a record linked to it) is members-only too: the
 *   meeting's list plus the people its own fields name (an assignee who was not there must still
 *   see their task). It is never placed wider by the system — showing it to others is a person's
 *   act (招待する, 部署に出す).
 */
import type { LedgerValue } from '../../../shared/core/record-ledger'
import type { TypeDefinition } from '../../../shared/core/record-types'
import type { RecordLinkRow, RecordMemberSet, RecordRepository, RecordSetSubject } from '../../ports/records'
import { listedUserIds } from '../record-access'

/** At most this many members in one list or one invitation (the same bound as the 見られる人 API). */
export const MEMBERS_MAX = 200

/** The type whose list what is made from it inherits. */
const MEETING_TYPE = 'meeting'

/** A list as sent (strings, ≤ MEMBERS_MAX, each a member of the company), deduplicated; or why not. */
export function membersList(raw: unknown, isMember: (userId: string) => boolean): string[] | { error: string; code: string } {
  if (!Array.isArray(raw) || !raw.every(x => typeof x === 'string' && x.length > 0 && x.length <= 200)) {
    return { error: 'members: a list of member ids', code: 'BAD_REQUEST' }
  }
  const list = [...new Set(raw as string[])]
  if (list.length > MEMBERS_MAX) return { error: `members: at most ${MEMBERS_MAX}`, code: 'BAD_REQUEST' }
  if (!list.every(isMember)) return { error: 'この会社のメンバーではない人が含まれています', code: 'BAD_MEMBER' }
  return list
}

/** What a record made from members-only meetings inherits (`meetingMembers`). */
export interface InheritedList {
  /** The people to list. */
  users: string[]
  /** The groups and departments to list (one meeting: its own; several: none, see below). */
  sets: RecordMemberSet[]
  /** Everyone the inherited list includes now (the AI may narrow within them). */
  readers: string[]
}

/**
 * The list a record linked to members-only meetings inherits, or null when it links to none. One
 * meeting: its list as written — its people and its groups / departments, so changing a group
 * changes who reads both. Several: only who is on all of them now, as people (a group on one and
 * not on another cannot be carried over without widening).
 */
export function meetingMembers(records: RecordRepository, links: readonly Pick<RecordLinkRow, 'targetId'>[]): InheritedList | null {
  const ids = [...new Set(links.map(l => l.targetId).filter((t): t is string => t !== null))]
  if (ids.length === 0) return null
  const meetings = records.byIds(ids).filter(r => r.type === MEETING_TYPE && r.members !== null)
  if (meetings.length === 0) return null
  if (meetings.length === 1) {
    const only = meetings[0]
    return { users: [...(only.members ?? [])], sets: [...(only.memberSets ?? [])], readers: listedUserIds(only) }
  }
  const lists = meetings.map(r => listedUserIds(r))
  const common = lists.slice(1).reduce<string[]>((acc, list) => acc.filter(id => list.includes(id)), [...lists[0]])
  return { users: common, sets: [], readers: common }
}

/** `list` plus every member a person field of `def` names in `values` (in that order, no repeats). */
export function withNamedPeople(list: readonly string[], def: TypeDefinition, values: Record<string, LedgerValue>): string[] {
  const named = Object.entries(values)
    .filter(([name, v]) => def.fields[name]?.kind === 'person' && typeof v === 'string' && v !== '')
    .map(([, v]) => v as string)
  return [...new Set([...list, ...named])]
}

/** A members-only list as the ledger keeps it (`place.members`): people's ids, then `group:<id>` / `department:<id>`, comma-separated. */
export function listLedgerValue(users: readonly string[], sets: readonly RecordSetSubject[] = []): string | null {
  return [...users, ...sets.map(s => `${s.type}:${s.id}`)].join(',') || null
}

/**
 * The subjects a list change names (「招待する」 `add`, 「見る人を減らす」 `remove`), in a place rule's
 * form: a person's id as a plain string (what older apps send) or `{ subjectType, subjectId }` with
 * `user` / `group` / `department`. At most `MEMBERS_MAX`, none twice. `known` says whether each one
 * exists in the company (a member, a group, a department); unknown → `BAD_MEMBER` / `BAD_GROUP` /
 * `BAD_DEPARTMENT` (a removal passes `() => true`: it only has to be on the list).
 */
export function listSubjects(
  raw: unknown, field: string, known: (s: { type: 'user' | 'group' | 'department'; id: string }) => boolean,
): { users: string[]; sets: RecordSetSubject[] } | { error: string; code: string } {
  const shape = { error: `${field}: a list of member ids or { subjectType: 'user' | 'group' | 'department', subjectId }`, code: 'BAD_REQUEST' }
  if (!Array.isArray(raw)) return shape
  const users: string[] = []
  const sets: RecordSetSubject[] = []
  const seen = new Set<string>()
  for (const x of raw as unknown[]) {
    let type: 'user' | 'group' | 'department'
    let id: unknown
    if (typeof x === 'string') {
      type = 'user'
      id = x
    } else if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>
      if (o.subjectType !== 'user' && o.subjectType !== 'group' && o.subjectType !== 'department') return shape
      type = o.subjectType
      id = o.subjectId
    } else return shape
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return shape
    const key = `${type}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (users.length + sets.length >= MEMBERS_MAX) return { error: `${field}: at most ${MEMBERS_MAX}`, code: 'BAD_REQUEST' }
    if (!known({ type, id })) {
      if (type === 'user') return { error: 'この会社のメンバーではない人が含まれています', code: 'BAD_MEMBER' }
      if (type === 'group') return { error: 'その見える人のまとまりはありません', code: 'BAD_GROUP' }
      return { error: 'その部署はありません', code: 'BAD_DEPARTMENT' }
    }
    if (type === 'user') users.push(id)
    else sets.push({ type, id })
  }
  return { users, sets }
}
