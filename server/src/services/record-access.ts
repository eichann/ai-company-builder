/**
 * Who may read which record of the company map (`.claude/rules/records.md`
 * "No leaks"): exactly who may read its file — or, for a record that lives
 * on the server only, its folder (none = everyone in the company). A record
 * in a private folder the member cannot read is a record that does not exist:
 * left out of answers, counts, link lists and traversals alike.
 *
 * Links: a record outside a private folder never shows or reaches a record
 * inside one (a public → private link is ignored for everyone, 4-1); inside
 * the same private folder they work as usual.
 *
 * Owner-only records (「持ち主だけ」, records.md "Owner-only records", owner
 * decision 2026-11-01): a record with a `personalOwner` is readable by that
 * member alone — **not by owners or admins either** (the one exception to
 * "owner/admin see everything"), nor department managers or delegates. For
 * everyone else it is a record that does not exist, through every caller of
 * this check (answers, counts, links, traversals, 「あなたの番」, the AI, undo).
 *
 * Members-only records (「この人たちだけ」, records.md "Members-only records", owner decision
 * 2026-11-04): the same rule for a list — readable by those on its list alone (an empty list:
 * nobody), owners, admins and department managers included. The list is written in a place
 * rule's subjects (owner direction 2026-11-08): people (`members`), groups and departments
 * (`memberSets`, who is in them read with the row), matched by `listIncludes` — the core's
 * `applicableRules`, the very matching `resolveAccess` uses, so there is one copy of it. Two
 * layers, one function: the record's own exception first, then the place's rules.
 */
import {
  canReadPrivateScope, findPrivateScope, listIncludes, resolveAccess, type ListSubject, type PermissionRepository, type ScopeWithRules,
} from '../../shared/core/permissions'
import type { RecordAccessRow } from '../ports/records'

type ListedRow = Pick<RecordAccessRow, 'members' | 'memberSets'>

/** A members-only row's list as subjects (people first, then its groups and departments); [] when it is not one. */
export function listSubjectsOf(row: ListedRow): ListSubject[] {
  if (row.members == null) return []
  return [
    ...row.members.map(id => ({ type: 'user' as const, id })),
    ...(row.memberSets ?? []).map(s => ({ type: s.type, id: s.id, memberIds: s.memberIds })),
  ]
}

/** Is the user on a members-only row's list (as a person, or in a group / department on it)? */
export function onList(row: ListedRow, userId: string): boolean {
  return row.members != null && listIncludes(listSubjectsOf(row), userId)
}

/**
 * Everyone a members-only row's list includes now (its people, then who is in its groups and
 * departments), each once; [] when it is not one. Not filtered by membership of the company:
 * callers that answer with people pass them through `recordReaders` or their member list.
 */
export function listedUserIds(row: ListedRow): string[] {
  const subjects = listSubjectsOf(row)
  const candidates = new Set(subjects.flatMap(s => (s.type === 'user' ? [s.id] : [...(s.memberIds ?? [])])))
  return [...candidates].filter(id => listIncludes(subjects, id))
}
import type { Member } from './access'

export interface RecordReader {
  record(row: RecordAccessRow): boolean
  /** A file of the company folder (a file link's target). */
  file(path: string): boolean
}

export function recordReader(member: Member, scopes: ScopeWithRules[]): RecordReader {
  const perms: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => scopes }
  const byId = new Map(scopes.map(s => [s.id, s]))
  const readable = (path: string) => resolveAccess(member.companyId, member.userId, path, perms).read
  const file = (path: string) => {
    const priv = findPrivateScope(scopes, path)
    if (priv && !canReadPrivateScope(priv, member.userId, member.role)) return false
    return readable(path)
  }
  return {
    record(r) {
      // Before every role or folder rule: an owner-only record is its owner's alone.
      if (r.personalOwner !== null) return r.personalOwner === member.userId
      // …and a members-only record its listed members' (`!= null`: a row built without the field is not one).
      if (r.members != null) return onList(r, member.userId)
      if (r.path === null) return r.scopeId === null && readable(r.folder ?? '')
      if (r.scopeId !== null) {
        const scope = byId.get(r.scopeId)
        // The folder is gone or no longer private: unreadable until the index catches up.
        if (!scope || scope.repoId === null) return false
        return canReadPrivateScope(scope, member.userId, member.role) && readable(r.path)
      }
      // A company-repository record is never inside a private folder (the path is reserved there).
      if (findPrivateScope(scopes, r.path)) return false
      return readable(r.path)
    },
    file,
  }
}

/**
 * Which of these members read the record now — `recordReader` per member, once
 * per call (an owner-only record: its owner alone, a members-only record: the listed among them,
 * without evaluating anyone).
 * For "who should hear of a change" (services/record-signal.ts).
 */
export function recordReaders(
  companyId: string, row: RecordAccessRow, members: Array<{ userId: string; role: string }>, scopes: ScopeWithRules[],
): string[] {
  if (row.personalOwner !== null) return members.some(m => m.userId === row.personalOwner) ? [row.personalOwner] : []
  if (row.members != null) return members.filter(m => onList(row, m.userId)).map(m => m.userId)
  return members.filter(m => recordReader({ companyId, userId: m.userId, role: m.role }, scopes).record(row)).map(m => m.userId)
}

/** May a link from `source` to `target` be shown or followed at all (for anyone)? */
export function linkAllowed(source: { scopeId: string | null }, target: { scopeId: string | null }): boolean {
  return target.scopeId === null || target.scopeId === source.scopeId
}
