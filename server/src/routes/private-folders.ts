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
import { getUserFromRequest } from '../lib/auth'
import { privateFoldersClientCutoff } from '../lib/client-version'
import { isValidFolderName, parseScopePath } from '../../shared/core/names'
import {
  PATHS_CHECK_MAX_PATHS,
  PATHS_CHECK_PATHS_PER_MINUTE,
  PRIVATE_FOLDERS_UNAVAILABLE_MESSAGE,
  normalizeReservedPath,
  type DeletePrivateFolderResult,
  type PathCheckResponse,
  type MyScopesResponse,
} from '../../shared/types/private-folders'
import { services } from '../composition'
import { hasFullAccess, requireFullAccess, type Member } from '../services/access'
import { PRIVATE_FOLDERS_OUTDATED_ERROR } from '../services/private-folders'
import { refusal } from './respond'

export { PRIVATE_FOLDERS_OUTDATED_ERROR }

export const privateFoldersRoute = new Hono()
const { access, privateFolders } = services

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

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

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
  const isFull = hasFullAccess(actor.role)
  if (!isFull) {
    if (!privateFolders.managesAnyDepartment(actor)) {
      return c.json({ error: 'Only owners, admins and department managers can create private folders' }, 403)
    }
    if (parent.path === '' || !privateFolders.canManagePath(actor, path)) {
      return c.json({ error: 'Department managers can create private folders only inside their own department' }, 403)
    }
  }
  const force = body.force === true
  if (force && !isFull) {
    return c.json({ error: 'Only owners and admins can save despite outdated apps', code: 'FORCE_NOT_ALLOWED' }, 403)
  }

  const parentOk = await privateFolders.checkParent(actor, parent.path)
  if (!parentOk.ok) return refusal(c, parentOk)

  if (body.viewers !== undefined && !Array.isArray(body.viewers)) return c.json({ error: 'viewers must be an array of user IDs' }, 400)
  const members = privateFolders.parseMembers(actor.companyId, body.viewers ?? privateFolders.defaultViewers(actor.companyId, path), body.editors, [actor.userId])
  if ('error' in members) return c.json({ error: members.error, code: 'INVALID_MEMBERS' }, 400)

  try {
    const created = await privateFolders.create(actor, path, members, force)
    if (!created.ok) return refusal(c, created)
    return c.json({ success: true, data: created.value }, 201)
  } catch (err) {
    console.error('Failed to create private folder:', err)
    return c.json({ error: 'Failed to create the private folder' }, 500)
  }
})

// GET /private-folders
privateFoldersRoute.get('/private-folders', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  if (!hasFullAccess(actor.role) && !privateFolders.managesAnyDepartment(actor)) {
    return c.json({ error: 'Only owners, admins and department managers can list private folders' }, 403)
  }
  return c.json({ success: true, data: privateFolders.list(actor) })
})

// GET /private-folders/:scopeId
privateFoldersRoute.get('/private-folders/:scopeId', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const folder = privateFolders.managed(actor, c.req.param('scopeId') ?? '')
  if (!folder.ok) return refusal(c, folder)
  return c.json({ success: true, data: privateFolders.detail(actor, folder.value) })
})

// PUT /private-folders/:scopeId/members  { viewers, editors? }
privateFoldersRoute.put('/private-folders/:scopeId/members', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  const folder = privateFolders.managed(actor, c.req.param('scopeId') ?? '')
  if (!folder.ok) return refusal(c, folder)
  const body = await readJson(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
  const members = privateFolders.parseMembers(actor.companyId, body.viewers, body.editors, [])
  if ('error' in members) return c.json({ error: members.error, code: 'INVALID_MEMBERS' }, 400)
  return c.json({ success: true, data: privateFolders.replaceMembers(actor, folder.value, members) })
})

