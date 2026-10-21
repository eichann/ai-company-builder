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
 * What may be stored in Phase 2:
 * - write: true/false per subject (everyone / the member role / one user);
 * - read is always true. Read restriction arrives with Phase 3 (carve-out of
 *   private folders), so `read: false` is refused with 400 instead of being
 *   stored and silently not enforced.
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
  listScopeRules,
  listScopesWithRules,
  managedDepartmentIds,
  replaceScopeRules,
  sqlitePermissionRepository,
  updateRuleAccess,
  upsertScopeRule,
} from '../lib/permission-store'
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

/** canRead must be absent or true in Phase 2; canWrite a boolean. */
function parseAccess(body: Record<string, unknown>): { canWrite: boolean } | { error: string } {
  if (body.canRead === false || body.read === false) return { error: READ_RESTRICTION_UNAVAILABLE }
  if (body.canRead !== undefined && body.canRead !== true) return { error: 'canRead must be true when given' }
  const write = body.canWrite ?? body.write
  if (typeof write !== 'boolean') return { error: 'canWrite must be a boolean' }
  return { canWrite: write }
}

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

  if (!Array.isArray(body.rules)) return replaceError(c, 'rules must be an array')
  if (body.rules.length > MAX_RULES_PER_SCOPE) return replaceError(c, `At most ${MAX_RULES_PER_SCOPE} rules per folder`)
  const rules: Array<Omit<ScopeRule, 'id'>> = []
  const seen = new Set<string>()
  for (const item of body.rules as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return replaceError(c, 'Each rule must be an object')
    const raw = item as Record<string, unknown>
    const access = parseAccess(raw)
    if ('error' in access) return replaceError(c, access.error, access.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined)
    const subject = parseSubject(actor, raw)
    if ('error' in subject) return replaceError(c, subject.error)
    const key = `${subject.subjectType}:${subject.subjectId ?? ''}`
    if (seen.has(key)) return replaceError(c, 'Each subject may appear only once', 'DUPLICATE_SUBJECT')
    seen.add(key)
    rules.push({ ...subject, canRead: true, canWrite: access.canWrite })
  }
  if (rules.length === 0 && parsed.path === '') {
    return replaceError(c, 'The company-wide rules cannot be removed; change them instead', 'COMPANY_RULE_REQUIRED')
  }
  if (rules.length > 0 && !rules.some(r => r.subjectType === 'everyone')) {
    return replaceError(c, 'A folder with its own rules needs a rule for everyone (it is what lets everyone else read)', 'EVERYONE_RULE_REQUIRED')
  }

  if (parsed.path !== '' && (await resolveRepoFolder(actor.companyId, parsed.path)) === null) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }

  const scope = replaceScopeRules(db, actor.companyId, parsed.path, rules, actor.userId)
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
  const access = parseAccess(body)
  if ('error' in access) return c.json({ error: access.error, code: access.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined }, 400)
  const subject = parseSubject(actor, body)
  if ('error' in subject) return c.json({ error: subject.error }, 400)

  if (parsed.path !== '' && (await resolveRepoFolder(actor.companyId, parsed.path)) === null) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }

  const { scope, created } = upsertScopeRule(db, actor.companyId, parsed.path, { ...subject, canRead: true, canWrite: access.canWrite }, actor.userId)
  return scopeResponse(c, scope.id, created ? 201 : 200)
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
  const access = parseAccess(body)
  if ('error' in access) return c.json({ error: access.error, code: access.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined }, 400)

  updateRuleAccess(db, found.rule.id, true, access.canWrite)
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

  const rules = listScopeRules(db, found.scope.id)
  if (rules.length === 1) {
    if (found.scope.path === '') {
      return c.json({ error: 'The company-wide rule cannot be removed; change it instead' }, 400)
    }
  } else if (found.rule.subjectType === 'everyone' && !rules.some(r => r.id !== found.rule.id && r.subjectType === 'everyone')) {
    return c.json({
      error: 'The rule for everyone cannot be removed while other rules exist here (it is what lets everyone else read). Change it, or reset the folder to inherit.',
    }, 400)
  }

  deleteRule(db, found.rule.id, found.scope)
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

  const removed = clearScopeRules(db, scope)
  return c.json({ success: true, data: { removed } })
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
      readRestrictionEnforced: false,
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

  const names = await listRepoSubfolders(actor.companyId, parsed.path)
  if (names === null) return c.json({ error: 'Folder not found in the company repository' }, 404)
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
          return { name, path, scopeId: scope?.id ?? null, hasRules: (scope?.rules.length ?? 0) > 0 }
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
