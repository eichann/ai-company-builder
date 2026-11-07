/**
 * A task and the 案件・プロジェクト it belongs to (records.md "A task and its 案件・プロジェクト",
 * owner decision 2026-11-06): no new kind of permission — a task is seen by the readers of its own
 * place (company, a department, a private folder, owner-only, members-only), and when it belongs to
 * a まとまり (`bundle` link) it is **never seen by more people than the まとまり**.
 *
 * "Wider" is the existing reader evaluation (`recordReader`): the task is within the まとまり when
 * every member who reads the task also reads the まとまり. An owner-only task is never wider (the
 * owner wants personal tasks linkable to a project). Rather than walk every membership, it asks a
 * set of representatives that covers every distinct answer the readers can give: everyone a rule,
 * a department or group rule or either record's list names, plus one plain member and one owner/admin that
 * nothing names (any other member reads exactly what one of those two reads).
 */
import type { ScopeWithRules } from '../../../shared/core/permissions'
import type { TypeDefinition } from '../../../shared/core/record-types'
import type { RecordAccessRow, RecordLinkRow, RecordRepository } from '../../ports/records'
import { listedUserIds, recordReader } from '../record-access'
import { currentTypes } from '../record-index'

/** The types whose place follows their まとまり (the core's やること). */
export const BUNDLE_PLACED_TYPES: readonly string[] = ['task']

/** A task's place that is wider than its まとまり's (400; names no place, so no private name leaks). */
export const WIDER_THAN_BUNDLE = {
  error: 'このやることは、つなぐ先より多くの人に見えています。つなぐ先と同じ人たちだけに見えるようにしてから、つないでください',
  code: 'WIDER_THAN_BUNDLE',
} as const

/** Someone the task names (担当・頼んだ人・確かめる人…) would no longer see it in the narrower place. */
export const NAMED_PERSON_CANNOT_READ = {
  error: 'このやることにかかわる人（担当・頼んだ人・確かめる人など）が、つなぐ先を見られません。その人が見られるようにしてから、もう一度つないでください',
  code: 'NAMED_PERSON_CANNOT_READ',
} as const

/** Ids no member has: the plain member and the owner/admin nothing names. */
const NOBODY_MEMBER = '\u0000any-member'
const NOBODY_ADMIN = '\u0000any-admin'

type Place = Pick<RecordAccessRow, 'id' | 'type' | 'scopeId' | 'path' | 'folder' | 'personalOwner' | 'members' | 'memberSets'>

/**
 * Is every member who reads `task` also a reader of `bundle`? `roleOf` is the company's role of a
 * member (null = not a member: left out).
 */
export function placeWithin(
  companyId: string, scopes: ScopeWithRules[], roleOf: (userId: string) => string | null, task: Place, bundle: Place,
): boolean {
  if (task.personalOwner !== null) return true
  const named = new Set<string>()
  for (const s of scopes) {
    for (const r of s.rules) {
      if (r.subjectType === 'user' && r.subjectId) named.add(r.subjectId)
      if (r.subjectType === 'department' || r.subjectType === 'group') for (const id of r.memberIds ?? []) named.add(id)
    }
  }
  for (const id of [...listedUserIds(task), ...listedUserIds(bundle), bundle.personalOwner]) if (id) named.add(id)
  const people: Array<{ userId: string; role: string }> = [
    { userId: NOBODY_MEMBER, role: 'member' },
    { userId: NOBODY_ADMIN, role: 'admin' },
  ]
  for (const id of named) {
    const role = roleOf(id)
    if (role !== null) people.push({ userId: id, role })
  }
  return people.every(p => {
    const reader = recordReader({ companyId, userId: p.userId, role: p.role }, scopes)
    return !reader.record(task) || reader.record(bundle)
  })
}

/** The name of the type's link to a まとまり (an `interface: bundle` link), or null. */
export function bundleLinkName(def: TypeDefinition): string | null {
  const found = Object.entries(def.links).find(([, l]) => l.targetIsInterface && l.target === 'bundle')
  return found ? found[0] : null
}

/** The live まとまり a record's links name (the first readable one), or null. */
export function linkedBundle(
  records: RecordRepository, def: TypeDefinition, links: readonly Pick<RecordLinkRow, 'name' | 'targetId'>[], readable: (r: RecordAccessRow) => boolean,
): RecordAccessRow | null {
  const name = bundleLinkName(def)
  if (!name) return null
  const ids = links.filter(l => l.name === name && l.targetId !== null).map(l => l.targetId as string)
  if (ids.length === 0) return null
  const types = currentTypes(records)
  return records.byIds(ids).find(r => r.removedAt === null && readable(r) && types.get(r.type)?.definition.implements.includes('bundle')) ?? null
}
