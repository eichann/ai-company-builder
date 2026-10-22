/**
 * Write APIs of the permission editor (Phase 2) and the security screen.
 * Mounted at /api/companies/:companyId next to routes/permissions.ts (reads).
 *
 *   PUT    /permissions/scopes/by-path        replace a path's whole rule set (what the panel uses)
 *   POST   /permissions/rules                 set a subject's rule on a path
 *   PATCH  /permissions/rules/:ruleId         change a rule's access
 *   DELETE /permissions/rules/:ruleId         remove a rule
 *   DELETE /permissions/scopes/:scopeId/rules back to inheriting (not the company root)
 *
 * The admin panel edits one folder at a time as a choice — 上の階層と同じ
 * (rules: []), 全員 (everyone: edit) or 指定した人だけ (everyone: read only +
 * an edit rule per chosen member / role) — and saves it with the PUT, which
 * replaces the set atomically and copies nothing. The per-rule endpoints are
 * kept for API clients; they still copy the inherited rules into a folder on
 * its first rule (see below), because a single rule alone would leave
 * everyone else on that folder without any rule.
 *   GET    /permissions/effective?path=       every member's access at a path, and why
 *   GET    /permissions/folders?path=         sub-folders of a path (to pick one)
 *   GET    /push-rejections                   rejected pushes, filterable (owner/admin)
 *
 * Who may edit (decisions Q2/Q5 of the permission plan):
 * - owner / admin: every scope;
 * - a department manager (department_managers): the department folder and
 *   everything inside it, for the departments they manage — nothing else;
 * - other members: nothing (403).
 *
 * What may be stored:
 * - write: true/false per subject (everyone / the member role / one user);
 * - read: always true, except on a PRIVATE folder itself (Phase 3,
 *   lib/private-folders.ts), the only place a read restriction is enforced
 *   (its own repository). Anywhere else — the company repository, or a folder
 *   inside a private folder (same repository) — `read: false` is refused
 *   with 400 instead of being stored and silently not enforced.
 * - A private folder always keeps rules of its own (never back to
 *   inheriting, which would make it readable): clearing them, removing the
 *   last rule or moving them away is refused. Changes inside private folders
 *   skip the outdated-app guard: only apps that handle private folders ever
 *   receive them.
 * - Rules for owner/admin (by role or by user) are refused: owners and admins
 *   always read and write everywhere (lib/permissions.ts), so such a rule
 *   would only mislead. That is also why no edit can lock the company out.
 * - A scope with its own rules always keeps a rule for everyone: the PUT
 *   refuses a non-empty set without one (EVERYONE_RULE_REQUIRED); with the
 *   per-rule endpoints the first rule on an inheriting scope copies the
 *   inherited rules in (breakInheritance in lib/permission-store.ts), and the
 *   everyone rule can only go together with all the others (= back to
 *   inheriting). Without it a
 *   member not named by any rule would lose read access there, which is a
 *   read restriction by another name.
 *
 * Outdated apps (guardWrite): a desktop app older than #114 does not
 * understand a `[WRITE_DENIED]` rejection and retries it on every sync
 * forever. So every change above (and the move below) is applied in a
 * transaction, the members who would lose write access anywhere in the
 * affected subtree are computed (lib/write-loss.ts), and if any of them runs
 * an app without the recovery — or one whose version is unknown — the change
 * is rolled back and answered 409 OUTDATED_CLIENTS with those members. An
 * owner/admin may override with `force: true` (body, or `?force=true` on a
 * DELETE); a manager sending it gets 403. Nothing else is recorded.
 *   POST   /permissions/scopes/:scopeId/move  { toPath } move the rules of a
 *          folder (and of folders inside it) to another existing folder — for
 *          rules left behind by a rename made by a sync push
 *          (lib/orphaned-scopes.ts). Same authorization as editing, for both
 *          the old and the new place.
 *
 * Audit: there is no audit log in this codebase yet; rule rows keep
 * created_at / created_by.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from '../db'
import { getUserFromRequest, getUsersByIds } from '../lib/auth'
import {
  clearScopeRules,
  deleteRule,
  getMemberRole,
  getRuleWithScope,
  getScopeById,
  getScopeByPath,
  listScopeRules,
  listScopesWithRules,
  managedDepartmentIds,
  moveScopeRules,
  replaceScopeRules,
  sqlitePermissionRepository,
  updateRuleAccess,
  upsertScopeRule,
} from '../lib/permission-store'
import { getClientActivityForCompany } from '../lib/client-activity'
import { supportsWriteDeniedRecovery } from '../lib/client-version'
import { membersLosingWrite } from '../lib/write-loss'
import {
  applicableRules,
  findGoverningScope,
  FULL_ACCESS_ROLES,
  isSameOrAncestorPath,
  resolveAccess,
  type ScopeRule,
  type SubjectType,
} from '../lib/permissions'
import { queryPushRejections } from '../lib/push-rejections'
import { isValidFolderName, listRepoSubfolders, resolveRepoFolder } from './departments'
import { findPrivateScope } from '../lib/permissions'
import { getPrivateFolder, listPrivateFolders, listPrivateSubfolders } from '../lib/private-folders'

export const permissionRulesRoute = new Hono()

const MAX_PATH_LENGTH = 1024
const MAX_SEGMENT_BYTES = 255

export const READ_RESTRICTION_UNAVAILABLE =
  'Restricting read access is not available yet: every rule lets its subject read. Set canWrite only (read restriction comes in a later update).'

const ROLE_LABELS: Record<string, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー' }

interface Actor {
  userId: string
  role: string
  companyId: string
}

type Ctx = Context

async function authAndAuthorize(c: Ctx): Promise<Actor | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const role = getMemberRole(db, companyId, user.id)
  if (!role) return c.json({ error: 'Company not found or access denied' }, 404)
  return { userId: user.id, role, companyId }
}

/** Normalised folder paths of the departments the actor manages. */
function managedFolders(actor: Actor): string[] {
  const ids = managedDepartmentIds(db, actor.companyId, actor.userId)
  if (ids.length === 0) return []
  const rows = db.prepare(`SELECT id, folder FROM departments WHERE company_id = ?`).all(actor.companyId) as Array<{ id: string; folder: string }>
  const wanted = new Set(ids)
  return rows.filter(r => wanted.has(r.id)).map(r => r.folder.normalize('NFC'))
}

