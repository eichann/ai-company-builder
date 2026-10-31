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
 *   always read and write everywhere (shared/core/permissions.ts), so such a rule
 *   would only mislead. That is also why no edit can lock the company out.
 * - A scope with its own rules always keeps a rule for everyone: the PUT
 *   refuses a non-empty set without one (EVERYONE_RULE_REQUIRED); with the
 *   per-rule endpoints the first rule on an inheriting scope copies the
 *   inherited rules in (breakInheritance in adapters/sqlite/permission-store.ts), and the
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
 *          (adapters/orphaned-scopes.ts). Same authorization as editing, for both
 *          the old and the new place.
 *
 * Audit: there is no audit log in this codebase yet; rule rows keep
 * created_at / created_by.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import type { ScopeRule } from '../../shared/core/permissions'
import { isSameOrAncestorPath } from '../../shared/core/permissions'
import { parseScopePath } from '../../shared/core/names'
import { services } from '../composition'
import { hasFullAccess, requireFullAccess, type Member } from '../services/access'
import {
  OUTDATED_CLIENTS_ERROR,
  PRIVATE_RULES_REQUIRED,
  PRIVATE_SUBJECT_ERROR,
  READ_RESTRICTION_UNAVAILABLE,
  parseAccess,
  privateRootRuleError,
} from '../services/permission-editor'
import { refusal } from './respond'

export { OUTDATED_CLIENTS_ERROR, PRIVATE_SUBJECT_ERROR, READ_RESTRICTION_UNAVAILABLE }

export const permissionRulesRoute = new Hono()
const { access, permissionEditor: editor } = services

type Ctx = Context

async function authAndAuthorize(c: Ctx): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const member = access.memberOf(companyId, user.id)
  if (!member) return c.json({ error: 'Company not found or access denied' }, 404)
  return member
}

const forbiddenEdit = (c: Ctx) =>
  c.json({ error: 'Only owners, admins and the managers of this department can change its permissions' }, 403)

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

function scopeResponse(c: Ctx, scopeId: string, status: 200 | 201 = 200) {
  return c.json({ success: true, data: editor.scopeView(c.req.param('companyId')!, scopeId) }, status)
}

/**
 * `force` from the body or the query string. A manager may not override.
 * Returns a Response to send when the request must be refused.
 */
function parseForce(c: Ctx, actor: Member, body: Record<string, unknown> | null): boolean | Response {
  const q = c.req.query('force')
  const force = body?.force === true || q === 'true' || q === '1'
  if (force && !hasFullAccess(actor.role)) {
    return c.json({ error: 'Only owners and admins can save despite outdated apps', code: 'FORCE_NOT_ALLOWED' }, 403)
  }
  return force
}

/** A guarded write's 409 OUTDATED_CLIENTS as a Response, else its value. */
function guarded<T>(c: Ctx, actor: Member, force: boolean, roots: string[], mutate: () => T): T | Response {
  const outcome = editor.guardWrite(actor, force, roots, mutate)
  return outcome.ok ? outcome.value : refusal(c, outcome)
}

const MAX_RULES_PER_SCOPE = 200

const replaceError = (c: Ctx, error: string, code?: string) => c.json({ error, ...(code ? { code } : {}) }, 400)

// PUT /permissions/scopes/by-path  { path, rules: [{ subjectType, subjectId?, canWrite, canRead? }] }
// Replaces the path's whole rule set in one transaction. [] = inherit again.
permissionRulesRoute.put('/permissions/scopes/by-path', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = parseScopePath(body.path)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!editor.canEditPath(actor, parsed.path)) return forbiddenEdit(c)
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force

  if (!Array.isArray(body.rules)) return replaceError(c, 'rules must be an array')
  if (body.rules.length > MAX_RULES_PER_SCOPE) return replaceError(c, `At most ${MAX_RULES_PER_SCOPE} rules per folder`)
  const place = editor.privatePlaceOf(actor.companyId, parsed.path)
  const rules: Array<Omit<ScopeRule, 'id'>> = []
  const seen = new Set<string>()
  for (const item of body.rules as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return replaceError(c, 'Each rule must be an object')
    const raw = item as Record<string, unknown>
    const ruleAccess = parseAccess(raw, place?.root === true)
    if ('error' in ruleAccess) return replaceError(c, ruleAccess.error, ruleAccess.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined)
    const subject = editor.parseSubject(actor, raw)
    if ('error' in subject) return replaceError(c, subject.error)
    const key = `${subject.subjectType}:${subject.subjectId ?? ''}`
    if (seen.has(key)) return replaceError(c, 'Each subject may appear only once', 'DUPLICATE_SUBJECT')
    seen.add(key)
    const privateError = privateRootRuleError(place, { ...subject, ...ruleAccess })
    if (privateError) return replaceError(c, privateError, 'PRIVATE_FOLDER_RULE')
    rules.push({ ...subject, canRead: ruleAccess.canRead, canWrite: ruleAccess.canWrite })
  }
  if (rules.length === 0 && place?.root) return replaceError(c, PRIVATE_RULES_REQUIRED, 'PRIVATE_RULES_REQUIRED')
  if (rules.length === 0 && parsed.path === '') {
    return replaceError(c, 'The company-wide rules cannot be removed; change them instead', 'COMPANY_RULE_REQUIRED')
  }
  if (rules.length > 0 && !rules.some(r => r.subjectType === 'everyone')) {
    return replaceError(c, 'A folder with its own rules needs a rule for everyone (it is what lets everyone else read)', 'EVERYONE_RULE_REQUIRED')
  }

  if (!(await editor.folderExists(actor.companyId, parsed.path, place))) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }

  const scope = place
    ? editor.replaceRules(actor, parsed.path, rules)
    : guarded(c, actor, force, [parsed.path], () => editor.replaceRules(actor, parsed.path, rules))
  if (scope instanceof Response) return scope
  if (!scope) return c.json({ success: true, data: { scope: null, rules: [] } })
  return scopeResponse(c, scope.id)
})

