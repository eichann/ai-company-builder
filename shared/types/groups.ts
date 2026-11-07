/**
 * 見える人のまとまり (groups, server.md "Groups"): the API contract of
 * GET|POST /api/companies/:companyId/groups, PATCH|DELETE …/groups/:groupId and
 * PUT …/groups/:groupId/members (owners and admins only).
 */
export interface MemberGroup {
  id: string
  name: string
  /** Member user ids, oldest first. A group holds exactly these (owners/admins are not added by themselves). */
  memberIds: string[]
  /** Paths of the places whose rules name the group ('' never: the company itself cannot be restricted). */
  usedIn: string[]
  createdAt: string
}

export interface MemberGroupsView {
  groups: MemberGroup[]
}

/** 409 GROUP_IN_USE: the group cannot be deleted while these places name it. */
export interface GroupInUseBody {
  error: string
  code: 'GROUP_IN_USE'
  places: string[]
}