/** May the actor edit rules of the scope at `path`? */
function canEditPath(actor: Actor, path: string): boolean {
  if (FULL_ACCESS_ROLES.has(actor.role)) return true
  if (path === '') return false
  return managedFolders(actor).some(folder => isSameOrAncestorPath(folder, path))
}

/** Owner/admin, or a manager of at least one department. */
function canEditAnything(actor: Actor): boolean {
  return FULL_ACCESS_ROLES.has(actor.role) || managedFolders(actor).length > 0
}

const forbiddenEdit = (c: Ctx) =>
  c.json({ error: 'Only owners, admins and the managers of this department can change its permissions' }, 403)

/**
 * Validate a scope path from a request: '' or '/' is the company root;
 * otherwise repo-relative folder names separated by '/', no leading or
 * trailing slash, no '.' / '..', no hidden folders (their rules are built in:
 * .claude, .personal, …), no control characters. The top-level folder follows
 * the department folder-name rule. Returned in NFC.
 */
export function parseScopePath(raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'path must be a string' }
  if (raw === '' || raw === '/') return { path: '' }
  if (raw.length > MAX_PATH_LENGTH) return { error: 'path is too long' }
  if (raw.startsWith('/') || raw.endsWith('/')) return { error: 'path must be relative to the company folder, without leading or trailing slashes' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return { error: 'path contains invalid characters' }
  const segments = raw.normalize('NFC').split('/')
  for (const s of segments) {
    if (s === '') return { error: 'path must not contain empty segments' }
    if (s === '.' || s === '..') return { error: 'path must not contain . or .. segments' }
    if (s.startsWith('.')) return { error: 'Hidden folders have built-in rules and cannot be given permissions' }
    if (Buffer.byteLength(s, 'utf8') > MAX_SEGMENT_BYTES) return { error: 'A folder name in path is too long' }
  }
  if (!isValidFolderName(segments[0])) return { error: 'Invalid folder name in path' }
  return { path: segments.join('/') }
}

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * canRead must be absent or true, except on a private folder itself
 * (`readRestrictable`), where it may be false; canWrite a boolean.
 */
