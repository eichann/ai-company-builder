/**
 * Permission model (Phase 1: data model + read APIs; nothing is enforced yet).
 *
 * A *scope* is a node a rule can attach to: the whole company (path ''), a
 * department folder, or any other folder inside the company repository. A
 * *rule* on a scope grants read and/or write to a subject: everyone in the
 * company, a role (owner / admin / member), the people who belong to one
 * department (所属, department_members), the members of one group (見える人の
 * まとまり, member_groups), or one user.
 *
 *   scopes        (company_id, path)  kind company | department | folder
 *   scope_rules   (scope_id, subject_type, subject_id, can_read, can_write)
 *
 * Effective access for (user, path) — resolveAccess():
 *
 *   1. owner / admin always read + write everywhere (reason 'role').
 *   2. Otherwise take the DEEPEST scope whose path is `path` or an ancestor of
 *      it AND that has at least one rule. Scopes without rules are transparent:
 *      they inherit from their parent. (Every company is seeded with
 *      `everyone: read + write` on the company scope, which reproduces the
 *      original fully-open behaviour.)
 *   3. Evaluate only that scope's rules, by precedence:
 *        user rules for this user  >  department rules of a department the
 *        user belongs to AND group rules of a group the user is in (one
 *        level, unioned)  >  role rules for the user's role  >  everyone
 *      The most specific level that has at least one matching rule decides;
 *      several matching rules of that level are unioned. So a user rule can
 *      narrow (or widen) what `everyone` gets on the same scope, and a
 *      department or group rule gives the people in it more (or less) than
 *      everyone else. Groups share the department's level instead of sitting
 *      above it: both are "a set of people", and putting someone into a group
 *      never takes away what their department gives them on the same place;
 *      narrowing one person stays a user rule (groups PR, 2026-11-07).
 *
 * A department rule names the department (subjectId = department id); who
 * belongs is not stored on the rule but resolved when the rules are read
 * (`memberIds`, filled by the permission store from department_members). So
 * the rule always means "whoever belongs now": changing who belongs changes
 * who it grants, and nothing can drift. A department rule without `memberIds`
 * matches nobody. A new department (POST /departments) starts with
 * `everyone: read` + `department: read + write` (server/src/services/departments.ts).
 * A group rule works the same way: subjectId = group id, `memberIds` = the
 * group's members now (member_group_members), absent = nobody. A group holds
 * exactly the members put in it (owners/admins are not added by themselves —
 * they read everything anyway) and never another group.
 *   4. If nothing there grants anything, deny (reason 'no-rule').
 *   5. Gates (narrow only): a PRIVATE folder (`repoId`) and a READ-RESTRICTED
 *      place (`readRestricted`, a company without the shared folder) gate
 *      everything inside them: read/write at a deeper path also needs read of
 *      every gate at or above it, so a rule deeper inside can narrow, never
 *      widen.
 *
 * Being a department manager (department_managers) grants NO file access in
 * Phase 1: management rights (who may edit a department's rules — Phase 2) are
 * deliberately separate from data rights. A manager reads and writes exactly
 * what the rules give them.
 *
 * This module is pure (shared/core: no Node, database, Hono or git): data
 * comes in through PermissionRepository (server/src/lib/permission-store.ts
 * is the SQLite implementation). The API, the push checker and the desktop
 * app evaluate access with this one copy.
 */
import { compareScopePaths, isSameOrAncestorPath, normalizeRepoPath } from './paths'
import type { WriteAccessScope } from './write-access'

export type ScopeKind = 'company' | 'department' | 'folder'
export type SubjectType = 'everyone' | 'role' | 'department' | 'group' | 'user'

export interface ScopeRule {
  id: string
  subjectType: SubjectType
  /** Role name for 'role', department id for 'department', group id for 'group', user id for 'user', null for 'everyone'. */
  subjectId: string | null
  canRead: boolean
  canWrite: boolean
  /**
   * 'department' / 'group' only: the user ids that belong to the department
   * (所属, department_members) or are in the group (member_group_members),
   * resolved when the rules are read. Absent = nobody.
   */
  memberIds?: readonly string[]
}

