// 「見られる人」 of a place in a company without the shared folder (server.md "Groups and
// read-restricted places"): a department, or a place inside one (人事部 › 採用), is read by
// everyone or by chosen people, departments (the people who belong to them) and groups
// (見える人のまとまり). Owners and admins always read everything.
//
// The server stores it as rules (PUT /permissions/scopes/by-path): `everyone` denies read and
// each chosen subject reads. Only who reads is chosen here; who may place / change records
// (the rules' canWrite) is kept as it was for everyone who still reads.
import type { PermissionRule, RuleInput } from './api'

export type Reader =
  | { subjectType: 'user'; subjectId: string }
  | { subjectType: 'department'; subjectId: string }
  | { subjectType: 'group'; subjectId: string }

export interface ReadersDraft {
  /** 'everyone': the whole company (a place inside a department: the same as the department). */
  mode: 'everyone' | 'chosen'
  readers: Reader[]
}

const READER_TYPES = new Set(['user', 'department', 'group'])

export const readerKey = (r: { subjectType: string; subjectId: string | null }) => `${r.subjectType}:${r.subjectId ?? ''}`

/** Does this rule set restrict who reads (its everyone rule denies read)? */
export function isRestricted(rules: readonly Pick<PermissionRule, 'subjectType' | 'canRead'>[]): boolean {
  return rules.some((r) => r.subjectType === 'everyone' && !r.canRead)
}

/** The choice a place's own rules make. */
export function readersOf(rules: readonly PermissionRule[]): ReadersDraft {
  if (!isRestricted(rules)) return { mode: 'everyone', readers: [] }
  return {
    mode: 'chosen',
    readers: rules
      .filter((r) => READER_TYPES.has(r.subjectType) && r.subjectId && r.canRead)
      .map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId! }) as Reader),
  }
}

export function sameReaders(a: ReadersDraft, b: ReadersDraft): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === 'everyone') return true
  const keys = new Set(a.readers.map(readerKey))
  return a.readers.length === b.readers.length && b.readers.every((r) => keys.has(readerKey(r)))
}

const subjectOf = (r: PermissionRule) => ({ subjectType: r.subjectType, subjectId: r.subjectId }) as RuleInput

/**
 * The rule set to save for `draft`.
 * - `own`: the place's own rules ([] = it follows the place above);
 * - `inherited`: the rules it follows when it has none of its own;
 * - `department`: a department (全員 keeps its own rules, opened to everyone) rather than a place
 *   inside one (全員 = 部署と同じ: no rules of its own).
 *
 * 選んだ人だけ: everyone neither reads nor writes; each reader reads, and writes when its rule did
 * (a reader without a rule writes when everyone did). Role rules go (they would let every member
 * read). 全員 for a department: everyone reads (writing as its everyone rule said, never more than
 * before); user / department / role rules stay (they say who writes), groups go (they only chose
 * readers).
 */
export function rulesForReaders(
  draft: ReadersDraft,
  own: readonly PermissionRule[],
  inherited: readonly PermissionRule[],
  department: boolean
): RuleInput[] {
  const base = own.length > 0 ? own : inherited
  const everyone = base.find((r) => r.subjectType === 'everyone')
  if (draft.mode === 'everyone') {
    if (!department || own.length === 0) return []
    return [
      { subjectType: 'everyone', subjectId: null, canRead: true, canWrite: everyone?.canRead === true && everyone.canWrite },
      ...own
        .filter((r) => r.subjectType === 'user' || r.subjectType === 'department' || r.subjectType === 'role')
        .map((r) => ({ ...subjectOf(r), canRead: true, canWrite: r.canWrite })),
    ]
  }
  const everyoneWrites = everyone?.canRead === true && everyone.canWrite
  return [
    { subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false },
    ...draft.readers.map((reader) => {
      const was = base.find((r) => readerKey(r) === readerKey(reader))
      return { ...reader, canRead: true, canWrite: was ? was.canRead && was.canWrite : everyoneWrites }
    }),
  ]
}

/** 「人事部 › 採用」 */
export const placeName = (path: string) => path.split('/').join(' › ')

/**
 * A new place's name (one level, inside a department): trimmed; no "/" or "\", no control
 * characters, not starting with "."; 1–40 characters. null when it cannot be used.
 */
export function parsePlaceName(raw: string): string | null {
  const name = raw.normalize('NFC').trim()
  if (name.length === 0 || name.length > 40 || /[/\\\u0000-\u001f\u007f]/.test(name) || name.startsWith('.')) return null
  return name
}
