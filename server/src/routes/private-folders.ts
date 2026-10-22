/**
 * Private folders API (permission plan stage 3a). Mounted at
 * /api/companies/:companyId. Shapes: shared/types/private-folders.ts.
 *
 *   POST /private-folders                         create (owner/admin anywhere;
 *                                                 a department manager inside
 *                                                 their own department)
 *   GET  /private-folders                         list with viewer counts
 *                                                 (owner/admin: all; managers:
 *                                                 their departments' ones)
 *   GET  /private-folders/:scopeId                one, with who can read/edit
 *   PUT  /private-folders/:scopeId/members        replace viewers / editors
 *   POST /private-folders/:scopeId/make-public    公開に戻す (owner/admin)
 *   DELETE /private-folders/:scopeId?confirm=     delete (owner/admin, type
 *                                                 the name; archived first)
 *   POST /paths/check                             any member: may I put
 *                                                 something at these paths?
 *   GET  /me/private-folders                      any member: the private
 *                                                 folders they may read, with
 *                                                 who else can (app lock icons)
 *   GET  /me/scopes                               any member: the private
 *                                                 folders they may read (+ clone
 *                                                 URL) — nothing about the
 *                                                 others
 *
 * Names never reach members who may not read a folder: anything that is not
 * theirs to see answers exactly as if nothing were there (404 for a scope
 * id, PARENT_NOT_FOUND for a parent path, FOLDER_NAME_UNAVAILABLE with the
 * path the caller typed for a taken name — the same answer as for a public
 * folder that already exists).
 *
 * Only humans create private folders, through the admin panel or the desktop
 * app's dialog; there is deliberately no MCP/tool for the chat AI.
 *
 * Version gate: the company's FIRST private folder is refused (409
 * OUTDATED_CLIENTS, same shape as the write-restriction guard) while any
 * member's app cannot handle private folders (lib/client-version.ts
 * supportsPrivateFolders; unknown = not ready). An owner/admin may pass
 * `force: true`; a manager gets 403 FORCE_NOT_ALLOWED. While no released app
 * handles them at all (PRIVATE_FOLDERS_CLIENT_COMMIT_DATE null), creation is
 * refused outright — 409 PRIVATE_FOLDERS_UNAVAILABLE, force or not.
 */
import { createHash } from 'crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from '../db'
import { getUserFromRequest, getUsersByIds } from '../lib/auth'
import { getClientActivityForCompany } from '../lib/client-activity'
import { privateFoldersClientCutoff, supportsPrivateFolders } from '../lib/client-version'
import { getMemberRole, listDepartmentManagerIds, listScopesWithRules, managedDepartmentIds } from '../lib/permission-store'
import { FULL_ACCESS_ROLES, findPrivateScope, isSameOrAncestorPath, type ScopeWithRules } from '../lib/permissions'
import {
  createPrivateFolder,
  folderAccess,
  getPrivateFolder,
  listPrivateFolders,
  makePrivateFolderPublic,
  MakePublicError,
  PathUnavailableError,
  readablePrivateFolders,
  replacePrivateFolderRules,
  canWriteInPrivateFolder,
  deletePrivateFolder,
  isPathUsable,
  type PrivateFolderRecord,
} from '../lib/private-folders'
import { isValidFolderName, resolveRepoFolder, withCompanyLock } from './departments'
import { parseScopePath, type OutdatedMember } from './permission-rules'
import {
  MY_PRIVATE_FOLDER_VIEWERS_LIMIT,
  PATHS_CHECK_MAX_PATHS,
  PATHS_CHECK_PATHS_PER_MINUTE,
  PRIVATE_FOLDERS_UNAVAILABLE_MESSAGE,
  normalizeReservedPath,
  reservedPathMessage,
  type DeletePrivateFolderResult,
  type MyPrivateFolder,
  type PathCheckResponse,
  type MyScopesResponse,
  type PrivateFolderDetail,
  type PrivateFolderSummary,
} from '../../shared/types/private-folders'

export const privateFoldersRoute = new Hono()

type Ctx = Context

interface Actor {
  userId: string
  role: string
  companyId: string
}

const MAX_MEMBERS = 500