export interface ScopeWithRules {
  id: string
  path: string
  kind: ScopeKind
  departmentId: string | null
  /**
   * null = lives in the company's main repository. Set = a PRIVATE folder:
   * its own scope repository (server/src/lib/private-folders.ts), served only to members
   * who may read this scope; the path is reserved in the main repository.
   */
  repoId: string | null
  /**
   * A read-restricted place of a company WITHOUT the shared folder (no
   * repository: places are scope rows only, and read restriction decides who
   * sees the records placed there). Filled by the permission store: true only
   * for such a company's scope whose `everyone` rule denies read — never for a
   * company with the shared folder (there read restriction is private folders
   * only). Like a private folder it gates everything inside it (resolveAccess
   * step 5), and its name is not shown to who cannot read it. Absent = false.
   */
  readRestricted?: boolean
  rules: ScopeRule[]
}

export interface PermissionRepository {
  /** The user's role in the company, or null when they are not a member. */
  getMemberRole(companyId: string, userId: string): string | null
  /** Every scope of the company with its rules. */
  listScopes(companyId: string): ScopeWithRules[]
}

export type AccessReason = 'role' | 'rule' | 'no-rule' | 'not-member'

export interface AccessResult {
  read: boolean
  write: boolean
  source: {
    /** The scope whose rules decided, or null (role / not a member / no scope). */
    scopeId: string | null
    path: string
    reason: AccessReason
  }
}

export const FULL_ACCESS_ROLES: ReadonlySet<string> = new Set(['owner', 'admin'])

/**
 * Normalise a repo-relative folder path (paths.ts normalizeRepoPath): forward
 * slashes, no leading/trailing or repeated slashes, Unicode NFC (macOS hands
 * out NFD file names, which would otherwise never match a Japanese path
 * stored from another platform). null for paths that escape the repository
 * ('.' / '..' segments). '' is the company root.
 */
export const normalizeScopePath = normalizeRepoPath

export { compareScopePaths, isSameOrAncestorPath }

/**
 * The deepest scope at or above `path` that has at least one rule — the scope
 * whose rules decide access for `path`. null when no such scope exists.
 */
export function findGoverningScope<T extends { path: string; rules: unknown[] }>(scopes: T[], path: string): T | null {
  let best: T | null = null
  for (const s of scopes) {
    if (s.rules.length === 0 || !isSameOrAncestorPath(s.path, path)) continue
    if (!best || s.path.length > best.path.length) best = s
  }
  return best
}

/** The rules of one scope that decide for a user with `role`, per the precedence above. */
export function applicableRules(rules: ScopeRule[], userId: string, role: string): ScopeRule[] {
  const userRules = rules.filter(r => r.subjectType === 'user' && r.subjectId === userId)
  if (userRules.length > 0) return userRules
  // One level for the sets of people: the departments the user belongs to and the groups they are in.
  const setRules = rules.filter(r => (r.subjectType === 'department' || r.subjectType === 'group') && (r.memberIds ?? []).includes(userId))
  if (setRules.length > 0) return setRules
  const roleRules = rules.filter(r => r.subjectType === 'role' && r.subjectId === role)
  if (roleRules.length > 0) return roleRules
  return rules.filter(r => r.subjectType === 'everyone')
}

/**
 * One entry of a record's members-only list (「この人たちだけ」, records.md "Members-only records"),
 * written in the same subject form as a place's rules: a person, a group (見える人のまとまり) or a
 * department (the people who belong to it, 所属). `memberIds` as on a rule: who is in the group or
 * department now, resolved when the list is read; absent = nobody.
 */
export interface ListSubject {
  type: 'user' | 'group' | 'department'
  id: string
  memberIds?: readonly string[]
}

/**
 * Does a members-only list include the user? The list's subjects match exactly as a scope's rules
 * do (`applicableRules`: a user subject names them, a group or department subject has them among
 * its `memberIds`), each granting read. No role and no `everyone` subject exists on a list, so an
 * owner or admin is included only when listed — the list is strict (records.md "Members-only
 * records"), unlike a place where `FULL_ACCESS_ROLES` read everything.
 */
