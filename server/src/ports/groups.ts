/**
 * 見える人のまとまり (groups, server.md "Groups"): named sets of members of one
 * company, behind its handle (`CompanyData.groups`; adapters/sqlite/groups.ts).
 * Every method is limited to that company: another company's group id is not
 * found and nothing of it changes. A rule names a group by id (subject
 * 'group'); who is in it is read with the rules (shared/core/permissions.ts).
 */
export interface GroupRow {
  id: string
  name: string
  /** Member user ids, oldest first. */
  memberIds: string[]
  createdAt: string
}

export interface GroupRepository {
  /** Every group of the company, by name. */
  list(): GroupRow[]
  find(groupId: string): GroupRow | null
  /** Is the name (as nameKey: NFC + A–Z folded) taken by another group than `exceptId`? */
  nameTaken(nameKey: string, exceptId?: string): boolean
  create(group: { id: string; name: string; nameKey: string; createdAt: string; createdBy: string }): void
  rename(groupId: string, name: string, nameKey: string): void
  /** Remove the group and who is in it. The caller makes sure no rule names it. */
  delete(groupId: string): void
  /** Replace who is in the group (kept rows keep added_at / added_by). */
  replaceMembers(groupId: string, userIds: string[], addedBy: string, at: string): void
  /** The paths of the places whose rules name the group (sorted parents first). */
  rulePaths(groupId: string): string[]
  /** The member left the company: they are in no group of it any more. */
  forgetMember(userId: string): void
}

/** One entry of who changed groups or permission rules (append-only). */
export interface PermissionHistoryEntry {
  action:
    | 'group-create' | 'group-rename' | 'group-delete' | 'group-members'
    | 'rules-replace' | 'rule-set' | 'rule-update' | 'rule-delete' | 'rules-clear' | 'rules-move'
    /** Who belongs to a department (所属): a department rule's readers / writers follow it. */
    | 'department-members'
    /** Who reads / edits a private folder (its viewers and editors). */
    | 'private-folder-members'
    /** A department deleted: with it went who belonged (所属) and the rules naming it. */
    | 'department-delete'
    /** A private folder made, with its first viewers and editors. */
    | 'private-folder-create'
    /** A members-only record's list changed by a person (records.md "Members-only records"): who / which groups and departments. */
    | 'record-members'
  /**
   * What changed, as JSON-able data (ids, names, a place's path, rules before / after; for a
   * group's or a department's members `before` / `after` ids and, when not an edit of the list
   * itself, `via`: 'invitation' | 'left-company').
   */
  detail: Record<string, unknown>
  at: string
  byUser: string
}

export interface PermissionHistoryRepository {
  append(entry: PermissionHistoryEntry): void
  /** Newest first (tests and a later page). */
  recent(limit: number): Array<PermissionHistoryEntry & { seq: number }>
}