async function authAndAuthorize(c: Ctx): Promise<Actor | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const role = getMemberRole(db, companyId, user.id)
  if (!role) return c.json({ error: 'Company not found or access denied' }, 404)
  return { userId: user.id, role, companyId }
}

interface DepartmentFolder { id: string; folder: string }

function departmentFolders(companyId: string): DepartmentFolder[] {
  return (db.prepare(`SELECT id, folder FROM departments WHERE company_id = ?`).all(companyId) as DepartmentFolder[])
    .map(d => ({ id: d.id, folder: d.folder.normalize('NFC') }))
}

/** The department whose folder contains `path` (deepest), or null. */
function departmentOf(companyId: string, path: string): DepartmentFolder | null {
  let best: DepartmentFolder | null = null
  for (const d of departmentFolders(companyId)) {
    if (isSameOrAncestorPath(d.folder, path) && (!best || d.folder.length > best.folder.length)) best = d
  }
  return best
}

/** Owner/admin anywhere; a manager inside (not at) the folder of a department they manage. */
function canManagePath(actor: Actor, path: string): boolean {
  if (FULL_ACCESS_ROLES.has(actor.role)) return true
  const managed = new Set(managedDepartmentIds(db, actor.companyId, actor.userId))
  return departmentFolders(actor.companyId).some(d => managed.has(d.id) && isSameOrAncestorPath(d.folder, path) && d.folder !== path)
}

const unavailable = (c: Ctx, path: string) =>
  c.json({ error: reservedPathMessage(path), code: 'FOLDER_NAME_UNAVAILABLE' }, 409)

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * viewers / editors from a request. Owners/admins are dropped (they always
 * read and write); `always` (the creator) is added to both. Returns an error
 * message for non-members, an editor who is not a viewer, bad types.
 */
function parseMembers(
  companyId: string,
  rawViewers: unknown,
  rawEditors: unknown,
  always: string[],
): { viewers: string[]; editors: string[] } | { error: string } {
  if (!Array.isArray(rawViewers) || rawViewers.length > MAX_MEMBERS || !rawViewers.every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) {
    return { error: 'viewers must be an array of user IDs' }
  }
  if (rawEditors !== undefined && (!Array.isArray(rawEditors) || rawEditors.length > MAX_MEMBERS || !rawEditors.every(v => typeof v === 'string'))) {
    return { error: 'editors must be an array of user IDs' }
  }
  const roles = new Map((db.prepare(`SELECT user_id, role FROM memberships WHERE company_id = ?`).all(companyId) as Array<{ user_id: string; role: string }>)
    .map(m => [m.user_id, m.role]))
  const viewers = new Set<string>()
  for (const id of [...(rawViewers as string[]), ...always]) {
    const role = roles.get(id)
    if (!role) return { error: 'Not a member of this company' }
    if (!FULL_ACCESS_ROLES.has(role)) viewers.add(id)
  }
  const editors = new Set<string>()
  for (const id of rawEditors === undefined ? [...viewers] : [...(rawEditors as string[]), ...always]) {
    const role = roles.get(id)
    if (!role) return { error: 'Not a member of this company' }
    if (FULL_ACCESS_ROLES.has(role)) continue
    if (!viewers.has(id)) return { error: 'Every editor must also be a viewer' }
    editors.add(id)
  }
  return { viewers: [...viewers], editors: [...editors] }
}

function summarize(companyId: string, p: PrivateFolderRecord, scopes: ScopeWithRules[], users: Map<string, { name: string | null; email: string }>): PrivateFolderSummary {
  const access = folderAccess(db, companyId, p.scope.path, scopes)
  return {
    scopeId: p.scope.id,
    path: p.scope.path,
    departmentId: departmentOf(companyId, p.scope.path)?.id ?? null,
    viewerCount: access.filter(a => a.read).length,
    editorCount: access.filter(a => a.write).length,
    createdAt: p.createdAt,
    createdBy: p.createdBy,
    createdByName: p.createdBy ? (users.get(p.createdBy)?.name ?? users.get(p.createdBy)?.email ?? null) : null,
  }
}