// POST /permissions/rules  { path, subjectType, subjectId?, canWrite, canRead? }
permissionRulesRoute.post('/permissions/rules', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = parseScopePath(body.path)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!editor.canEditPath(actor, parsed.path)) return forbiddenEdit(c)
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force
  const place = editor.privatePlaceOf(actor.companyId, parsed.path)
  const ruleAccess = parseAccess(body, place?.root === true)
  if ('error' in ruleAccess) return c.json({ error: ruleAccess.error, code: ruleAccess.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined }, 400)
  const subject = editor.parseSubject(actor, body)
  if ('error' in subject) return c.json({ error: subject.error }, 400)
  const privateError = privateRootRuleError(place, { ...subject, ...ruleAccess })
  if (privateError) return c.json({ error: privateError, code: 'PRIVATE_FOLDER_RULE' }, 400)

  if (!(await editor.folderExists(actor.companyId, parsed.path, place))) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }

  const upsert = () => editor.upsertRule(actor, parsed.path, { ...subject, canRead: ruleAccess.canRead, canWrite: ruleAccess.canWrite })
  const result = place ? upsert() : guarded(c, actor, force, [parsed.path], upsert)
  if (result instanceof Response) return result
  return scopeResponse(c, result.scope.id, result.created ? 201 : 200)
})

// PATCH /permissions/rules/:ruleId  { canWrite, canRead? }
permissionRulesRoute.patch('/permissions/rules/:ruleId', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)
  const found = editor.getRule(actor.companyId, c.req.param('ruleId'))
  if (!found) return c.json({ error: 'Rule not found' }, 404)
  if (!editor.canEditPath(actor, found.scope.path)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force
  const place = editor.privatePlaceOf(actor.companyId, found.scope.path)
  const ruleAccess = parseAccess(body, place?.root === true)
  if ('error' in ruleAccess) return c.json({ error: ruleAccess.error, code: ruleAccess.error === READ_RESTRICTION_UNAVAILABLE ? 'READ_RESTRICTION_UNAVAILABLE' : undefined }, 400)
  const privateError = privateRootRuleError(place, { subjectType: found.rule.subjectType, ...ruleAccess })
  if (privateError) return c.json({ error: privateError, code: 'PRIVATE_FOLDER_RULE' }, 400)

  const update = () => {
    editor.updateRuleAccess(found.rule.id, ruleAccess.canRead, ruleAccess.canWrite)
    return true
  }
  const done = place ? update() : guarded(c, actor, force, [found.scope.path], update)
  if (done instanceof Response) return done
  return scopeResponse(c, found.scope.id)
})

// DELETE /permissions/rules/:ruleId
permissionRulesRoute.delete('/permissions/rules/:ruleId', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)
  const found = editor.getRule(actor.companyId, c.req.param('ruleId'))
  if (!found) return c.json({ error: 'Rule not found' }, 404)
  if (!editor.canEditPath(actor, found.scope.path)) return forbiddenEdit(c)
  const force = parseForce(c, actor, await readJson(c))
  if (force instanceof Response) return force

  const rules = editor.rulesOf(found.scope.id)
  const place = editor.privatePlaceOf(actor.companyId, found.scope.path)
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
    editor.deleteRule(found.rule.id, found.scope)
    return true
  }
  const done = place ? remove() : guarded(c, actor, force, [found.scope.path], remove)
  if (done instanceof Response) return done
  return scopeResponse(c, found.scope.id)
})