function parseAccess(body: Record<string, unknown>, readRestrictable = false): { canRead: boolean; canWrite: boolean } | { error: string } {
  if ((body.canRead === false || body.read === false) && !readRestrictable) return { error: READ_RESTRICTION_UNAVAILABLE }
  const read = body.canRead ?? body.read
  if (read !== undefined && typeof read !== 'boolean') return { error: 'canRead must be a boolean when given' }
  const write = body.canWrite ?? body.write
  if (typeof write !== 'boolean') return { error: 'canWrite must be a boolean' }
  return { canRead: read !== false, canWrite: write }
}

/** Where a path is relative to private folders. */
interface PrivatePlace {
  /** The private folder at or above the path. */
  scopeId: string
  scopePath: string
  /** The path IS the private folder (read restriction allowed there). */
  root: boolean
}

function privatePlaceOf(companyId: string, path: string): PrivatePlace | null {
  if (path === '') return null
  const priv = findPrivateScope(listScopesWithRules(db, companyId), path)
  return priv ? { scopeId: priv.id, scopePath: priv.path, root: priv.path === path } : null
}

/** Does the folder exist — in the company repository, or inside its private folder's repository? */
async function folderExists(companyId: string, path: string, place: PrivatePlace | null): Promise<boolean> {
  if (path === '') return true
  if (!place) return (await resolveRepoFolder(companyId, path)) !== null
  if (place.root) return true
  const folder = getPrivateFolder(db, companyId, place.scopeId)
  return !!folder && (await listPrivateSubfolders(companyId, folder, path)) !== null
}

/** A move must not involve a private folder (or anything inside / around one). */
function touchesPrivate(companyId: string, path: string): boolean {
  return listScopesWithRules(db, companyId).some(s => s.repoId !== null && (isSameOrAncestorPath(path, s.path) || isSameOrAncestorPath(s.path, path)))
}

const PRIVATE_RULES_REQUIRED = 'A private folder always keeps its own rules (who can see it); change them instead'

const FULL_ACCESS_SUBJECT =
  'Owners and admins can always read and edit everything; a rule for them would have no effect'

function parseSubject(actor: Actor, body: Record<string, unknown>): { subjectType: SubjectType; subjectId: string | null } | { error: string } {
  const type = body.subjectType
  const id = body.subjectId ?? null
  if (type === 'everyone') {
    if (id !== null) return { error: 'subjectId must be empty for everyone' }
    return { subjectType: 'everyone', subjectId: null }
  }
  if (type === 'role') {
    if (id === 'owner' || id === 'admin') return { error: FULL_ACCESS_SUBJECT }
    if (id !== 'member') return { error: 'Unknown role' }
    return { subjectType: 'role', subjectId: 'member' }
  }
  if (type === 'user') {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return { error: 'subjectId must be a user ID' }
    const role = getMemberRole(db, actor.companyId, id)
    if (!role) return { error: 'Not a member of this company' }
    if (FULL_ACCESS_ROLES.has(role)) return { error: FULL_ACCESS_SUBJECT }
    return { subjectType: 'user', subjectId: id }
  }
  return { error: 'subjectType must be everyone, role or user' }
}

