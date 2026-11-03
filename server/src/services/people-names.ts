/**
 * The names behind the person ids in what the member's AI reads (`records.md` "Typed tools in
 * the app", staging FB 9): record answers name people by member id only (person fields,
 * `requested_by`, the ledger's actors, `actingFor`), and the AI told the member 「名前は出ていません」.
 * The AI-facing answers get a `people` map (id → display name) next to the ids, which the tools
 * keep using.
 *
 * Only members of the caller's own company are named — the people their company's member list
 * already shows them (`GET /companies/:id/members`). An id of anyone else (a removed member,
 * another company's account, a string that only looks like an id) gets no entry, so nothing about
 * an account outside the company is revealed. An account without a display name gets none either
 * (the email is never offered instead).
 */
import type { AccountDirectory } from '../ports/accounts'
import type { MembershipRepository } from '../ports/memberships'
import type { Member } from './access'

/** How deep and how many strings an answer is searched (a query answer is ≤ 200 records). */
const MAX_DEPTH = 8
const MAX_STRINGS = 20_000

export interface PeopleNames {
  /** The display names of the caller's company members whose ids appear as values anywhere in `value`. */
  namesIn(member: Member, value: unknown): Record<string, string>
  /** `value` with `people` added when it names anyone (an object answer; anything else unchanged). */
  withPeople<T>(member: Member, value: T): T | (T & { people: Record<string, string> })
}

export function createPeopleNames(deps: { memberships: MembershipRepository; accounts: AccountDirectory }): PeopleNames {
  function namesIn(member: Member, value: unknown): Record<string, string> {
    const members = new Set(deps.memberships.listByCompany(member.companyId).map(m => m.user_id))
    const found = new Set<string>()
    let seen = 0
    const walk = (v: unknown, depth: number) => {
      if (seen > MAX_STRINGS) return
      if (typeof v === 'string') {
        seen++
        if (members.has(v)) found.add(v)
        return
      }
      if (!v || typeof v !== 'object' || depth >= MAX_DEPTH) return
      for (const item of Array.isArray(v) ? v : Object.values(v)) walk(item, depth + 1)
    }
    walk(value, 0)
    if (found.size === 0) return {}
    const accounts = deps.accounts.byIds([...found])
    const people: Record<string, string> = {}
    for (const id of [...found].sort()) {
      const name = accounts.get(id)?.name?.trim()
      if (name) people[id] = name
    }
    return people
  }

  return {
    namesIn,
    withPeople(member, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const people = namesIn(member, value)
      // First: the app cuts a long tool answer at its end, and the names must survive that.
      return Object.keys(people).length > 0 ? { people, ...value } : value
    },
  }
}
