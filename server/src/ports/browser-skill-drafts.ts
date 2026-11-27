/**
 * One company's drafts of a company Skill made from recordings (agent-browser.md "A Skill's draft from a recording") —
 * from its handle (`CompanyData`), every method limited to that company **and to one author**: there is no method that
 * reads or changes another person's draft. Rows past their `deleteAt` are never returned (`now` given by the service).
 * Rules: services/browser-skill-drafts.ts.
 */
export interface BrowserSkillDraftRow {
  id: string
  userId: string
  name: string
  domain: string
  /** JSON list of the recordings' ids, in the order the draft was made from them. */
  recordingIds: string
  baseDeclaration: string
  /** JSON of what the rule said about the base: each write's marks and the writes left out. */
  baseNotes: string
  declaration: string
  steps: string
  version: string
  triedVersion: string | null
  createdAt: string
  updatedAt: string
  deleteAt: string
}

export type BrowserSkillDraftChange = Pick<BrowserSkillDraftRow, 'name' | 'declaration' | 'steps' | 'version' | 'updatedAt' | 'deleteAt'>

export interface BrowserSkillDraftRepository {
  insert(row: BrowserSkillDraftRow): void
  /** The author's draft, unless past its `deleteAt` at `now` or made before `since` (the author's current membership). */
  byId(userId: string, id: string, now: string, since: string): BrowserSkillDraftRow | null
  /** The author's drafts, newest change first, not past `deleteAt`, made at or after `since`. */
  list(userId: string, now: string, since: string): BrowserSkillDraftRow[]
  /** How many of the author's drafts count now (as `list`). */
  countOf(userId: string, now: string, since: string): number
  /** Another draft of this author already has the name (as `list`). */
  nameTaken(userId: string, name: string, now: string, since: string, except: string | null): boolean
  /** Compare-and-set on the version: true when the author's row still had `expectedVersion` and is changed now. */
  change(userId: string, id: string, expectedVersion: string, to: BrowserSkillDraftChange): boolean
  /** True when the author's row was there (and is gone now). */
  delete(userId: string, id: string): boolean
  /** Every row whose `deleteAt` is at or before `now` is deleted; how many. */
  deleteExpired(now: string): number
}