function serializeRules(rules: ScopeRule[]) {
  const users = getUsersByIds(rules.filter(r => r.subjectType === 'user' && r.subjectId).map(r => r.subjectId!))
  return rules.map(r => ({
    id: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    subjectLabel: subjectLabel(r, users),
    canRead: r.canRead,
    canWrite: r.canWrite,
  }))
}

function subjectLabel(r: Pick<ScopeRule, 'subjectType' | 'subjectId'>, users: Map<string, { name: string | null; email: string }>): string {
  if (r.subjectType === 'everyone') return '全員'
  if (r.subjectType === 'role') return ROLE_LABELS[r.subjectId ?? ''] ?? r.subjectId ?? ''
  const u = r.subjectId ? users.get(r.subjectId) : undefined
  return u?.name || u?.email || r.subjectId || ''
}

function scopeResponse(c: Ctx, scopeId: string, status: 200 | 201 = 200) {
  const scope = getScopeById(db, c.req.param('companyId')!, scopeId)
  const rules = scope ? listScopeRules(db, scope.id) : []
  return c.json({
    success: true,
    data: {
      scope: scope ? { id: scope.id, path: scope.path, kind: scope.kind, inherited: rules.length === 0 } : null,
      rules: serializeRules(rules),
    },
  }, status)
}

// ----------------------------------------------------------------------------
// Outdated-app guard (see the module comment)
// ----------------------------------------------------------------------------

export const OUTDATED_CLIENTS_ERROR =
  'Some members who would lose edit access use a desktop app that cannot recover from a write restriction; ask them to update the app first'

export interface OutdatedMember {
  userId: string
  name: string | null
  email: string | null
  role: string
  clientVersion: string | null
  /** clientVersion, or 不明 when unknown. */
  version: string
  lastSeenAt: string | null
}

class OutdatedClientsBlock extends Error {
  constructor(readonly members: OutdatedMember[]) {
    super('OUTDATED_CLIENTS')
  }
}

function latestOf(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null
  for (const v of values) if (v && (!best || v > best)) best = v
  return best
}

/**
 * `force` from the body or the query string. A manager may not override.
 * Returns a Response to send when the request must be refused.
 */
function parseForce(c: Ctx, actor: Actor, body: Record<string, unknown> | null): boolean | Response {
  const q = c.req.query('force')
  const force = body?.force === true || q === 'true' || q === '1'
  if (force && !FULL_ACCESS_ROLES.has(actor.role)) {
    return c.json({ error: 'Only owners and admins can save despite outdated apps', code: 'FORCE_NOT_ALLOWED' }, 403)
  }
  return force
}

/**
 * Run `mutate` in a transaction and keep it only when nobody who loses write
 * access under `roots` is on an app that cannot recover from [WRITE_DENIED]
 * (or `force`). Otherwise roll back and answer 409 OUTDATED_CLIENTS.
 */
function guardWrite<T>(c: Ctx, actor: Actor, force: boolean, roots: string[], mutate: () => T): T | Response {
  const companyId = actor.companyId
  try {
    return db.transaction(() => {
      const before = listScopesWithRules(db, companyId)
      const result = mutate()
      if (force) return result
      const members = (db.prepare(`SELECT user_id, role FROM memberships WHERE company_id = ? ORDER BY created_at ASC`)
        .all(companyId) as Array<{ user_id: string; role: string }>).map(m => ({ userId: m.user_id, role: m.role }))
      const losing = membersLosingWrite(companyId, members, before, listScopesWithRules(db, companyId), roots)
      if (losing.length === 0) return result
      const activity = getClientActivityForCompany(companyId)
      const blocked = losing.filter(id => !supportsWriteDeniedRecovery(activity.get(id)?.client_version))
      if (blocked.length === 0) return result
      const users = getUsersByIds(blocked)
      const roleOf = new Map(members.map(m => [m.userId, m.role]))
      throw new OutdatedClientsBlock(blocked.map(id => {
        const a = activity.get(id)
        return {
          userId: id,
          name: users.get(id)?.name ?? null,
          email: users.get(id)?.email ?? null,
          role: roleOf.get(id) ?? 'member',
          clientVersion: a?.client_version ?? null,
          version: a?.client_version ?? '不明',
          lastSeenAt: latestOf(a?.last_seen_at, a?.last_fetch_at, a?.last_push_at),
        }
      }))
    })()
  } catch (err) {
    if (!(err instanceof OutdatedClientsBlock)) throw err
    return c.json({
      error: OUTDATED_CLIENTS_ERROR,
      code: 'OUTDATED_CLIENTS',
      members: err.members,
      canForce: FULL_ACCESS_ROLES.has(actor.role),
    }, 409)
  }
}