function detail(companyId: string, p: PrivateFolderRecord): PrivateFolderDetail {
  const scopes = listScopesWithRules(db, companyId)
  const access = folderAccess(db, companyId, p.scope.path, scopes).filter(a => a.read)
  const users = getUsersByIds([...new Set([...access.map(a => a.userId), ...(p.createdBy ? [p.createdBy] : [])])])
  return {
    ...summarize(companyId, p, scopes, users),
    members: access.map(a => ({
      userId: a.userId,
      name: users.get(a.userId)?.name ?? null,
      email: users.get(a.userId)?.email ?? null,
      role: a.role,
      canWrite: a.write,
      via: FULL_ACCESS_ROLES.has(a.role) ? 'role' as const : 'rule' as const,
    })),
  }
}

/** Members whose app cannot handle private folders (for the first one). */
function notReadyMembers(companyId: string): OutdatedMember[] {
  const members = db.prepare(`SELECT user_id, role FROM memberships WHERE company_id = ? ORDER BY created_at ASC`)
    .all(companyId) as Array<{ user_id: string; role: string }>
  const activity = getClientActivityForCompany(companyId)
  const blocked = members.filter(m => !supportsPrivateFolders(activity.get(m.user_id)?.client_version))
  const users = getUsersByIds(blocked.map(m => m.user_id))
  return blocked.map(m => {
    const a = activity.get(m.user_id)
    const seen = [a?.last_seen_at, a?.last_fetch_at, a?.last_push_at].filter((v): v is string => !!v).sort().pop() ?? null
    return {
      userId: m.user_id,
      name: users.get(m.user_id)?.name ?? null,
      email: users.get(m.user_id)?.email ?? null,
      role: m.role,
      clientVersion: a?.client_version ?? null,
      version: a?.client_version ?? '不明',
      lastSeenAt: seen,
    }
  })
}

export const PRIVATE_FOLDERS_OUTDATED_ERROR =
  'Some members use a desktop app that cannot handle private folders yet; ask them to update the app first'

// POST /private-folders  { parentPath, name, viewers?, editors?, force? }
privateFoldersRoute.post('/private-folders', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  // No released app syncs private folders yet: refuse outright, force or not.
  if (privateFoldersClientCutoff() === null) {
    return c.json({ error: PRIVATE_FOLDERS_UNAVAILABLE_MESSAGE, code: 'PRIVATE_FOLDERS_UNAVAILABLE' }, 409)
  }
  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const parent = parseScopePath(body.parentPath ?? '')
  if ('error' in parent) return c.json({ error: parent.error }, 400)
  if (typeof body.name !== 'string' || !isValidFolderName(body.name.normalize('NFC')) || Buffer.byteLength(body.name, 'utf8') > 255) {
    return c.json({ error: 'Invalid folder name. Use letters, numbers, Japanese characters, dots, hyphens, and underscores.' }, 400)
  }
  const name = body.name.normalize('NFC')
  const path = parent.path ? `${parent.path}/${name}` : name

  // Who may create here (Q9): owner/admin anywhere, a manager inside their department.
  const isFull = FULL_ACCESS_ROLES.has(actor.role)
  if (!isFull) {
    if (managedDepartmentIds(db, actor.companyId, actor.userId).length === 0) {
      return c.json({ error: 'Only owners, admins and department managers can create private folders' }, 403)
    }
    if (parent.path === '' || !canManagePath(actor, path)) {
      return c.json({ error: 'Department managers can create private folders only inside their own department' }, 403)
    }
  }
  const force = body.force === true
  if (force && !isFull) {
    return c.json({ error: 'Only owners and admins can save despite outdated apps', code: 'FORCE_NOT_ALLOWED' }, 403)
  }

  // The parent: inside a private folder → already private (or, for someone
  // who cannot read it, simply not there); otherwise it must exist.
  const scopes = listScopesWithRules(db, actor.companyId)
  if (parent.path !== '') {
    const priv = findPrivateScope(scopes, parent.path)
    if (priv) {
      const readable = isFull || folderAccess(db, actor.companyId, priv.path, scopes).some(a => a.userId === actor.userId && a.read)
      return readable
        ? c.json({ error: 'Folders inside a private folder are private already; create an ordinary folder there', code: 'ALREADY_PRIVATE' }, 400)
        : c.json({ error: 'Parent folder not found', code: 'PARENT_NOT_FOUND' }, 400)
    }
    if ((await resolveRepoFolder(actor.companyId, parent.path)) === null) {
      return c.json({ error: 'Parent folder not found', code: 'PARENT_NOT_FOUND' }, 400)
    }
  }

  if (body.viewers !== undefined && !Array.isArray(body.viewers)) return c.json({ error: 'viewers must be an array of user IDs' }, 400)
  const dept = departmentOf(actor.companyId, path)
  const defaultViewers = dept ? listDepartmentManagerIds(db, dept.id) : []
  const members = parseMembers(actor.companyId, body.viewers ?? defaultViewers, body.editors, [actor.userId])
  if ('error' in members) return c.json({ error: members.error, code: 'INVALID_MEMBERS' }, 400)

  try {
    const created = await withCompanyLock(actor.companyId, async () => {
      // The first private folder of the company: every member's app must cope.
      if (listPrivateFolders(db, actor.companyId).length === 0 && !force) {
        const blocked = notReadyMembers(actor.companyId)
        if (blocked.length > 0) return { blocked }
      }
      return createPrivateFolder(db, { companyId: actor.companyId, path, rules: members, createdBy: actor.userId })
    })
    if ('blocked' in created) {
      return c.json({ error: PRIVATE_FOLDERS_OUTDATED_ERROR, code: 'OUTDATED_CLIENTS', members: created.blocked, canForce: isFull }, 409)
    }
    const folder = getPrivateFolder(db, actor.companyId, created.scopeId)!
    return c.json({ success: true, data: detail(actor.companyId, folder) }, 201)
  } catch (err) {
    if (err instanceof PathUnavailableError) return unavailable(c, path)
    console.error('Failed to create private folder:', err)
    return c.json({ error: 'Failed to create the private folder' }, 500)
  }
})

