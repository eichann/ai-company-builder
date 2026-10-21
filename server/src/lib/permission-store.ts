/**
 * SQLite side of the permission model (see lib/permissions.ts for semantics).
 *
 * Tables (created in db/index.ts): scopes, scope_rules, department_managers,
 * push_rejections. Every function takes the connection explicitly so the
 * schema/seeding code can run against any database file (tests use a copy of
 * an "old" database) and so this module does not import db/index.ts, which
 * calls into it during initDatabase().
 *
 * Ownership of scope rows:
 * - the company scope (path '') is created with the company and seeded with
 *   `everyone: read + write` exactly once, when the scope is first created.
 *   Re-running the seed never re-adds the rule, so a later edit that removes
 *   it (Phase 2) sticks.
 * - department scopes follow the departments table: created with the
 *   department, path moved on a folder rename, deleted (with its rules, the
 *   rules and scopes of folders under it, and the department's managers) when
 *   the department is deleted. The FOREIGN KEYs also cascade, so a department
 *   deleted by an older server build that does not know about scopes does not
 *   leave rows behind either; startup seeding repairs anything else.
 */
import type Database from 'better-sqlite3'
import {
  findGoverningScope,
  normalizeScopePath,
  type PermissionRepository,
  type ScopeKind,
  type ScopeRule,
  type ScopeWithRules,
  type SubjectType,
} from './permissions'

type Conn = Database.Database

function newId(): string {
  return crypto.randomUUID()
}

function timestamp(): string {
  return new Date().toISOString()
}

interface ScopeRow {
  id: string
  company_id: string
  path: string
  kind: ScopeKind
  department_id: string | null
  repo_id: string | null
}

interface RuleRow {
  id: string
  scope_id: string
  subject_type: SubjectType
  subject_id: string | null
  can_read: number
  can_write: number
}

// ----------------------------------------------------------------------------
// Seeding / repair
// ----------------------------------------------------------------------------

/**
 * Ensure the company scope exists; when it is created here, give it the
 * default `everyone: read + write` rule. Returns the scope id.
 */