const MAX_RULES_PER_SCOPE = 200

const replaceError = (c: Ctx, error: string, code?: string) => c.json({ error, ...(code ? { code } : {}) }, 400)

// PUT /permissions/scopes/by-path  { path, rules: [{ subjectType, subjectId?, canWrite, canRead? }] }
// Replaces the path's whole rule set in one transaction. [] = inherit again.
permissionRulesRoute.put('/permissions/scopes/by-path', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = parseScopePath(body.path)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!canEditPath(actor, parsed.path)) return forbiddenEdit(c)
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force

  if (!Array.isArray(body.rules)) return replaceError(c, 'rules must be an array')
  if (body.rules.length > MAX_RULES_PER_SCOPE) return replaceError(c, `At most ${MAX_RULES_PER_SCOPE} rules per folder`)
  const place = privatePlaceOf(actor.companyId, parsed.path)
  const rules: Array<Omit<ScopeRule, 'id'>> = []
  const seen = new Set<string>()
  for (const item of body.rules as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return replaceError(c, 'Each rule must be an object')
    const raw = item as Record<string, unknown>
    const access = parseAccess(raw, place?.root === true)
    if ('error' in access) return replaceError(c, access.error, access.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined)
    const subject = parseSubject(actor, raw)
    if ('error' in subject) return replaceError(c, subject.error)
    const key = `${subject.subjectType}:${subject.subjectId ?? ''}`
    if (seen.has(key)) return replaceError(c, 'Each subject may appear only once', 'DUPLICATE_SUBJECT')
    seen.add(key)
    rules.push({ ...subject, canRead: access.canRead, canWrite: access.canWrite })
  }
  if (rules.length === 0 && place?.root) return replaceError(c, PRIVATE_RULES_REQUIRED, 'PRIVATE_RULES_REQUIRED')
  if (rules.length === 0 && parsed.path === '') {
    return replaceError(c, 'The company-wide rules cannot be removed; change them instead', 'COMPANY_RULE_REQUIRED')
  }
  if (rules.length > 0 && !rules.some(r => r.subjectType === 'everyone')) {
    return replaceError(c, 'A folder with its own rules needs a rule for everyone (it is what lets everyone else read)', 'EVERYONE_RULE_REQUIRED')
  }

  if (!(await folderExists(actor.companyId, parsed.path, place))) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }

  const scope = place
    ? replaceScopeRules(db, actor.companyId, parsed.path, rules, actor.userId)
    : guardWrite(c, actor, force, [parsed.path], () => replaceScopeRules(db, actor.companyId, parsed.path, rules, actor.userId))
  if (scope instanceof Response) return scope
  if (!scope) return c.json({ success: true, data: { scope: null, rules: [] } })
  return scopeResponse(c, scope.id)
})

