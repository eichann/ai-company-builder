/**
 * A record and the parent it follows (records.md "Following the parent's 見える範囲", "A task and its
 * 案件・プロジェクト", owner decisions 2026-11-06 / 2026-11-23): no new kind of permission — a record is seen
 * by the readers of its own place (company, a department, a private folder, owner-only, members-only),
 * and when its type declares `place_follows: <link>` and that link names a parent, it is **never seen by
 * more people than the parent**. The core's やること follows its まとまり (`place_follows: bundle`, task
 * version 14); a business plugin's type may follow its own parent (a 収録 its 番組).
 *
 * "Wider" is the existing reader evaluation (`recordReader`): the record is within the parent when
 * every member who reads the record also reads the parent. An owner-only record is never wider (the
 * owner wants personal tasks linkable to a project). Rather than walk every membership, it asks a
 * set of representatives that covers every distinct answer the readers can give: everyone a rule,
 * a department or group rule or either record's list names, plus one plain member and one owner/admin that
 * nothing names (any other member reads exactly what one of those two reads).
 */
import { coreTypeDefinitions } from '../../../shared/core/core-types'
import type { ScopeWithRules } from '../../../shared/core/permissions'
import { INTERFACES, type LinkDef, type TypeDefinition } from '../../../shared/core/record-types'
import type { RecordAccessRow, RecordLinkRow, RecordRepository } from '../../ports/records'
import { listedUserIds, recordReader } from '../record-access'
import { currentTypes } from '../record-index'

/** A record's place that is wider than its parent's (400; names no place, so no private name leaks). The task's words; `followWords` for other types. */
export const WIDER_THAN_BUNDLE = {
  error: 'このやることは、つなぐ先より多くの人に見えています。つなぐ先と同じ人たちだけに見えるようにしてから、つないでください',
  code: 'WIDER_THAN_BUNDLE',
} as const

/**
 * 「部署に出す」 / 「招待する」 that would make a linked task wider than its まとまり (400, the same code; words
 * for those actions, naming no place, title or person).
 */
export const SHARE_WIDER_THAN_BUNDLE = {
  error: 'このやることがつながっている先を見られない人にまで見えてしまうため、そこには出せません。つながっている先と同じ人たちに見える場所を選んでください',
  code: WIDER_THAN_BUNDLE.code,
} as const
export const INVITE_WIDER_THAN_BUNDLE = {
  error: '足そうとした人の中に、このやることがつながっている先を見られない人がいるため、足せません。つながっている先を見られる人だけを足してください',
  code: WIDER_THAN_BUNDLE.code,
} as const

/** Someone the record names (担当・頼んだ人・確かめる人…) would no longer see it in the narrower place. */
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

/**
 * A parent that is owner-only or members-only, for a type that cannot be (a business plugin's: other
 * records take their readers from it). 400; names no place, title or person.
 */
export const PLACE_NOT_FOR_TYPE = {
  error: 'つなぐ先は限られた人だけに見えるものなので、この種類の記録はそこにつなげません。会社や部署に見えているものにつないでください',
  code: 'PLACE_NOT_FOR_TYPE',
} as const

/** The refusal in words for `type`: the task's say やること, any other type's say 記録. */
export function followWords<T extends { error: string; code: string }>(type: string, refusal: T): T {
  return type === 'task' ? refusal : { ...refusal, error: refusal.error.replace('このやること', 'この記録') }
}

let corePlaceFollows: ReadonlyMap<string, string> | null = null
/** What each core type declares (task: `bundle`), so a company's extension in force cannot drop it. */
function coreFollowOf(type: string): string | undefined {
  corePlaceFollows ??= new Map(coreTypeDefinitions().filter(d => d.placeFollows).map(d => [d.name, d.placeFollows as string]))
  return corePlaceFollows.get(type)
}

/**
 * The link through which a record of this type follows its parent's 見える範囲 (`place_follows`), or
 * null. A core type keeps its core declaration even when the definition in force (a company's own
 * extension stored before the declaration) lacks it — never quietly wider. Only a record link of
 * cardinality one counts (the parser's rule, asked again of what is in force).
 */
export function followLinkName(def: TypeDefinition): string | null {
  const name = def.placeFollows ?? coreFollowOf(def.name)
  if (!name || !Object.prototype.hasOwnProperty.call(def.links, name)) return null
  const l = def.links[name]
  return l.target !== 'file' && l.cardinality === 'one' ? name : null
}

/** Is `row` a live record the link may hold as a parent (of its type, or implementing its interface)? */
function parentFits(types: ReturnType<typeof currentTypes>, link: LinkDef, row: { type: string; removedAt: string | null }): boolean {
  if (row.removedAt !== null) return false
  return link.targetIsInterface ? types.get(row.type)?.definition.implements.includes(link.target) === true : row.type === link.target
}

/**
 * The targets of the follow link a create may not hold: not a live record of the link's type (or
 * interface), or one the creator cannot read — one answer for all of them (`followLinkRefusal`).
 */
export function followLinkMisses(records: RecordRepository, link: LinkDef, targets: string[], readable: (r: RecordAccessRow) => boolean): string[] {
  if (targets.length === 0) return []
  const types = currentTypes(records)
  const fit = new Set(records.byIds(targets).filter(r => parentFits(types, link, r) && readable(r)).map(r => r.id))
  return targets.filter(t => !fit.has(t))
}

/** One answer whether the parent does not exist, cannot be read or is of another kind (nothing about it leaks). */
export function followLinkRefusal(records: RecordRepository, name: string, link: LinkDef) {
  const label = link.targetIsInterface ? (INTERFACES[link.target]?.label ?? link.target) : (currentTypes(records).get(link.target)?.definition.label ?? link.target)
  return { error: `つながり「${link.label}」には、あなたが見られる「${label}」の記録だけをつなげます`, code: 'BAD_LINK', link: name }
}

/**
 * Every live parent a record's follow link names, whoever reads them: the invariant holds for a parent
 * the acting member no longer reads too (its readers are still the bound).
 */
export function linkedParents(
  records: RecordRepository, def: TypeDefinition, links: readonly Pick<RecordLinkRow, 'name' | 'targetId'>[],
): RecordAccessRow[] {
  const name = followLinkName(def)
  if (!name) return []
  const ids = links.filter(l => l.name === name && l.targetId !== null).map(l => l.targetId as string)
  if (ids.length === 0) return []
  const types = currentTypes(records)
  return records.byIds(ids).filter(r => parentFits(types, def.links[name], r))
}

/** The live parent a record's follow link names (the first readable one), or null. */
export function linkedParent(
  records: RecordRepository, def: TypeDefinition, links: readonly Pick<RecordLinkRow, 'name' | 'targetId'>[], readable: (r: RecordAccessRow) => boolean,
): RecordAccessRow | null {
  return linkedParents(records, def, links).find(readable) ?? null
}