export function ensureCompanyScope(conn: Conn, companyId: string, createdBy: string | null = null): string {
  const existing = conn.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = ''`).get(companyId) as { id: string } | undefined
  if (existing) return existing.id
  const id = newId()
  const ts = timestamp()
  conn.transaction(() => {
    conn.prepare(`
      INSERT INTO scopes (id, company_id, path, kind, department_id, repo_id, created_at, created_by)
      VALUES (?, ?, '', 'company', NULL, NULL, ?, ?)
    `).run(id, companyId, ts, createdBy)
    conn.prepare(`
      INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by)
      VALUES (?, ?, 'everyone', NULL, 1, 1, ?, ?)
    `).run(newId(), id, ts, createdBy)
  })()
  return id
}

/**
 * Ensure the department's scope exists at `folder` and points at the
 * department. A plain folder scope already at that path is adopted (kept with
 * its rules); a department scope at a stale path is moved.
 */
export function ensureDepartmentScope(
  conn: Conn,
  companyId: string,
  departmentId: string,
  folder: string,
  createdBy: string | null = null,
): void {
  const path = normalizeScopePath(folder)
  if (path === null || path === '') return
  const own = conn.prepare(`SELECT id, path FROM scopes WHERE department_id = ?`).get(departmentId) as { id: string; path: string } | undefined
  const atPath = conn.prepare(`SELECT id, department_id FROM scopes WHERE company_id = ? AND path = ?`)
    .get(companyId, path) as { id: string; department_id: string | null } | undefined

  if (own) {
    if (own.path === path) return
    if (atPath) return // another scope holds the path; leave both alone (moveScopeSubtree handles real renames)
    conn.prepare(`UPDATE scopes SET path = ? WHERE id = ?`).run(path, own.id)
    return
  }
  if (atPath) {
    if (atPath.department_id === null) {
      conn.prepare(`UPDATE scopes SET kind = 'department', department_id = ? WHERE id = ?`).run(departmentId, atPath.id)
    }
    return
  }
  conn.prepare(`
    INSERT INTO scopes (id, company_id, path, kind, department_id, repo_id, created_at, created_by)
    VALUES (?, ?, ?, 'department', ?, NULL, ?, ?)
  `).run(newId(), companyId, path, departmentId, timestamp(), createdBy)
}

/**
 * Bring one company's scopes in line with its departments: company scope,
 * one scope per department, no scope or manager left for a department that no
 * longer exists. Idempotent.
 */
export function syncCompanyScopes(conn: Conn, companyId: string): void {
  conn.transaction(() => {
    ensureCompanyScope(conn, companyId)
    const depts = conn.prepare(`SELECT id, folder FROM departments WHERE company_id = ?`).all(companyId) as Array<{ id: string; folder: string }>
    for (const d of depts) ensureDepartmentScope(conn, companyId, d.id, d.folder)
    // Departments removed without going through deleteDepartmentScopes (older
    // server builds, the /departments/sync endpoint, foreign_keys disabled).
    const orphans = conn.prepare(`
      SELECT id FROM scopes
      WHERE company_id = ? AND kind = 'department'
        AND (department_id IS NULL OR department_id NOT IN (SELECT id FROM departments WHERE company_id = ?))
    `).all(companyId, companyId) as Array<{ id: string }>
    for (const o of orphans) {
      conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(o.id)
      conn.prepare(`DELETE FROM scopes WHERE id = ?`).run(o.id)
    }
  })()
}

/** Startup seeding for every company. Idempotent. */
export function seedPermissionScopes(conn: Conn): void {
  const companies = conn.prepare(`SELECT id FROM companies`).all() as Array<{ id: string }>
  for (const c of companies) syncCompanyScopes(conn, c.id)
  conn.prepare(`DELETE FROM department_managers WHERE department_id NOT IN (SELECT id FROM departments)`).run()
}

/**
 * A department folder was renamed: move its scope and every scope under it.
 * A scope already sitting in the target subtree is stale (the target folder
 * did not exist — the rename checks that), so it is replaced; one carved out
 * into its own repository (repo_id set) is never dropped silently.
 */
export function moveScopeSubtree(conn: Conn, companyId: string, fromPath: string, toPath: string): void {
  const from = normalizeScopePath(fromPath)
  const to = normalizeScopePath(toPath)
  if (!from || !to || from === to) return
  conn.transaction(() => {
    const stale = conn.prepare(`
      SELECT id, repo_id FROM scopes WHERE company_id = ? AND (path = ? OR substr(path, 1, ?) = ?)
    `).all(companyId, to, to.length + 1, `${to}/`) as Array<{ id: string; repo_id: string | null }>
    if (stale.some(s => s.repo_id !== null)) {
      throw new Error(`A separately stored folder already exists at ${to}`)
    }
    for (const s of stale) {
      conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(s.id)
      conn.prepare(`DELETE FROM scopes WHERE id = ?`).run(s.id)
    }
    const moving = conn.prepare(`
      SELECT id, path FROM scopes WHERE company_id = ? AND (path = ? OR substr(path, 1, ?) = ?)
    `).all(companyId, from, from.length + 1, `${from}/`) as Array<{ id: string; path: string }>
    for (const m of moving) {
      conn.prepare(`UPDATE scopes SET path = ? WHERE id = ?`).run(to + m.path.slice(from.length), m.id)
    }
  })()
}

/** A department was deleted (folder removed): drop its scope subtree, rules and managers. */
export function deleteDepartmentScopes(conn: Conn, companyId: string, departmentId: string, folder: string): void {
  const path = normalizeScopePath(folder)
  conn.transaction(() => {
    const ids = (conn.prepare(`SELECT id, path, department_id FROM scopes WHERE company_id = ?`)
      .all(companyId) as Array<{ id: string; path: string; department_id: string | null }>)
      .filter(s => s.department_id === departmentId || (!!path && (s.path === path || s.path.startsWith(`${path}/`))))
    for (const { id } of ids) {
      conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(id)
      conn.prepare(`DELETE FROM scopes WHERE id = ?`).run(id)
    }
    conn.prepare(`DELETE FROM department_managers WHERE department_id = ?`).run(departmentId)
  })()
}

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

export function listScopesWithRules(conn: Conn, companyId: string): ScopeWithRules[] {
  const scopes = conn.prepare(`SELECT * FROM scopes WHERE company_id = ?`).all(companyId) as ScopeRow[]
  const rules = conn.prepare(`
    SELECT r.* FROM scope_rules r JOIN scopes s ON s.id = r.scope_id
    WHERE s.company_id = ? ORDER BY r.created_at ASC, r.rowid ASC
  `).all(companyId) as RuleRow[]
  const byScope = new Map<string, ScopeRule[]>()
  for (const r of rules) {
    const list = byScope.get(r.scope_id) ?? []
    list.push({
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      canRead: r.can_read === 1,
      canWrite: r.can_write === 1,
    })
    byScope.set(r.scope_id, list)
  }
  return scopes.map(s => ({
    id: s.id,
    path: s.path,
    kind: s.kind,
    departmentId: s.department_id,
    repoId: s.repo_id,
    rules: byScope.get(s.id) ?? [],
  }))
}

export function getMemberRole(conn: Conn, companyId: string, userId: string): string | null {
  const row = conn.prepare(`SELECT role FROM memberships WHERE user_id = ? AND company_id = ?`)
    .get(userId, companyId) as { role: string } | undefined
  return row?.role ?? null
}

export function sqlitePermissionRepository(conn: Conn): PermissionRepository {
  return {
    getMemberRole: (companyId, userId) => getMemberRole(conn, companyId, userId),
    listScopes: (companyId) => listScopesWithRules(conn, companyId),
  }
}

/** Department ids in `companyId` that `userId` manages. */
export function managedDepartmentIds(conn: Conn, companyId: string, userId: string): string[] {
  const rows = conn.prepare(`
    SELECT dm.department_id FROM department_managers dm
    JOIN departments d ON d.id = dm.department_id
    JOIN memberships m ON m.user_id = dm.user_id AND m.company_id = d.company_id
    WHERE d.company_id = ? AND dm.user_id = ?
    ORDER BY d.sort_order ASC, d.created_at ASC
  `).all(companyId, userId) as Array<{ department_id: string }>
  return rows.map(r => r.department_id)
}

/** Current managers of a department (rows of users who left the company are ignored). */
export function listDepartmentManagerIds(conn: Conn, departmentId: string): string[] {
  const rows = conn.prepare(`
    SELECT dm.user_id FROM department_managers dm
    JOIN departments d ON d.id = dm.department_id
    JOIN memberships m ON m.user_id = dm.user_id AND m.company_id = d.company_id
    WHERE dm.department_id = ? ORDER BY dm.created_at ASC, dm.user_id ASC
  `).all(departmentId) as Array<{ user_id: string }>
  return rows.map(r => r.user_id)
}

/** A member left the company: they manage nothing there any more. */
export function removeManagerFromCompany(conn: Conn, companyId: string, userId: string): void {
  conn.prepare(`
    DELETE FROM department_managers
    WHERE user_id = ? AND department_id IN (SELECT id FROM departments WHERE company_id = ?)
  `).run(userId, companyId)
}

/** Replace the department's managers with `userIds` (kept rows keep their created_at/by). */
export function replaceDepartmentManagers(conn: Conn, departmentId: string, userIds: string[], createdBy: string): void {
  conn.transaction(() => {
    const current = new Set((conn.prepare(`SELECT user_id FROM department_managers WHERE department_id = ?`)
      .all(departmentId) as Array<{ user_id: string }>).map(r => r.user_id))
    const wanted = new Set(userIds)
    for (const id of current) {
      if (!wanted.has(id)) conn.prepare(`DELETE FROM department_managers WHERE department_id = ? AND user_id = ?`).run(departmentId, id)
    }
    const ts = timestamp()
    for (const id of wanted) {
      if (!current.has(id)) {
        conn.prepare(`
          INSERT INTO department_managers (department_id, user_id, created_at, created_by) VALUES (?, ?, ?, ?)
        `).run(departmentId, id, ts, createdBy)
      }
    }
  })()
}

// ----------------------------------------------------------------------------
// Rule editing (Phase 2: admin panel)
//
// Write side of the editor in routes/permission-rules.ts. Authorization and
// validation happen there; these functions only keep the tables consistent:
//
// - A scope that starts carrying its own rules *breaks inheritance by
//   copying*: the rules of the scope that governed it so far are copied in
//   first (breakInheritance), so adding "田中: 編集できる" to a folder changes
//   nothing for anyone else. Without the copy, every member not named by the
//   new rule would fall to "no rule" there (lib/permissions.ts, step 3).
// - A folder scope (kind 'folder') left without rules is removed; company and
//   department scopes stay (they follow the company / departments tables).
// ----------------------------------------------------------------------------

export interface ScopeRecord {
  id: string
  companyId: string
  path: string
  kind: ScopeKind
  departmentId: string | null
}

function toScopeRecord(row: ScopeRow): ScopeRecord {
  return { id: row.id, companyId: row.company_id, path: row.path, kind: row.kind, departmentId: row.department_id }
}

export function getScopeByPath(conn: Conn, companyId: string, path: string): ScopeRecord | null {
  const row = conn.prepare(`SELECT * FROM scopes WHERE company_id = ? AND path = ?`).get(companyId, path) as ScopeRow | undefined
  return row ? toScopeRecord(row) : null
}

export function getScopeById(conn: Conn, companyId: string, scopeId: string): ScopeRecord | null {
  const row = conn.prepare(`SELECT * FROM scopes WHERE company_id = ? AND id = ?`).get(companyId, scopeId) as ScopeRow | undefined
  return row ? toScopeRecord(row) : null
}

export function listScopeRules(conn: Conn, scopeId: string): ScopeRule[] {
  const rows = conn.prepare(`SELECT * FROM scope_rules WHERE scope_id = ? ORDER BY created_at ASC, rowid ASC`).all(scopeId) as RuleRow[]
  return rows.map(r => ({
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    canRead: r.can_read === 1,
    canWrite: r.can_write === 1,
  }))
}

/** A rule with the scope it belongs to, or null when it is not a rule of `companyId`. */
export function getRuleWithScope(conn: Conn, companyId: string, ruleId: string): { rule: ScopeRule; scope: ScopeRecord } | null {
  const row = conn.prepare(`
    SELECT s.id AS scope_id FROM scope_rules r JOIN scopes s ON s.id = r.scope_id
    WHERE r.id = ? AND s.company_id = ?
  `).get(ruleId, companyId) as { scope_id: string } | undefined
  if (!row) return null
  const scope = getScopeById(conn, companyId, row.scope_id)
  const rule = listScopeRules(conn, row.scope_id).find(r => r.id === ruleId)
  return scope && rule ? { rule, scope } : null
}

/** The scope at `path`, created as a plain folder scope (no rules) when missing. */
export function ensureFolderScope(conn: Conn, companyId: string, path: string, createdBy: string | null): ScopeRecord {
  const existing = getScopeByPath(conn, companyId, path)
  if (existing) return existing
  if (path === '') {
    ensureCompanyScope(conn, companyId, createdBy)
    return getScopeByPath(conn, companyId, '')!
  }
  conn.prepare(`
    INSERT INTO scopes (id, company_id, path, kind, department_id, repo_id, created_at, created_by)
    VALUES (?, ?, ?, 'folder', NULL, NULL, ?, ?)
  `).run(newId(), companyId, path, timestamp(), createdBy)
  return getScopeByPath(conn, companyId, path)!
}

function insertRule(conn: Conn, scopeId: string, rule: Omit<ScopeRule, 'id'>, createdBy: string | null): string {
  const id = newId()
  conn.prepare(`
    INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, scopeId, rule.subjectType, rule.subjectId, rule.canRead ? 1 : 0, rule.canWrite ? 1 : 0, timestamp(), createdBy)
  return id
}