// POST /permissions/rules  { path, subjectType, subjectId?, canWrite, canRead? }
permissionRulesRoute.post('/permissions/rules', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = parseScopePath(body.path)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!canEditPath(actor, parsed.path)) return forbiddenEdit(c)
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force
  const place = privatePlaceOf(actor.companyId, parsed.path)
  const access = parseAccess(body, place?.root === true)
  if ('error' in access) return c.json({ error: access.error, code: access.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined }, 400)
  const subject = parseSubject(actor, body)
  if ('error' in subject) return c.json({ error: subject.error }, 400)

  if (!(await folderExists(actor.companyId, parsed.path, place))) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }

  const upsert = () => upsertScopeRule(db, actor.companyId, parsed.path, { ...subject, canRead: access.canRead, canWrite: access.canWrite }, actor.userId)
  const result = place ? upsert() : guardWrite(c, actor, force, [parsed.path], upsert)
  if (result instanceof Response) return result
  return scopeResponse(c, result.scope.id, result.created ? 201 : 200)
})

// PATCH /permissions/rules/:ruleId  { canWrite, canRead? }
permissionRulesRoute.patch('/permissions/rules/:ruleId', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)
  const found = getRuleWithScope(db, actor.companyId, c.req.param('ruleId'))
  if (!found) return c.json({ error: 'Rule not found' }, 404)
  if (!canEditPath(actor, found.scope.path)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force
  const place = privatePlaceOf(actor.companyId, found.scope.path)
  const access = parseAccess(body, place?.root === true)
  if ('error' in access) return c.json({ error: access.error, code: access.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined }, 400)

  const update = () => {
    updateRuleAccess(db, found.rule.id, access.canRead, access.canWrite)
    return true
  }
  const done = place ? update() : guardWrite(c, actor, force, [found.scope.path], update)
  if (done instanceof Response) return done
  return scopeResponse(c, found.scope.id)
})

// DELETE /permissions/rules/:ruleId
permissionRulesRoute.delete('/permissions/rules/:ruleId', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)
  const found = getRuleWithScope(db, actor.companyId, c.req.param('ruleId'))
  if (!found) return c.json({ error: 'Rule not found' }, 404)
  if (!canEditPath(actor, found.scope.path)) return forbiddenEdit(c)
  const force = parseForce(c, actor, await readJson(c))
  if (force instanceof Response) return force

  const rules = listScopeRules(db, found.scope.id)
  const place = privatePlaceOf(actor.companyId, found.scope.path)
  if (rules.length === 1) {
    if (found.scope.path === '') {
      return c.json({ error: 'The company-wide rule cannot be removed; change it instead' }, 400)
    }
    if (place?.root) return c.json({ error: PRIVATE_RULES_REQUIRED, code: 'PRIVATE_RULES_REQUIRED' }, 400)
  } else if (found.rule.subjectType === 'everyone' && !rules.some(r => r.id !== found.rule.id && r.subjectType === 'everyone')) {
    return c.json({
      error: 'The rule for everyone cannot be removed while other rules exist here (it is what lets everyone else read). Change it, or reset the folder to inherit.',
    }, 400)
  }

  const remove = () => {
    deleteRule(db, found.rule.id, found.scope)
    return true
  }
  const done = place ? remove() : guardWrite(c, actor, force, [found.scope.path], remove)
  if (done instanceof Response) return done
  return scopeResponse(c, found.scope.id)
})

// DELETE /permissions/scopes/:scopeId/rules — inherit from the parent again
permissionRulesRoute.delete('/permissions/scopes/:scopeId/rules', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)
  const scope = getScopeById(db, actor.companyId, c.req.param('scopeId'))
  if (!scope) return c.json({ error: 'Scope not found' }, 404)
  if (!canEditPath(actor, scope.path)) return forbiddenEdit(c)
  if (scope.path === '') return c.json({ error: 'The company-wide rule cannot be removed; change it instead' }, 400)
  const place = privatePlaceOf(actor.companyId, scope.path)
  if (place?.root) return c.json({ error: PRIVATE_RULES_REQUIRED, code: 'PRIVATE_RULES_REQUIRED' }, 400)
  const force = parseForce(c, actor, await readJson(c))
  if (force instanceof Response) return force

  const removed = place ? clearScopeRules(db, scope) : guardWrite(c, actor, force, [scope.path], () => clearScopeRules(db, scope))
  if (removed instanceof Response) return removed
  return c.json({ success: true, data: { removed } })
})