/** The private folder `scopeId` if the actor may manage it; otherwise a 404 that reveals nothing. */
function managedFolder(c: Ctx, actor: Actor): PrivateFolderRecord | Response {
  const folder = getPrivateFolder(db, actor.companyId, c.req.param('scopeId') ?? '')
  if (!folder || !canManagePath(actor, folder.scope.path)) return c.json({ error: 'Not found' }, 404)
  return folder
}

// GET /private-folders
privateFoldersRoute.get('/private-folders', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const isFull = FULL_ACCESS_ROLES.has(actor.role)
  if (!isFull && managedDepartmentIds(db, actor.companyId, actor.userId).length === 0) {
    return c.json({ error: 'Only owners, admins and department managers can list private folders' }, 403)
  }
  const scopes = listScopesWithRules(db, actor.companyId)
  const folders = listPrivateFolders(db, actor.companyId, scopes).filter(p => canManagePath(actor, p.scope.path))
  const users = getUsersByIds([...new Set(folders.map(f => f.createdBy).filter((v): v is string => !!v))])
  return c.json({ success: true, data: folders.map(f => summarize(actor.companyId, f, scopes, users)) })
})

// GET /private-folders/:scopeId
privateFoldersRoute.get('/private-folders/:scopeId', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const folder = managedFolder(c, actor)
  if (folder instanceof Response) return folder
  return c.json({ success: true, data: detail(actor.companyId, folder) })
})

// PUT /private-folders/:scopeId/members  { viewers, editors? }
privateFoldersRoute.put('/private-folders/:scopeId/members', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const folder = managedFolder(c, actor)
  if (folder instanceof Response) return folder
  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const members = parseMembers(actor.companyId, body.viewers, body.editors, [])
  if ('error' in members) return c.json({ error: members.error, code: 'INVALID_MEMBERS' }, 400)
  replacePrivateFolderRules(db, folder.scope.id, members, actor.userId)
  return c.json({ success: true, data: detail(actor.companyId, getPrivateFolder(db, actor.companyId, folder.scope.id)!) })
})