/**
 * Give an inheriting scope its own copy of the rules that governed it. No-op
 * when the scope already has rules. Returns the scope's rules afterwards.
 */
export function breakInheritance(conn: Conn, companyId: string, scope: ScopeRecord, createdBy: string | null): ScopeRule[] {
  const own = listScopeRules(conn, scope.id)
  if (own.length > 0) return own
  const others = listScopesWithRules(conn, companyId).filter(s => s.id !== scope.id)
  const governing = findGoverningScope(others, scope.path)
  for (const r of governing?.rules ?? []) {
    insertRule(conn, scope.id, { subjectType: r.subjectType, subjectId: r.subjectId, canRead: r.canRead, canWrite: r.canWrite }, createdBy)
  }
  return listScopeRules(conn, scope.id)
}

/**
 * Set `subject`'s rule on the scope at `path` (creating the scope, and
 * copying inherited rules into it, as needed). One rule per subject per
 * scope: an existing one is updated. Returns the rule id and whether the
 * scope gained a rule of its own (201) rather than an update (200).
 */
export function upsertScopeRule(
  conn: Conn,
  companyId: string,
  path: string,
  rule: Omit<ScopeRule, 'id'>,
  createdBy: string,
): { ruleId: string; created: boolean; scope: ScopeRecord } {
  return conn.transaction(() => {
    const scope = ensureFolderScope(conn, companyId, path, createdBy)
    const wasInheriting = listScopeRules(conn, scope.id).length === 0
    const rules = breakInheritance(conn, companyId, scope, createdBy)
    const same = rules.find(r => r.subjectType === rule.subjectType && (r.subjectId ?? null) === (rule.subjectId ?? null))
    if (same) {
      updateRuleAccess(conn, same.id, rule.canRead, rule.canWrite)
      // A rule copied in by breakInheritance a moment ago is new to this scope.
      return { ruleId: same.id, created: wasInheriting, scope }
    }
    return { ruleId: insertRule(conn, scope.id, rule, createdBy), created: true, scope }
  })()
}