// POST /permissions/scopes/:scopeId/move  { toPath, force? }
// Move the rules of a folder (and of the folders inside it) to another
// existing folder that has no rules yet. For rules left behind when a folder
// was renamed by a sync push (GET /permissions → orphanedScopes).
permissionRulesRoute.post('/permissions/scopes/:scopeId/move', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)
  const scope = getScopeById(db, actor.companyId, c.req.param('scopeId'))
  if (!scope) return c.json({ error: 'Scope not found' }, 404)
  if (scope.path === '') return c.json({ error: 'The company-wide rules cannot be moved' }, 400)
  if (!canEditPath(actor, scope.path)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = parseScopePath(body.toPath)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (parsed.path === '') return c.json({ error: 'Rules cannot be moved to the company root' }, 400)
  if (!canEditPath(actor, parsed.path)) return forbiddenEdit(c)
  if (isSameOrAncestorPath(scope.path, parsed.path) || isSameOrAncestorPath(parsed.path, scope.path)) {
    return c.json({ error: 'Rules cannot be moved into or out of their own folder' }, 400)
  }
  if (touchesPrivate(actor.companyId, scope.path) || touchesPrivate(actor.companyId, parsed.path)) {
    return c.json({ error: 'Rules of or inside a private folder cannot be moved', code: 'PRIVATE_FOLDER' }, 400)
  }
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force

  if ((await resolveRepoFolder(actor.companyId, parsed.path)) === null) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }
  const scopes = listScopesWithRules(db, actor.companyId)
  if (scopes.some(s => isSameOrAncestorPath(parsed.path, s.path) && s.rules.length > 0)) {
    return c.json({ error: 'The destination folder (or a folder inside it) already has rules', code: 'TARGET_HAS_RULES' }, 409)
  }

  const moved = guardWrite(c, actor, force, [scope.path, parsed.path], () =>
    moveScopeRules(db, actor.companyId, scope.path, parsed.path, actor.userId))
  if (moved instanceof Response) return moved
  const dest = getScopeByPath(db, actor.companyId, parsed.path)
  return c.json({ success: true, data: { moved, toPath: parsed.path, scopeId: dest?.id ?? null } })
})

// GET /permissions/effective?path=
permissionRulesRoute.get('/permissions/effective', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)
  const parsed = parseScopePath(c.req.query('path') ?? '')
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!canEditPath(actor, parsed.path)) return forbiddenEdit(c)

  const companyId = actor.companyId
  const scopes = listScopesWithRules(db, companyId)
  const governing = findGoverningScope(scopes, parsed.path)
  const repo = sqlitePermissionRepository(db)
  const memberships = db.prepare(`SELECT user_id, role FROM memberships WHERE company_id = ? ORDER BY created_at ASC`)
    .all(companyId) as Array<{ user_id: string; role: string }>
  const users = getUsersByIds([
    ...new Set([...memberships.map(m => m.user_id), ...(governing?.rules ?? []).filter(r => r.subjectType === 'user' && r.subjectId).map(r => r.subjectId!)]),
  ])

  const members = memberships.map(m => {
    const access = resolveAccess(companyId, m.user_id, parsed.path, repo)
    const decided = access.source.reason === 'role' || !governing ? [] : applicableRules(governing.rules, m.user_id, m.role)
    const u = users.get(m.user_id)
    return {
      userId: m.user_id,
      name: u?.name ?? null,
      email: u?.email ?? null,
      role: m.role,
      read: access.read,
      write: access.write,
      reason: access.source.reason,
      decidedBy: decided.length === 0 ? null : {
        scopeId: governing!.id,
        path: governing!.path,
        subjectType: decided[0].subjectType,
        subjectLabel: subjectLabel(decided[0], users),
      },
    }
  })

  return c.json({
    success: true,
    data: {
      path: parsed.path,
      governingScope: governing ? { id: governing.id, path: governing.path, inherited: governing.path !== parsed.path } : null,
      // Read restriction is real only for private folders (their own repository).
      readRestrictionEnforced: privatePlaceOf(companyId, parsed.path) !== null,
      members,
    },
  })
})