export function listIncludes(subjects: readonly ListSubject[], userId: string): boolean {
  const rules: ScopeRule[] = subjects.map(s => ({
    id: '', subjectType: s.type, subjectId: s.id, canRead: true, canWrite: false, ...(s.memberIds ? { memberIds: s.memberIds } : {}),
  }))
  return applicableRules(rules, userId, '').some(r => r.canRead)
}

export function resolveAccess(
  companyId: string,
  userId: string,
  path: string,
  repo: PermissionRepository,
): AccessResult {
  const normalized = normalizeScopePath(path)
  const role = repo.getMemberRole(companyId, userId)
  if (role === null || normalized === null) {
    return { read: false, write: false, source: { scopeId: null, path: normalized ?? path, reason: 'not-member' } }
  }
  if (FULL_ACCESS_ROLES.has(role)) {
    return { read: true, write: true, source: { scopeId: null, path: normalized, reason: 'role' } }
  }

  const scopes = repo.listScopes(companyId)
  const scope = findGoverningScope(scopes, normalized)
  if (!scope) {
    return { read: false, write: false, source: { scopeId: null, path: normalized, reason: 'no-rule' } }
  }
  const rules = applicableRules(scope.rules, userId, role)
  let read = rules.some(r => r.canRead)
  let write = rules.some(r => r.canWrite)
  // Inside a private folder its own rules decide who gets the repository at
  // all; inside a read-restricted place, who reads it. A rule deeper inside
  // can narrow access, never widen it past them. A gate without rules (a
  // private scope is never stored so; it never inherits) denies.
  for (const gate of scopes) {
    if (gate.id === scope.id || !isGate(gate) || !isSameOrAncestorPath(gate.path, normalized)) continue
    const gateRead = gate.rules.length > 0 && applicableRules(gate.rules, userId, role).some(r => r.canRead)
    read = read && gateRead
    write = write && gateRead
  }
  return {
    read,
    write,
    source: { scopeId: scope.id, path: scope.path, reason: read || write ? 'rule' : 'no-rule' },
  }
}

/**
 * Does this scope gate everything inside it (resolveAccess step 5)? A private
 * folder, or a read-restricted place of a company without the shared folder.
 */
export function isGate(scope: { repoId: string | null; readRestricted?: boolean }): boolean {
  return scope.repoId !== null || scope.readRestricted === true
}

/**
 * May this member read the gate itself (owner/admin always)? For a private
 * folder it is canReadPrivateScope. Who cannot is not to learn its name
 * (owner decision B; read-restricted places: groups PR, 2026-11-07).
 */
export function canReadGate(scope: ScopeWithRules, userId: string, role: string): boolean {
  if (FULL_ACCESS_ROLES.has(role)) return true
  return scope.rules.length > 0 && applicableRules(scope.rules, userId, role).some(r => r.canRead)
}

/**
 * The scopes a member may know of: every scope except those at or under a
 * gate (private folder, read-restricted place) the member cannot read. What
 * lists places to a member filters through it, so an unreadable place's name
 * never reaches them.
 */
export function scopesKnownTo<T extends ScopeWithRules>(scopes: T[], userId: string, role: string): T[] {
  if (FULL_ACCESS_ROLES.has(role)) return scopes
  const hidden = scopes.filter(s => isGate(s) && !canReadGate(s, userId, role))
  return scopes.filter(s => !hidden.some(h => isSameOrAncestorPath(h.path, s.path)))
}

/** The private scope at or above `path`, or null (private folders do not nest). */
export function findPrivateScope<T extends { path: string; repoId: string | null }>(scopes: T[], path: string): T | null {
  let best: T | null = null
  for (const s of scopes) {
    if (s.repoId === null || !isSameOrAncestorPath(s.path, path)) continue
    if (!best || s.path.length > best.path.length) best = s
  }
  return best
}