// POST /private-folders/:scopeId/make-public  (owner/admin)
privateFoldersRoute.post('/private-folders/:scopeId/make-public', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const actor = requireFullAccess(member, 'Only owners and admins can make a private folder public')
  if (!actor.ok) return refusal(c, actor)
  const folder = privateFolders.find(actor.value, c.req.param('scopeId'))
  if (!folder.ok) return refusal(c, folder)
  try {
    const result = await privateFolders.makePublic(actor.value, folder.value)
    if (!result.ok) return refusal(c, result)
    return c.json({ success: true, data: result.value })
  } catch (err) {
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
  const data = privateFolders.mine(actor)
  c.header('Cache-Control', 'private, no-cache')
  return c.json({ success: true, data })
})

// GET /me/scopes — ETag / If-None-Match → 304
privateFoldersRoute.get('/me/scopes', async (c) => {
  const actor = await authAndAuthorize(c)
  if (actor instanceof Response) return actor
  // Nothing about private folders the caller cannot read — not even a salted
  // hash of the path (short Japanese folder names are cheap to brute-force).
  // The app asks POST /paths/check instead.
  const readable = privateFolders.myScopes(actor, publicBaseUrl(c))
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

// { paths: string[], files?: string[] } → { results: [{ path, usable }] }
//
// usable: false exactly when a push of the path would be refused with
// [RESERVED_PATH]: it is at or under a private folder the caller cannot read
// (one they can read answers true: its contents go to its own repository),
// or — for a path also listed in `files` (it will be a file, not a folder) —
// a strict ancestor of any private folder (shared/core isPathUsable). The
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
  const rawFiles = body?.files
  if (rawFiles !== undefined && (!Array.isArray(rawFiles) || rawFiles.length > PATHS_CHECK_MAX_PATHS || rawFiles.some(f => typeof f !== 'string'))) {
    return c.json({ error: `files must be an array of at most ${PATHS_CHECK_MAX_PATHS} of the paths` }, 400)
  }
  const files = new Set<string>((rawFiles as string[] | undefined) ?? [])
  if (!takeCheckBudget(actor.companyId, actor.userId, raw.length)) {
    c.header('Retry-After', '60')
    return c.json({ error: 'Too many paths checked; try again in a minute', code: 'RATE_LIMITED' }, 429)
  }
  const data: PathCheckResponse = { results: privateFolders.pathsUsable(actor, raw as string[], files) }
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data })
})

// ----------------------------------------------------------------------------
// DELETE /private-folders/:scopeId?confirm=<folder name>  (owner/admin)
// ----------------------------------------------------------------------------

privateFoldersRoute.delete('/private-folders/:scopeId', async (c) => {
  const member = await authAndAuthorize(c)
  if (member instanceof Response) return member
  const actor = requireFullAccess(member, 'Only owners and admins can delete a private folder')
  if (!actor.ok) return refusal(c, actor)
  const folder = privateFolders.find(actor.value, c.req.param('scopeId'))
  if (!folder.ok) return refusal(c, folder)
  // Type-the-name confirmation: the folder's own name (last segment), NFC.
  const body = await readJson(c)
  const confirm = c.req.query('confirm') ?? (typeof body?.confirm === 'string' ? body.confirm : undefined)
  const name = folder.value.scope.path.split('/').pop()!
  if (typeof confirm !== 'string' || confirm.normalize('NFC') !== name.normalize('NFC')) {
    return c.json({ error: 'Type the folder name to confirm the deletion', code: 'CONFIRMATION_REQUIRED' }, 400)
  }
  try {
    const result = await privateFolders.delete(actor.value, folder.value)
    if (!result.ok) return refusal(c, result)
    const data: DeletePrivateFolderResult = { path: result.value.path, archived: true }
    return c.json({ success: true, data })
  } catch (err) {
    console.error('Failed to delete a private folder:', err instanceof Error ? err.message : err)
    return c.json({ error: 'Failed to delete the private folder' }, 500)
  }
})