// GET /permissions/folders?path=
permissionRulesRoute.get('/permissions/folders', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!canEditAnything(actor)) return forbiddenEdit(c)
  const parsed = parseScopePath(c.req.query('path') ?? '')
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!canEditPath(actor, parsed.path)) return forbiddenEdit(c)

  // Inside a private folder: its own repository. Elsewhere: the company
  // repository, plus the private folders directly under the path — only
  // those the actor may edit rules of (canEditPath), so a manager never sees
  // another department's private folder names.
  const place = privatePlaceOf(actor.companyId, parsed.path)
  const privateFolder = place ? getPrivateFolder(db, actor.companyId, place.scopeId) : null
  let names = privateFolder
    ? await listPrivateSubfolders(actor.companyId, privateFolder, parsed.path)
    : await listRepoSubfolders(actor.companyId, parsed.path)
  if (names === null) return c.json({ error: 'Folder not found in the company repository' }, 404)
  if (!place) {
    const depth = parsed.path === '' ? 1 : parsed.path.split('/').length + 1
    const privateChildren = listPrivateFolders(db, actor.companyId)
      .map(p => p.scope.path)
      .filter(p => p.split('/').length === depth && isSameOrAncestorPath(parsed.path, p) && canEditPath(actor, p))
      .map(p => p.split('/').pop()!)
    names = [...new Set([...names, ...privateChildren])].sort((a, b) => a.localeCompare(b, 'ja'))
  }
  const scoped = new Map(listScopesWithRules(db, actor.companyId).map(s => [s.path, s]))
  return c.json({
    success: true,
    data: {
      path: parsed.path,
      folders: names
        .filter(name => isValidFolderName(name) || parsed.path !== '')
        .map(name => {
          const path = parsed.path ? `${parsed.path}/${name}` : name
          const scope = scoped.get(path)
          return { name, path, scopeId: scope?.id ?? null, hasRules: (scope?.rules.length ?? 0) > 0, private: scope?.repoId != null }
        }),
    },
  })
})

const MAX_REJECTIONS_PAGE = 100

// GET /push-rejections?userId=&marker=&limit=&offset=  (owner/admin)
permissionRulesRoute.get('/push-rejections', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!FULL_ACCESS_ROLES.has(actor.role)) {
    return c.json({ error: 'Only owners and admins can view rejected pushes' }, 403)
  }
  const userId = c.req.query('userId') || undefined
  const marker = c.req.query('marker') || undefined
  if (marker !== undefined && !/^[A-Z][A-Z0-9_]{1,63}$/.test(marker)) return c.json({ error: 'Invalid marker' }, 400)
  const limit = Number(c.req.query('limit') ?? 50)
  const offset = Number(c.req.query('offset') ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REJECTIONS_PAGE) return c.json({ error: `limit must be 1-${MAX_REJECTIONS_PAGE}` }, 400)
  if (!Number.isInteger(offset) || offset < 0) return c.json({ error: 'offset must be a non-negative integer' }, 400)

  const { rows, total } = queryPushRejections(actor.companyId, { userId, marker, limit, offset })
  const markers = (db.prepare(`SELECT DISTINCT marker FROM push_rejections WHERE company_id = ? ORDER BY marker`)
    .all(actor.companyId) as Array<{ marker: string }>).map(r => r.marker)
  const users = getUsersByIds([...new Set(rows.map(r => r.userId))])
  return c.json({
    success: true,
    data: {
      total,
      markers,
      rejections: rows.map(r => ({
        ...r,
        name: users.get(r.userId)?.name ?? null,
        email: users.get(r.userId)?.email ?? null,
      })),
    },
  })
})
