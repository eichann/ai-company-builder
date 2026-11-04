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
import type { RecordLinkRow, RecordRepository } from '../../ports/records'

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

/**
 * The list a record linked to members-only meetings inherits: the members on every such meeting's
 * list (several meetings: only who is on all of them), or null when it links to none.
 */
export function meetingMembers(records: RecordRepository, links: readonly Pick<RecordLinkRow, 'targetId'>[]): string[] | null {
  const ids = [...new Set(links.map(l => l.targetId).filter((t): t is string => t !== null))]
  if (ids.length === 0) return null
  const lists = records.byIds(ids).filter(r => r.type === MEETING_TYPE && r.members !== null).map(r => r.members as readonly string[])
  if (lists.length === 0) return null
  return lists.slice(1).reduce<string[]>((acc, list) => acc.filter(id => list.includes(id)), [...lists[0]])
}

/** `list` plus every member a person field of `def` names in `values` (in that order, no repeats). */
export function withNamedPeople(list: readonly string[], def: TypeDefinition, values: Record<string, LedgerValue>): string[] {
  const named = Object.entries(values)
    .filter(([name, v]) => def.fields[name]?.kind === 'person' && typeof v === 'string' && v !== '')
    .map(([, v]) => v as string)
  return [...new Set([...list, ...named])]
}