// POST /private-folders/:scopeId/make-public  (owner/admin)
privateFoldersRoute.post('/private-folders/:scopeId/make-public', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!FULL_ACCESS_ROLES.has(actor.role)) {
    return c.json({ error: 'Only owners and admins can make a private folder public' }, 403)
  }
  const folder = getPrivateFolder(db, actor.companyId, c.req.param('scopeId'))
  if (!folder) return c.json({ error: 'Not found' }, 404)
  try {
    const result = await withCompanyLock(actor.companyId, async () => {
      const current = getPrivateFolder(db, actor.companyId, folder.scope.id)
      if (!current) return null
      return makePrivateFolderPublic(db, actor.companyId, current, actor.userId)
    })
    if (!result) return c.json({ error: 'Not found' }, 404)
    return c.json({ success: true, data: result })
  } catch (err) {
    if (err instanceof MakePublicError) {
      return c.json({ error: err.message, code: err.code }, err.code === 'BUSY' ? 503 : 409)
    }
    console.error('Failed to make a private folder public:', err)
    return c.json({ error: 'Failed to make the folder public' }, 500)
  }
})

/** Absolute base URL for clone URLs, as routes/git.ts builds the company repository's. */
function publicBaseUrl(c: Ctx): string {
  const proto = c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')
  return process.env.PUBLIC_URL || `${proto}://${c.req.header('host') || 'localhost:3001'}`
}

// GET /me/private-folders — the readable ones, with who can read them
privateFoldersRoute.get('/me/private-folders', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const scopes = listScopesWithRules(db, actor.companyId)
  const readable = readablePrivateFolders(db, actor.companyId, actor.userId, actor.role, scopes)
  const access = new Map(readable.map(p => [p.scope.id, folderAccess(db, actor.companyId, p.scope.path, scopes).filter(a => a.read)]))
  const users = getUsersByIds([...new Set([...access.values()].flat().map(a => a.userId))])
  const data: MyPrivateFolder[] = readable.map(p => {
    const readers = access.get(p.scope.id) ?? []
    // Named viewers first: owners/admins read everything and say little here.
    const ordered = [...readers.filter(a => !FULL_ACCESS_ROLES.has(a.role)), ...readers.filter(a => FULL_ACCESS_ROLES.has(a.role))]
    return {
      scopeId: p.scope.id,
      path: p.scope.path,
      canWrite: canWriteInPrivateFolder(scopes, p.scope, actor.companyId, actor.userId, actor.role),
      viewerCount: readers.length,
      viewers: ordered.slice(0, MY_PRIVATE_FOLDER_VIEWERS_LIMIT).map(a => ({
        userId: a.userId,
        name: users.get(a.userId)?.name ?? users.get(a.userId)?.email ?? null,
        role: a.role,
      })),
    }
  })
  c.header('Cache-Control', 'private, no-cache')
  return c.json({ success: true, data })
})

// GET /me/scopes — ETag / If-None-Match → 304
privateFoldersRoute.get('/me/scopes', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const scopes = listScopesWithRules(db, actor.companyId)
  const base = publicBaseUrl(c)
  const readable = readablePrivateFolders(db, actor.companyId, actor.userId, actor.role, scopes).map(p => {
    const clonePath = `/api/git-http/${actor.companyId}/scopes/${p.scope.id}.git`
    return {
      scopeId: p.scope.id,
      path: p.scope.path,
      cloneUrl: `${base}${clonePath}`,
      clonePath,
      canWrite: canWriteInPrivateFolder(scopes, p.scope, actor.companyId, actor.userId, actor.role),
    }
  })
  // Nothing about private folders the caller cannot read — not even a salted
  // hash of the path (short Japanese folder names are cheap to brute-force).
  // The app asks POST /paths/check instead.
  const version = createHash('sha256').update(JSON.stringify({ readable })).digest('hex').slice(0, 32)
  const etag = `"${version}"`
  c.header('ETag', etag)
  c.header('Cache-Control', 'private, no-cache')
  const inm = c.req.header('If-None-Match')
  if (inm && inm.split(',').some(t => t.trim() === etag)) return c.body(null, 304)
  const data: MyScopesResponse = { version, scopes: readable }
  return c.json({ success: true, data })
})

// ----------------------------------------------------------------------------
// POST /paths/check — may the caller put something at these paths?
// ----------------------------------------------------------------------------

const MAX_CHECK_PATH_LENGTH = 1024
const CHECK_WINDOW_MS = 60_000
const checkBudget = new Map<string, { windowStart: number; used: number }>()

/**
 * Take `n` paths from the member's per-minute budget (per company). False
 * when that would exceed PATHS_CHECK_PATHS_PER_MINUTE: guessing private
 * folder names one request at a time stays slow.
 */
