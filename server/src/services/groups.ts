/**
 * 見える人のまとまり (groups, server.md "Groups", owner decisions 2026-11-07):
 * named sets of members, kept by owners and admins in the admin console, that
 * a permission rule may name (subject 'group', shared/core/permissions.ts) to
 * say who reads a read-restricted place of a company without the shared folder.
 *
 * - Owners/admins only, every endpoint (a member — a department manager too —
 *   gets 403 and learns no group name: nothing a member does needs one yet).
 * - A group holds exactly the members put in it: owners/admins are not added
 *   by themselves (they read every place anyway), no group inside a group.
 * - Deleting a group some rule names is refused (409 GROUP_IN_USE with the
 *   places, which the owner/admin may all read): dropping the rule silently
 *   would change who reads a place — narrower here, but a place's readers are
 *   changed in the place, on purpose, by its editor.
 * - Who is in a group changes who reads at once (rules carry the group id,
 *   members are read with the rules).
 * - Every change is recorded in permission_history (who, when, what).
 */
import type { MembershipRepository } from '../ports/memberships'
import type { CompanyDataSource } from '../ports/company-data'
import type { GroupRow } from '../ports/groups'
import type { Clock, IdGenerator } from '../ports/clock'
import type { Transactions } from '../ports/transactions'
import { nameKey } from '../../shared/core/paths'
import type { MemberGroup } from '../../shared/types/groups'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const GROUPS_FORBIDDEN = 'Only owners and admins can manage groups'
export const MAX_GROUPS = 200
export const MAX_GROUP_MEMBERS = 1000
export const MAX_GROUP_NAME = 40

/** The contract (shared/types/groups.ts). */
export type GroupView = MemberGroup

export interface GroupDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

/** A group's name: trimmed, NFC, 1–40 characters, no control characters. */
export function parseGroupName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.normalize('NFC').trim()
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > MAX_GROUP_NAME || /[\u0000-\u001f\u007f]/.test(name)) return null
  return name
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function createGroupService(deps: GroupDeps) {
  const { companyData, memberships, transactions, clock, ids } = deps
  const groupsOf = (companyId: string) => companyData.forCompany(companyId).groups
  const historyOf = (companyId: string) => companyData.forCompany(companyId).permissionHistory

  const view = (companyId: string, g: GroupRow): GroupView => ({
    id: g.id, name: g.name, memberIds: g.memberIds, usedIn: groupsOf(companyId).rulePaths(g.id), createdAt: g.createdAt,
  })

  /** Unique ids, each a member of the company; else a refusal. */
  function parseMembers(companyId: string, value: unknown): Outcome<string[]> {
    if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
      return refuse('bad-request', 'userIds must be an array of user IDs')
    }
    const unique = [...new Set(value as string[])]
    if (unique.length > MAX_GROUP_MEMBERS) return refuse('bad-request', `A group can have at most ${MAX_GROUP_MEMBERS} members`)
    const current = new Set(memberships.listByCompany(companyId).map(m => m.user_id))
    if (unique.some(id => !current.has(id))) return refuse('bad-request', 'Every user must be a member of this company', { code: 'BAD_MEMBER' })
    return ok(unique)
  }

  const nameTaken = () => refuse('conflict', '同じ名前のまとまりがもうあります。別の名前にしてください。', { code: 'GROUP_NAME_TAKEN' })
  const badName = () => refuse('bad-request', `名前は1〜${MAX_GROUP_NAME}文字で入れてください。`, { code: 'BAD_GROUP_NAME' })
  const notFound = () => refuse('not-found', 'Group not found')

  return {
    list(member: Member): Outcome<GroupView[]> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', GROUPS_FORBIDDEN)
      return ok(groupsOf(member.companyId).list().map(g => view(member.companyId, g)))
    },

    create(member: Member, body: unknown): Outcome<GroupView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', GROUPS_FORBIDDEN)
      if (!isObject(body)) return refuse('bad-request', 'Invalid JSON body')
      const name = parseGroupName(body.name)
      if (name === null) return badName()
      const members = body.userIds === undefined ? ok<string[]>([]) : parseMembers(member.companyId, body.userIds)
      if (!members.ok) return members
      const groups = groupsOf(member.companyId)
      return transactions.run(() => {
        if (groups.list().length >= MAX_GROUPS) return refuse('bad-request', `At most ${MAX_GROUPS} groups per company`)
        if (groups.nameTaken(nameKey(name))) return nameTaken()
        const id = ids.newId()
        const at = clock.now()
        groups.create({ id, name, nameKey: nameKey(name), createdAt: at, createdBy: member.userId })
        if (members.value.length > 0) groups.replaceMembers(id, members.value, member.userId, at)
        historyOf(member.companyId).append({ action: 'group-create', detail: { groupId: id, name, memberIds: members.value }, at, byUser: member.userId })
        return ok(view(member.companyId, groups.find(id)!))
      })
    },

    rename(member: Member, groupId: string, body: unknown): Outcome<GroupView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', GROUPS_FORBIDDEN)
      const groups = groupsOf(member.companyId)
      const existing = groups.find(groupId)
      if (!existing) return notFound()
      if (!isObject(body)) return refuse('bad-request', 'Invalid JSON body')
      const name = parseGroupName(body.name)
      if (name === null) return badName()
      return transactions.run(() => {
        if (groups.nameTaken(nameKey(name), groupId)) return nameTaken()
        groups.rename(groupId, name, nameKey(name))
        historyOf(member.companyId).append({ action: 'group-rename', detail: { groupId, before: existing.name, after: name }, at: clock.now(), byUser: member.userId })
        return ok(view(member.companyId, groups.find(groupId)!))
      })
    },

    setMembers(member: Member, groupId: string, body: unknown): Outcome<GroupView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', GROUPS_FORBIDDEN)
      const groups = groupsOf(member.companyId)
      const existing = groups.find(groupId)
      if (!existing) return notFound()
      if (!isObject(body)) return refuse('bad-request', 'Invalid JSON body')
      const members = parseMembers(member.companyId, body.userIds)
      if (!members.ok) return members
      return transactions.run(() => {
        const at = clock.now()
        groups.replaceMembers(groupId, members.value, member.userId, at)
        historyOf(member.companyId).append({
          action: 'group-members', detail: { groupId, before: existing.memberIds, after: members.value }, at, byUser: member.userId,
        })
        return ok(view(member.companyId, groups.find(groupId)!))
      })
    },

    delete(member: Member, groupId: string): Outcome<{ deleted: true }> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', GROUPS_FORBIDDEN)
      const groups = groupsOf(member.companyId)
      return transactions.run(() => {
        const existing = groups.find(groupId)
        if (!existing) return notFound()
        const usedIn = groups.rulePaths(groupId)
        if (usedIn.length > 0) {
          return refuse('conflict', 'このまとまりは見られる人の設定で使われています。先にその場所の設定から外してください。', {
            code: 'GROUP_IN_USE', places: usedIn,
          })
        }
        groups.delete(groupId)
        historyOf(member.companyId).append({
          action: 'group-delete', detail: { groupId, name: existing.name, memberIds: existing.memberIds }, at: clock.now(), byUser: member.userId,
        })
        return ok({ deleted: true as const })
      })
    },
  }
}

export type GroupService = ReturnType<typeof createGroupService>
