/**
 * Permission model (Phase 1: data model + read APIs; nothing is enforced yet).
 *
 * A *scope* is a node a rule can attach to: the whole company (path ''), a
 * department folder, or any other folder inside the company repository. A
 * *rule* on a scope grants read and/or write to a subject: everyone in the
 * company, a role (owner / admin / member), or one user.
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
 *        user rules for this user  >  role rules for the user's role  >  everyone
 *      The most specific subject type that has at least one matching rule
 *      decides; several matching rules of that type are unioned. So a user rule
 *      can narrow (or widen) what `everyone` gets on the same scope.
 *   4. If nothing there grants anything, deny (reason 'no-rule').
 *
 * Being a department manager (department_managers) grants NO file access in
 * Phase 1: management rights (who may edit a department's rules — Phase 2) are
 * deliberately separate from data rights. A manager reads and writes exactly
 * what the rules give them.
 *
 * This module is pure: data comes in through PermissionRepository so it can be
 * unit-tested without SQLite or Hono (see lib/permission-store.ts for the
 * SQLite implementation).
 */

export type ScopeKind = 'company' | 'department' | 'folder'
export type SubjectType = 'everyone' | 'role' | 'user'

export interface ScopeRule {
  id: string
  subjectType: SubjectType
  /** Role name for 'role', user id for 'user', null for 'everyone'. */
  subjectId: string | null
  canRead: boolean
  canWrite: boolean
}

export interface ScopeWithRules {
  id: string
  path: string
  kind: ScopeKind
  departmentId: string | null
  /**
   * null = lives in the company's main repository. Set = a PRIVATE folder:
   * its own scope repository (lib/private-folders.ts), served only to members
   * who may read this scope; the path is reserved in the main repository.
   */
  repoId: string | null
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
 * Normalise a repo-relative folder path: forward slashes, no leading/trailing
 * or repeated slashes, Unicode NFC (macOS hands out NFD file names, which would
 * otherwise never match a Japanese path stored from another platform).
 * Returns null for paths that escape the repository ('.' / '..' segments).
 * '' is the company root.
 */
export function normalizeScopePath(raw: string): string | null {
  const segments = raw.normalize('NFC').replace(/\\/g, '/').split('/').filter(s => s.length > 0)
  if (segments.some(s => s === '.' || s === '..')) return null
  return segments.join('/')
}

/** True when `ancestor` is `path` itself or one of its parent folders ('' is everyone's ancestor). */
export function isSameOrAncestorPath(ancestor: string, path: string): boolean {
  if (ancestor === '') return true
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/** Parents before children, siblings by name. */
export function compareScopePaths(a: string, b: string): number {
  const as = a === '' ? [] : a.split('/')
  const bs = b === '' ? [] : b.split('/')
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1
  }
  return as.length - bs.length
}

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
  const roleRules = rules.filter(r => r.subjectType === 'role' && r.subjectId === role)
  if (roleRules.length > 0) return roleRules
  return rules.filter(r => r.subjectType === 'everyone')
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
  // Inside a private folder, its own rules decide who gets the repository at
  // all: a rule deeper inside can narrow access, never widen it past them.
  // A private scope without rules (never stored, but never inherit) denies.
  const priv = findPrivateScope(scopes, normalized)
  if (priv && priv.id !== scope.id) {
    const rootRead = priv.rules.length > 0 && applicableRules(priv.rules, userId, role).some(r => r.canRead)
    read = read && rootRead
    write = write && rootRead
  }
  return {
    read,
    write,
    source: { scopeId: scope.id, path: scope.path, reason: read || write ? 'rule' : 'no-rule' },
  }
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
 *   (resolveAccess's 'no-rule').
 *
 * Paths are NFC, '/'-separated, '' = company root, sorted parents first.
 */
export interface WriteAccessSummary {
  all: boolean
  scopes: Array<{ path: string; write: boolean }>
}

export function writeAccessSummary(scopes: ScopeWithRules[], userId: string, role: string): WriteAccessSummary {
  if (FULL_ACCESS_ROLES.has(role)) return { all: true, scopes: [] }
  // Private folders the member cannot read are left out entirely — their
  // names are not to be revealed (the member's push there is refused as
  // [RESERVED_PATH] anyway). Inside a readable one, write also needs read of
  // the private folder itself (resolveAccess).
  const readablePrivate = scopes.filter(s => s.repoId !== null && canReadPrivateScope(s, userId, role))
  const hidden = scopes.filter(s => s.repoId !== null && !readablePrivate.includes(s))
  const decided = scopes
    .filter(s => s.rules.length > 0 && !hidden.some(h => isSameOrAncestorPath(h.path, s.path)))
    .map(s => ({ path: s.path, write: applicableRules(s.rules, userId, role).some(r => r.canWrite) }))
    .sort((a, b) => compareScopePaths(a.path, b.path))
  const hasRoot = decided.some(s => s.path === '')
  if (hasRoot && decided.every(s => s.write)) return { all: true, scopes: [] }
  return { all: false, scopes: decided }
}