// DELETE /permissions/scopes/:scopeId/rules — inherit from the parent again
permissionRulesRoute.delete('/permissions/scopes/:scopeId/rules', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)
  const scope = editor.getScope(actor.companyId, c.req.param('scopeId'))
  if (!scope) return c.json({ error: 'Scope not found' }, 404)
  if (!editor.canEditPath(actor, scope.path)) return forbiddenEdit(c)
  if (scope.path === '') return c.json({ error: 'The company-wide rule cannot be removed; change it instead' }, 400)
  const place = editor.privatePlaceOf(actor.companyId, scope.path)
  if (place?.root) return c.json({ error: PRIVATE_RULES_REQUIRED, code: 'PRIVATE_RULES_REQUIRED' }, 400)
  const force = parseForce(c, actor, await readJson(c))
  if (force instanceof Response) return force

  const removed = place ? editor.clearRules(scope) : guarded(c, actor, force, [scope.path], () => editor.clearRules(scope))
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
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)
  const scope = editor.getScope(actor.companyId, c.req.param('scopeId'))
  if (!scope) return c.json({ error: 'Scope not found' }, 404)
  if (scope.path === '') return c.json({ error: 'The company-wide rules cannot be moved' }, 400)
  if (!editor.canEditPath(actor, scope.path)) return forbiddenEdit(c)

  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = parseScopePath(body.toPath)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (parsed.path === '') return c.json({ error: 'Rules cannot be moved to the company root' }, 400)
  if (!editor.canEditPath(actor, parsed.path)) return forbiddenEdit(c)
  if (isSameOrAncestorPath(scope.path, parsed.path) || isSameOrAncestorPath(parsed.path, scope.path)) {
    return c.json({ error: 'Rules cannot be moved into or out of their own folder' }, 400)
  }
  if (editor.touchesPrivate(actor.companyId, scope.path) || editor.touchesPrivate(actor.companyId, parsed.path)) {
    return c.json({ error: 'Rules of or inside a private folder cannot be moved', code: 'PRIVATE_FOLDER' }, 400)
  }
  const force = parseForce(c, actor, body)
  if (force instanceof Response) return force

  if (!(await editor.folderExists(actor.companyId, parsed.path, null))) {
    return c.json({ error: 'Folder not found in the company repository' }, 400)
  }
  if (editor.hasRulesAtOrBelow(actor.companyId, parsed.path)) {
    return c.json({ error: 'The destination folder (or a folder inside it) already has rules', code: 'TARGET_HAS_RULES' }, 409)
  }

  const moved = guarded(c, actor, force, [scope.path, parsed.path], () =>
    editor.moveRules(actor, scope.path, parsed.path))
  if (moved instanceof Response) return moved
  const dest = editor.getScopeByPath(actor.companyId, parsed.path)
  return c.json({ success: true, data: { moved, toPath: parsed.path, scopeId: dest?.id ?? null } })
})

// GET /permissions/effective?path=
permissionRulesRoute.get('/permissions/effective', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)
  const parsed = parseScopePath(c.req.query('path') ?? '')
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!editor.canEditPath(actor, parsed.path)) return forbiddenEdit(c)

  return c.json({ success: true, data: editor.effective(actor.companyId, parsed.path) })
})

// GET /permissions/folders?path=
permissionRulesRoute.get('/permissions/folders', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!editor.canEditAnything(actor)) return forbiddenEdit(c)
  const parsed = parseScopePath(c.req.query('path') ?? '')
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!editor.canEditPath(actor, parsed.path)) return forbiddenEdit(c)

  const folders = await editor.folders(actor, parsed.path)
  if (folders === null) return c.json({ error: 'Folder not found in the company repository' }, 404)
  return c.json({ success: true, data: folders })
})

const MAX_REJECTIONS_PAGE = 100

// GET /push-rejections?userId=&marker=&limit=&offset=  (owner/admin)
permissionRulesRoute.get('/push-rejections', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const actor = requireFullAccess(member, 'Only owners and admins can view rejected pushes')
  if (!actor.ok) return refusal(c, actor)
  const userId = c.req.query('userId') || undefined
  const marker = c.req.query('marker') || undefined
  if (marker !== undefined && !/^[A-Z][A-Z0-9_]{1,63}$/.test(marker)) return c.json({ error: 'Invalid marker' }, 400)
  const limit = Number(c.req.query('limit') ?? 50)
  const offset = Number(c.req.query('offset') ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REJECTIONS_PAGE) return c.json({ error: `limit must be 1-${MAX_REJECTIONS_PAGE}` }, 400)
  if (!Number.isInteger(offset) || offset < 0) return c.json({ error: 'offset must be a non-negative integer' }, 400)

  return c.json({ success: true, data: editor.rejections(member.companyId, { userId, marker, limit, offset }) })
})