/** May this member read the private scope (owner/admin always)? */
export function canReadPrivateScope(scope: ScopeWithRules, userId: string, role: string): boolean {
  if (FULL_ACCESS_ROLES.has(role)) return true
  return scope.rules.length > 0 && applicableRules(scope.rules, userId, role).some(r => r.canRead)
}

/** May the member push to this private folder's repository at all (write somewhere in it)? */
export function canWriteInPrivateFolder(scopes: ScopeWithRules[], folder: ScopeWithRules, companyId: string, userId: string, role: string): boolean {
  if (FULL_ACCESS_ROLES.has(role)) return true
  const repo: PermissionRepository = { getMemberRole: () => role, listScopes: () => scopes }
  return scopes
    .filter(s => isSameOrAncestorPath(folder.path, s.path))
    .some(s => resolveAccess(companyId, userId, s.path, repo).write)
}

export type EffectiveSummary = 'everyone-rw' | 'everyone-r' | 'restricted'

/**
 * One-word summary of a governing rule set for the admin panel:
 * - everyone-rw: everyone reads and writes, and no role/user rule takes
 *   anything away;
 * - everyone-r:  everyone reads (some may write), and no role/user rule takes
 *   read away;
 * - restricted:  anything else (including no rules at all).
 */
export function summarizeRules(rules: ScopeRule[]): EffectiveSummary {
  const everyone = rules.filter(r => r.subjectType === 'everyone')
  const others = rules.filter(r => r.subjectType !== 'everyone')
  const everyoneRead = everyone.some(r => r.canRead)
  const everyoneWrite = everyone.some(r => r.canWrite)
  if (everyoneRead && everyoneWrite && others.every(r => r.canRead && r.canWrite)) return 'everyone-rw'
  if (everyoneRead && others.every(r => r.canRead)) return 'everyone-r'
  return 'restricted'
}

/**
 * What one member may write, in a form a client can evaluate for any path
 * with exactly resolveAccess()'s semantics (GET /me/write-access; the desktop
 * app uses it to stop the in-app AI from editing folders the push would
 * reject with [WRITE_DENIED]).
 *
 * - `all: true`: the member may write every path (owner/admin, or every scope
 *   with rules lets them write). `scopes` is then empty.
 * - otherwise `scopes` lists every scope that HAS rules (the transparent ones
 *   decide nothing) with the outcome of its rules for this member. For a path,
 *   the deepest listed scope at or above it decides; none → no write
 *   (resolveAccess's 'no-rule'). A private folder the member can read is
 *   marked `private: true` (evaluateWrite in ./write-access.ts takes paths
 *   inside it in its stored spelling, as its repository receives them).
 *
 * Paths are NFC, '/'-separated, '' = company root, sorted parents first.
 */
export interface WriteAccessSummary {
  all: boolean
  scopes: WriteAccessScope[]
}

export function writeAccessSummary(scopes: ScopeWithRules[], userId: string, role: string): WriteAccessSummary {
  if (FULL_ACCESS_ROLES.has(role)) return { all: true, scopes: [] }
  // Private folders the member cannot read are left out entirely — their
  // names are not to be revealed (the member's push there is refused as
  // [RESERVED_PATH] anyway). Inside a readable one, write also needs read of
  // the private folder itself (resolveAccess). The same for a read-restricted
  // place (a company without the shared folder has no files to write there,
  // but the place's name is not to be revealed either).
  const hidden = scopes.filter(s => isGate(s) && !canReadGate(s, userId, role))

  const decided = scopes
    .filter(s => s.rules.length > 0 && !hidden.some(h => isSameOrAncestorPath(h.path, s.path)))
    .map((s): WriteAccessScope => ({
      path: s.path,
      write: applicableRules(s.rules, userId, role).some(r => r.canWrite),
      ...(s.repoId !== null ? { private: true } : {}),
    }))
    .sort((a, b) => compareScopePaths(a.path, b.path))
  const hasRoot = decided.some(s => s.path === '')
  if (hasRoot && decided.every(s => s.write)) return { all: true, scopes: [] }
  return { all: false, scopes: decided }
}