export function updateRuleAccess(conn: Conn, ruleId: string, canRead: boolean, canWrite: boolean): void {
  conn.prepare(`UPDATE scope_rules SET can_read = ?, can_write = ? WHERE id = ?`).run(canRead ? 1 : 0, canWrite ? 1 : 0, ruleId)
}

/** Remove a folder scope that has no rules left (company/department scopes stay). */
function dropEmptyFolderScope(conn: Conn, scope: ScopeRecord): void {
  if (scope.kind !== 'folder') return
  if (listScopeRules(conn, scope.id).length > 0) return
  conn.prepare(`DELETE FROM scopes WHERE id = ?`).run(scope.id)
}

export function deleteRule(conn: Conn, ruleId: string, scope: ScopeRecord): void {
  conn.transaction(() => {
    conn.prepare(`DELETE FROM scope_rules WHERE id = ?`).run(ruleId)
    dropEmptyFolderScope(conn, scope)
  })()
}

/** Remove every rule of the scope: it inherits from its parent again. Returns how many were removed. */
export function clearScopeRules(conn: Conn, scope: ScopeRecord): number {
  return conn.transaction(() => {
    const n = conn.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(scope.id).changes
    dropEmptyFolderScope(conn, scope)
    return n
  })()
}

/**
 * Replace the whole rule set of the scope at `path` in one transaction — the
 * write side of the admin panel's per-folder choice (上の階層と同じ / 全員 /
 * 指定した人だけ). Unlike upsertScopeRule nothing is copied from the parent:
 * the caller sends the complete set. `rules: []` makes the scope inherit
 * again (a folder scope is then removed). Rules whose subject is already on
 * the scope keep their row (id, created_at/by); the others are deleted or
 * inserted. Validation (subjects, an everyone rule when non-empty, the company
 * root never empty) is the route's job; this only keeps the tables
 * consistent, all or nothing. Returns the scope, or null when none is left.
 */
export function replaceScopeRules(
  conn: Conn,
  companyId: string,
  path: string,
  rules: Array<Omit<ScopeRule, 'id'>>,
  createdBy: string,
): ScopeRecord | null {
  return conn.transaction(() => {
    const existing = getScopeByPath(conn, companyId, path)
    if (rules.length === 0 && !existing) return null
    const scope = existing ?? ensureFolderScope(conn, companyId, path, createdBy)
    const key = (r: Pick<ScopeRule, 'subjectType' | 'subjectId'>) => `${r.subjectType}:${r.subjectId ?? ''}`
    const current = new Map(listScopeRules(conn, scope.id).map(r => [key(r), r]))
    const wanted = new Set(rules.map(key))
    for (const [k, r] of current) {
      if (!wanted.has(k)) conn.prepare(`DELETE FROM scope_rules WHERE id = ?`).run(r.id)
    }
    for (const r of rules) {
      const same = current.get(key(r))
      if (same) updateRuleAccess(conn, same.id, r.canRead, r.canWrite)
      else insertRule(conn, scope.id, r, createdBy)
    }
    dropEmptyFolderScope(conn, scope)
    return getScopeById(conn, companyId, scope.id)
  })()
}