function takeCheckBudget(companyId: string, userId: string, n: number, now = Date.now()): boolean {
  const key = `${companyId}\u0000${userId}`
  let b = checkBudget.get(key)
  if (!b || now - b.windowStart >= CHECK_WINDOW_MS) {
    b = { windowStart: now, used: 0 }
    checkBudget.set(key, b)
  }
  if (b.used + n > PATHS_CHECK_PATHS_PER_MINUTE) return false
  b.used += n
  // Forget idle members now and then (bounded memory).
  if (checkBudget.size > 10_000) {
    for (const [k, v] of checkBudget) if (now - v.windowStart >= CHECK_WINDOW_MS) checkBudget.delete(k)
  }
  return true
}

/** Tests only. */
export function resetPathCheckBudgetForTests(): void {
  checkBudget.clear()
}

// { paths: string[] } → { results: [{ path, usable }] }
//
// usable: false exactly when the path is at or under a private folder the
// caller cannot read (a push there is refused with [RESERVED_PATH]); one
// they can read answers true (its contents go to its own repository). The
// answer is the same shape, wording and work whatever makes a path unusable,
// says nothing about which folder, and the paths are never logged.
privateFoldersRoute.post('/paths/check', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const body = await readJson(c)
  const raw = body?.paths
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PATHS_CHECK_MAX_PATHS) {
    return c.json({ error: `paths must be an array of 1-${PATHS_CHECK_MAX_PATHS} paths` }, 400)
  }
  for (const p of raw) {
    // eslint-disable-next-line no-control-regex
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_CHECK_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(p)
      || normalizeReservedPath(p) === '' || normalizeReservedPath(p).split('/').some(s => s === '.' || s === '..')) {
      return c.json({ error: 'Each path must be a relative path inside the company folder' }, 400)
    }
  }
  if (!takeCheckBudget(actor.companyId, actor.userId, raw.length)) {
    c.header('Retry-After', '60')
    return c.json({ error: 'Too many paths checked; try again in a minute', code: 'RATE_LIMITED' }, 429)
  }
  const scopes = listScopesWithRules(db, actor.companyId)
  const data: PathCheckResponse = {
    results: (raw as string[]).map(path => ({ path, usable: isPathUsable(scopes, actor.userId, actor.role, normalizeReservedPath(path)) })),
  }
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data })
})

// ----------------------------------------------------------------------------
// DELETE /private-folders/:scopeId?confirm=<folder name>  (owner/admin)
// ----------------------------------------------------------------------------

privateFoldersRoute.delete('/private-folders/:scopeId', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!FULL_ACCESS_ROLES.has(actor.role)) {
    return c.json({ error: 'Only owners and admins can delete a private folder' }, 403)
  }
  const folder = getPrivateFolder(db, actor.companyId, c.req.param('scopeId'))
  if (!folder) return c.json({ error: 'Not found' }, 404)
  // Type-the-name confirmation: the folder's own name (last segment), NFC.
  const body = await readJson(c)
  const confirm = c.req.query('confirm') ?? (typeof body?.confirm === 'string' ? body.confirm : undefined)
  const name = folder.scope.path.split('/').pop()!
  if (typeof confirm !== 'string' || confirm.normalize('NFC') !== name.normalize('NFC')) {
    return c.json({ error: 'Type the folder name to confirm the deletion', code: 'CONFIRMATION_REQUIRED' }, 400)
  }
  try {
    const result = await withCompanyLock(actor.companyId, async () => {
      const current = getPrivateFolder(db, actor.companyId, folder.scope.id)
      if (!current) return null
      return deletePrivateFolder(db, actor.companyId, current, actor.userId)
    })
    if (!result) return c.json({ error: 'Not found' }, 404)
    const data: DeletePrivateFolderResult = { path: result.path, archived: true }
    return c.json({ success: true, data })
  } catch (err) {
    if (err instanceof MakePublicError) {
      return c.json({ error: err.message, code: err.code }, err.code === 'BUSY' ? 503 : 409)
    }
    console.error('Failed to delete a private folder:', err instanceof Error ? err.message : err)
    return c.json({ error: 'Failed to delete the private folder' }, 500)
  }
})
