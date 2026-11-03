/**
 * 見られる人 (who can see a record or a file), in the members' words — one copy
 * of the rule for the server (`POST …/viewers`) and anything that shows it
 * (plan「新しい画面のデモ」K サーバー乙 ②, words: 「言葉の決まり」5b).
 *
 * The phrase, first that fits:
 * - 「あなただけ」 — an owner-only record (持ち主だけ), or nobody but the asker can see it;
 * - 「あなたと〇〇さん」 — the asker and one other person;
 * - 「会社のみんな」 — every member of the company;
 * - 「『<folder>』を見られる人（N人）」 — inside a private folder. The caller must only build it for
 *   someone who can read that folder (owner decision B: a private folder's name never reaches
 *   anyone else; the server answers nothing at all about an unreadable one);
 * - 「〇〇部のみんな」 — exactly the people who belong to the department that holds it (owners and
 *   admins, who see everything, left out of the comparison);
 * - 「N人が見られます」 — anything else.
 *
 * Never 「公開」「権限」「スコープ」. Pure: imports nothing outside shared/core.
 */

export type ViewersKind = 'only-you' | 'you-and-one' | 'company' | 'private-folder' | 'department' | 'people'

export interface ViewersLabel {
  kind: ViewersKind
  /** The phrase to show (with the eye mark; 「あなただけ」 with the lock). */
  text: string
  /** How many people can see it (owners and admins included; 1 for 「あなただけ」). */
  count: number
}

export interface ViewersInput {
  /** The member asking (always one of `readers`). */
  viewerId: string
  /** Everyone of the company who can read it. */
  readers: readonly string[]
  /** An owner-only record (its owner alone reads it, owners and admins neither). */
  ownerOnly: boolean
  /** How many members the company has. */
  companyMembers: number
  /** The private folder it is in (its path), or null. Only for someone who reads that folder. */
  privateFolder: string | null
  /** The department whose folder holds it, with who belongs to it; null outside a department. */
  department: { name: string; memberIds: readonly string[] } | null
  /** Owners and admins (they read everything, so they do not make a department's 「みんな」 different). */
  fullAccess: ReadonlySet<string>
  /** A member's display name (「阿部」). */
  nameOf(userId: string): string
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(x => b.has(x))

export function viewersLabel(input: ViewersInput): ViewersLabel {
  const readers = new Set(input.readers)
  readers.add(input.viewerId)
  if (input.ownerOnly || readers.size === 1) return { kind: 'only-you', text: 'あなただけ', count: 1 }
  if (readers.size === 2) {
    const other = [...readers].find(id => id !== input.viewerId)!
    return { kind: 'you-and-one', text: `あなたと${input.nameOf(other)}さん`, count: 2 }
  }
  if (readers.size >= input.companyMembers) return { kind: 'company', text: '会社のみんな', count: readers.size }
  if (input.privateFolder !== null) {
    return { kind: 'private-folder', text: `『${input.privateFolder}』を見られる人（${readers.size}人）`, count: readers.size }
  }
  if (input.department) {
    const belong = new Set(input.department.memberIds.filter(id => !input.fullAccess.has(id)))
    const others = new Set([...readers].filter(id => !input.fullAccess.has(id)))
    if (belong.size > 0 && sameSet(belong, others)) {
      return { kind: 'department', text: `${input.department.name}のみんな`, count: readers.size }
    }
  }
  return { kind: 'people', text: `${readers.size}人が見られます`, count: readers.size }
}

/** At most this many records and this many files in one request. */
export const VIEWERS_LIMITS = Object.freeze({ records: 200, files: 200 })
