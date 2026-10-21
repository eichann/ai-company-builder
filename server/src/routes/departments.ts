import { Hono } from 'hono'
import { execFile } from 'child_process'
import { internalGitEnv } from '../lib/git-server'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { readdir, rm, stat } from 'fs/promises'
import { promisify } from 'util'
import { join } from 'path'
import { db, generateId, now } from '../db'
import { getUserFromRequest, getUsersByIds } from '../lib/auth'
import {
  deleteDepartmentScopes,
  ensureDepartmentScope,
  listDepartmentManagerIds,
  moveScopeSubtree,
  replaceDepartmentManagers,
  syncCompanyScopes,
} from '../lib/permission-store'
import type {
  Department,
  CreateDepartmentInput,
  UpdateDepartmentInput,
  ReorderDepartmentItem,
} from '../../shared/types'

export const departmentsRoute = new Hono()

// Directory paths
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const REPOS_DIR = process.env.REPOS_DIR || join(DATA_DIR, 'repos')
const WORKDIR_DIR = join(DATA_DIR, 'workdirs') // Working directories for file operations

// Ensure directories exist
if (!existsSync(WORKDIR_DIR)) {
  mkdirSync(WORKDIR_DIR, { recursive: true })
}

// Helper: Convert snake_case to camelCase
function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    if (key === 'is_active') {
      result[camelKey] = Boolean(value)
    } else {
      result[camelKey] = value
    }
  }
  return result
}

// Helper: Get user membership
function getUserMembership(userId: string, companyId: string): { role: string } | undefined {
  return db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(userId, companyId) as { role: string } | undefined
}

// Helper: Check if user can edit departments
function canEditDepartments(role: string): boolean {
  return role === 'owner' || role === 'admin'
}

// Helper: Validate folder name (ASCII + Japanese allowed)
export function isValidFolderName(folder: string): boolean {
  return /^[\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF][\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF._-]*$/.test(folder)
}

// Helper: Get bare repo path for a company
function getBareRepoPath(companyId: string): string {
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  return join(REPOS_DIR, `${sanitizedId}.git`)
}

// ============================================================================
// Git helpers
//
// Everything here is asynchronous. These run inside request handlers of the
// process that also serves every member's git-http traffic: a synchronous git
// call (the old `execFileSync('git', ['pull', ...])` on every list request)
// froze the whole server — 42 s on a 7.7 GB working clone — for everyone.
// ============================================================================

const execFileAsync = promisify(execFile)

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf8',
    // ls-tree -r of a large department folder
    maxBuffer: 512 * 1024 * 1024,
    // internalGitEnv: the pushes made here (department folder create /
    // rename / delete) are the server's own — the hook skips the
    // write-permission check for them; every content rule still applies.
    env: { ...internalGitEnv(), GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

// Per-company serialization of working-clone operations. A run registers
// itself before awaiting the previous one, so two queued requests can never
// wake up together and run git in the same working directory concurrently.
const companyLocks = new Map<string, Promise<void>>()

export async function withCompanyLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const previous = companyLocks.get(companyId) ?? Promise.resolve()
  let release!: () => void
  const current = previous.then(() => new Promise<void>(resolve => { release = resolve }))
  companyLocks.set(companyId, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (companyLocks.get(companyId) === current) companyLocks.delete(companyId)
  }
}

// The shared branch of the bare repo: main, or master for a repo created
// before the branch name was pinned (the old working-clone pull fell back the
// same way). null while the repo has no commits.
async function resolveSharedBranch(bareRepo: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    try {
      await git(['-C', bareRepo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
      return `refs/heads/${branch}`
    } catch {
      // Try the next name
    }
  }
  return null
}

interface TreeEntry { type: string; path: string }

// `git ls-tree -z` records: "<mode> <type> <object>\t<path>\0" (-z: paths are
// not quoted, so Japanese names come through as they are)
function parseLsTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    entries.push({ type: record.slice(0, tab).split(' ')[1], path: record.slice(tab + 1) })
  }
  return entries
}

// Helper: List department folders — the non-hidden directories at the root of
// the shared branch, read straight from the bare repo. This is what a
// checkout of that branch shows (a gitlink checks out as an empty directory),
// and it is always current: no working clone, no pull.
export async function listFoldersFromRepo(companyId: string): Promise<string[]> {
  const bareRepo = getBareRepoPath(companyId)
  if (!existsSync(bareRepo)) {
    throw new Error('Repository not found')
  }
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return [] // Empty repo: nothing to check out
  return parseLsTree(await git(['-C', bareRepo, 'ls-tree', '-z', ref]))
    .filter(e => (e.type === 'tree' || e.type === 'commit') && !e.path.startsWith('.'))
    .map(e => e.path)
}

// Helper: Count files and folders in a department folder of the shared
// branch, skipping hidden entries and everything below them — the count
// countFilesInDir makes on a checkout. null when the folder does not exist
// (or is not a directory).
async function countFilesInRepoFolder(companyId: string, folder: string): Promise<{ files: number; folders: number } | null> {
  const bareRepo = getBareRepoPath(companyId)
  if (!existsSync(bareRepo)) return null
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return null
  try {
    const type = (await git(['-C', bareRepo, 'cat-file', '-t', `${ref}:${folder}`])).trim()
    if (type !== 'tree') return null
  } catch {
    return null
  }

  let files = 0
  let folders = 0
  for (const entry of parseLsTree(await git(['-C', bareRepo, 'ls-tree', '-r', '-t', '-z', `${ref}:${folder}`]))) {
    if (entry.path.split('/').some(part => part.startsWith('.'))) continue
    if (entry.type === 'tree' || entry.type === 'commit') folders++
    else files++
  }
  return { files, folders }
}

// Directory entries (trees and gitlinks, hidden ones skipped) of `dir` on the
// shared branch, '' being the root. null when the repo, branch or directory
// does not exist.
async function listRepoDirectory(companyId: string, dir: string): Promise<string[] | null> {
  const bareRepo = getBareRepoPath(companyId)
  if (!existsSync(bareRepo)) return null
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return null
  const target = dir === '' ? ref : `${ref}:${dir}`
  if (dir !== '') {
    try {
      if ((await git(['-C', bareRepo, 'cat-file', '-t', target])).trim() !== 'tree') return null
    } catch {
      return null
    }
  }
  return parseLsTree(await git(['-C', bareRepo, 'ls-tree', '-z', target]))
    .filter(e => (e.type === 'tree' || e.type === 'commit') && !e.path.startsWith('.'))
    .map(e => e.path)
}

/**
 * Resolve a repo-relative folder path (NFC, '/'-separated, as stored in
 * `scopes`) against the shared branch of the bare repo, segment by segment,
 * comparing names in NFC: a Mac client commits Japanese names in NFD, so a
 * byte-wise lookup of the NFC path would miss them. Returns the path as the
 * repository spells it, or null when some segment is not a (non-hidden)
 * folder there. '' (the company root) resolves to ''.
 */
export async function resolveRepoFolder(companyId: string, path: string): Promise<string | null> {
  let stored = ''
  for (const segment of path.split('/').filter(Boolean)) {
    const entries = await listRepoDirectory(companyId, stored)
    const match = entries?.find(e => e.normalize('NFC') === segment.normalize('NFC'))
    if (!match) return null
    stored = stored ? `${stored}/${match}` : match
  }
  return stored
}

/** Sub-folder names (NFC, sorted) of an existing folder on the shared branch; null when it does not exist. */
export async function listRepoSubfolders(companyId: string, path: string): Promise<string[] | null> {
  const stored = await resolveRepoFolder(companyId, path)
  if (stored === null) return null
  const entries = await listRepoDirectory(companyId, stored)
  if (entries === null) return null
  return entries.map(e => e.normalize('NFC')).sort((a, b) => a.localeCompare(b, 'ja'))
}

// Helper: Get or create the working directory for a company, up to date with
// the bare repo. Mutations only, and only inside withCompanyLock.
async function getWorkingDir(companyId: string): Promise<string> {
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  const workDir = join(WORKDIR_DIR, sanitizedId)
  const bareRepo = getBareRepoPath(companyId)

  if (!existsSync(bareRepo)) {
    throw new Error('Repository not found')
  }

  if (!existsSync(workDir)) {
    // Clone from bare repo
    await git(['clone', bareRepo, workDir])
  } else {
    // Ensure remote URL points to correct bare repo path (fixes server migration issues)
    try {
      const currentUrl = (await git(['-C', workDir, 'remote', 'get-url', 'origin'])).trim()
      if (currentUrl !== bareRepo) {
        await git(['-C', workDir, 'remote', 'set-url', 'origin', bareRepo])
      }
    } catch {
      // Ignore - remote might not exist yet
    }

    // Pull latest changes
    try {
      await git(['-C', workDir, 'pull', 'origin', 'main'])
    } catch {
      try {
        await git(['-C', workDir, 'pull', 'origin', 'master'])
      } catch {
        // Ignore pull errors (might be empty repo)
      }
    }
  }

  return workDir
}

// Helper: Commit and push changes
async function commitAndPush(workDir: string, message: string): Promise<void> {
  try {
    await git(['-C', workDir, 'add', '-A'])
    await git(['-C', workDir, 'commit', '-m', message, '--allow-empty'])
    try {
      await git(['-C', workDir, 'push', 'origin', 'HEAD'])
    } catch {
      // Ignore push errors (remote might not be available)
    }
  } catch (error) {
    console.error('Git commit/push error:', error)
    // Don't throw - commit might fail if nothing changed
  }
}

// Helper: Count files in a directory of the working clone (recursive)
async function countFilesInDir(dirPath: string): Promise<{ files: number; folders: number }> {
  let files = 0
  let folders = 0

  async function count(path: string) {
    if (!existsSync(path)) return
    for (const item of await readdir(path)) {
      if (item.startsWith('.')) continue
      const itemPath = join(path, item)
      if ((await stat(itemPath)).isDirectory()) {
        folders++
        await count(itemPath)
      } else {
        files++
      }
    }
  }

  await count(dirPath)
  return { files, folders }
}

// Helper: Build department data from DB records only
// Only returns departments that are registered in the DB (folders created via admin/API)
// Filesystem folders that are not in the DB are ignored
function buildDepartmentList(companyId: string, folders: string[]): Department[] {
  // Get DB settings for this company
  const dbDepts = db.prepare(`
    SELECT * FROM departments WHERE company_id = ? ORDER BY sort_order ASC
  `).all(companyId) as Record<string, unknown>[]

  const fsFolderSet = new Set(folders)

  const result: Department[] = []

  for (const dbDept of dbDepts) {
    const folder = dbDept.folder as string
    // Only include if the folder actually exists on the filesystem
    if (fsFolderSet.has(folder)) {
      result.push(toCamelCase(dbDept) as unknown as Department)
    }
  }

  // Already sorted by sort_order from query, but ensure consistency
  result.sort((a, b) => a.sortOrder - b.sortOrder)

  return result
}

// GET /api/companies/:companyId/departments - List departments
departmentsRoute.get('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  if (!companyId) {
    return c.json({ error: 'Company ID is required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  try {
    // Folders of the shared branch, read from the bare repo (no pull/clone)
    const folders = await listFoldersFromRepo(companyId)

    // Build department list (DB-registered departments only)
    const departments = buildDepartmentList(companyId, folders)

    return c.json({
      success: true,
      data: departments,
    })
  } catch (error) {
    console.error('Failed to list departments:', error)
    return c.json({
      success: true,
      data: [], // Return empty if repo doesn't exist yet
    })
  }
})

// GET /api/companies/:companyId/departments/:id - Get single department
departmentsRoute.get('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const deptId = c.req.param('id')
  if (!companyId || !deptId) {
    return c.json({ error: 'Company ID and Department ID are required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  const department = db.prepare(`
    SELECT * FROM departments WHERE id = ? AND company_id = ?
  `).get(deptId, companyId) as Record<string, unknown> | undefined

  if (!department) {
    return c.json({ error: 'Department not found' }, 404)
  }

  return c.json({
    success: true,
    data: toCamelCase(department),
  })
})

// POST /api/companies/:companyId/departments - Create department (creates folder)
departmentsRoute.post('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  if (!companyId) {
    return c.json({ error: 'Company ID is required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  if (!canEditDepartments(membership.role)) {
    return c.json({ error: 'Only owners and admins can create departments' }, 403)
  }

  const body = await c.req.json() as CreateDepartmentInput

  // Validate required fields
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'Department name is required' }, 400)
  }

  if (!body.folder || typeof body.folder !== 'string' || body.folder.trim().length === 0) {
    return c.json({ error: 'Folder name is required' }, 400)
  }

  if (!isValidFolderName(body.folder)) {
    return c.json({
      error: 'Invalid folder name. Use letters, numbers, Japanese characters, dots, hyphens, and underscores.',
    }, 400)
  }

  try {
    // Working-clone operations, one request per company at a time
    const created = await withCompanyLock(companyId, async () => {
      const workDir = await getWorkingDir(companyId)
      const folderPath = join(workDir, body.folder)

      // Check if folder already exists
      if (existsSync(folderPath)) {
        return false
      }

      // Create folder with .gitkeep and .personal workspace
      mkdirSync(folderPath, { recursive: true })
      writeFileSync(join(folderPath, '.gitkeep'), '')

      // Create .personal directory (gitignored personal workspace)
      const personalDir = join(folderPath, '.personal')
      mkdirSync(personalDir, { recursive: true })
      writeFileSync(join(personalDir, '.gitignore'), '# Personal workspace — not synced\n*\n!.gitignore\n')

      // Commit and push
      await commitAndPush(workDir, `Add department: ${body.name}`)
      return true
    })

    if (!created) {
      return c.json({ error: 'A folder with this name already exists' }, 409)
    }

    // Save to DB
    const id = generateId()
    const timestamp = now()

    // Get max sort order
    const maxOrder = db.prepare(`
      SELECT MAX(sort_order) as max FROM departments WHERE company_id = ?
    `).get(companyId) as { max: number | null }
    const sortOrder = (maxOrder?.max ?? -1) + 1

    db.prepare(`
      INSERT INTO departments (
        id, company_id, parent_id,
        name, name_en, folder,
        icon, color, description,
        sort_order, is_active,
        created_at, updated_at, created_by
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      companyId,
      body.name.trim(),
      body.nameEn || null,
      body.folder.trim(),
      body.icon || 'Folder',
      body.color || '#6366f1',
      body.description || null,
      sortOrder,
      timestamp,
      timestamp,
      user.id
    )
    // The department's permission scope (no rules: inherits from the company)
    ensureDepartmentScope(db, companyId, id, body.folder.trim(), user.id)

    const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as Record<string, unknown>

    return c.json({
      success: true,
      data: toCamelCase(department),
    }, 201)
  } catch (error) {
    console.error('Failed to create department:', error)
    return c.json({
      error: `Failed to create department: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }, 500)
  }
})

// PUT /api/companies/:companyId/departments/:id - Update department
departmentsRoute.put('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const deptId = c.req.param('id')
  if (!companyId || !deptId) {
    return c.json({ error: 'Company ID and Department ID are required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  if (!canEditDepartments(membership.role)) {
    return c.json({ error: 'Only owners and admins can update departments' }, 403)
  }

  const existing = db.prepare(`
    SELECT * FROM departments WHERE id = ? AND company_id = ?
  `).get(deptId, companyId) as Record<string, unknown> | undefined

  if (!existing) {
    return c.json({ error: 'Department not found' }, 404)
  }

  const body = await c.req.json() as UpdateDepartmentInput

  try {
    if (!existsSync(getBareRepoPath(companyId))) {
      throw new Error('Repository not found')
    }
    const oldFolder = existing.folder as string

    // Handle folder rename if requested (only a rename touches the working clone)
    if (body.folder !== undefined && body.folder !== oldFolder) {
      if (!isValidFolderName(body.folder)) {
        return c.json({
          error: 'Invalid folder name. Use letters, numbers, Japanese characters, dots, hyphens, and underscores.',
        }, 400)
      }
      const newFolder = body.folder

      const renamed = await withCompanyLock(companyId, async () => {
        const workDir = await getWorkingDir(companyId)
        const oldPath = join(workDir, oldFolder)
        const newPath = join(workDir, newFolder)

        if (existsSync(newPath)) {
          return false
        }

        if (existsSync(oldPath)) {
          // Use git mv for proper tracking
          await git(['-C', workDir, 'mv', oldFolder, newFolder])
          await commitAndPush(workDir, `Rename department: ${oldFolder} -> ${newFolder}`)
        }
        return true
      })

      if (!renamed) {
        return c.json({ error: 'A folder with this name already exists' }, 409)
      }
    }

    // Update DB
    const updates: string[] = []
    const values: unknown[] = []

    if (body.name !== undefined) {
      updates.push('name = ?')
      values.push(body.name.trim())
    }
    if (body.nameEn !== undefined) {
      updates.push('name_en = ?')
      values.push(body.nameEn)
    }
    if (body.folder !== undefined) {
      updates.push('folder = ?')
      values.push(body.folder.trim())
    }
    if (body.icon !== undefined) {
      updates.push('icon = ?')
      values.push(body.icon)
    }
    if (body.color !== undefined) {
      updates.push('color = ?')
      values.push(body.color)
    }
    if (body.description !== undefined) {
      updates.push('description = ?')
      values.push(body.description)
    }
    if (body.isActive !== undefined) {
      updates.push('is_active = ?')
      values.push(body.isActive ? 1 : 0)
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?')
      values.push(now())
      values.push(deptId)

      db.transaction(() => {
        db.prepare(`
          UPDATE departments SET ${updates.join(', ')} WHERE id = ?
        `).run(...values)
        // Folder renamed: the department's scope and every folder scope
        // under it move with it (rules stay attached).
        if (body.folder !== undefined && body.folder.trim() !== oldFolder) {
          moveScopeSubtree(db, companyId, oldFolder, body.folder.trim())
          ensureDepartmentScope(db, companyId, deptId, body.folder.trim(), user.id)
        }
      })()
    }

    const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId) as Record<string, unknown>

    return c.json({
      success: true,
      data: toCamelCase(department),
    })
  } catch (error) {
    console.error('Failed to update department:', error)
    return c.json({
      error: `Failed to update department: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }, 500)
  }
})

// DELETE /api/companies/:companyId/departments/:id - Delete department (deletes folder!)
departmentsRoute.delete('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const deptId = c.req.param('id')
  if (!companyId || !deptId) {
    return c.json({ error: 'Company ID and Department ID are required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  if (!canEditDepartments(membership.role)) {
    return c.json({ error: 'Only owners and admins can delete departments' }, 403)
  }

  const existing = db.prepare(`
    SELECT * FROM departments WHERE id = ? AND company_id = ?
  `).get(deptId, companyId) as Record<string, unknown> | undefined

  if (!existing) {
    return c.json({ error: 'Department not found' }, 404)
  }

  const folder = existing.folder as string

  try {
    const { deletedFiles, deletedFolders } = await withCompanyLock(companyId, async () => {
      const workDir = await getWorkingDir(companyId)
      const folderPath = join(workDir, folder)

      if (!existsSync(folderPath)) {
        return { deletedFiles: 0, deletedFolders: 0 }
      }

      // Count what will be deleted
      const counts = await countFilesInDir(folderPath)

      // Delete the folder
      await rm(folderPath, { recursive: true, force: true })

      // Commit and push
      await git(['-C', workDir, 'add', '-A'])
      await commitAndPush(workDir, `Delete department: ${existing.name} (${folder})`)
      return { deletedFiles: counts.files, deletedFolders: counts.folders }
    })

    // Remove from DB, with the department's scopes, their rules and its managers
    db.transaction(() => {
      deleteDepartmentScopes(db, companyId, deptId, folder)
      db.prepare('DELETE FROM departments WHERE id = ?').run(deptId)
    })()

    return c.json({
      success: true,
      message: deletedFiles > 0
        ? `Department deleted with ${deletedFiles} file(s) and ${deletedFolders} subfolder(s)`
        : 'Department deleted',
      deletedFiles,
      deletedFolders,
    })
  } catch (error) {
    console.error('Failed to delete department:', error)
    return c.json({
      error: `Failed to delete department: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }, 500)
  }
})

// GET /api/companies/:companyId/departments/:id/stats - Get folder stats (for delete warning)
departmentsRoute.get('/:id/stats', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const deptId = c.req.param('id')
  if (!companyId || !deptId) {
    return c.json({ error: 'Company ID and Department ID are required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  const existing = db.prepare(`
    SELECT * FROM departments WHERE id = ? AND company_id = ?
  `).get(deptId, companyId) as Record<string, unknown> | undefined

  if (!existing) {
    return c.json({ error: 'Department not found' }, 404)
  }

  try {
    // Read from the bare repo's shared branch (no pull/clone)
    const counts = await countFilesInRepoFolder(companyId, existing.folder as string)

    if (!counts) {
      return c.json({
        success: true,
        data: { files: 0, folders: 0, exists: false },
      })
    }

    return c.json({
      success: true,
      data: {
        ...counts,
        exists: true,
      },
    })
  } catch {
    return c.json({
      success: true,
      data: { files: 0, folders: 0, exists: false },
    })
  }
})

// POST /api/companies/:companyId/departments/reorder - Reorder departments
departmentsRoute.post('/reorder', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  if (!companyId) {
    return c.json({ error: 'Company ID is required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  if (!canEditDepartments(membership.role)) {
    return c.json({ error: 'Only owners and admins can reorder departments' }, 403)
  }

  const body = await c.req.json() as { items: ReorderDepartmentItem[] }

  if (!body.items || !Array.isArray(body.items)) {
    return c.json({ error: 'items array is required' }, 400)
  }

  const timestamp = now()

  const updateStmt = db.prepare(`
    UPDATE departments
    SET sort_order = ?, updated_at = ?
    WHERE id = ? AND company_id = ?
  `)

  for (const item of body.items) {
    updateStmt.run(item.sortOrder, timestamp, item.id, companyId)
  }

  return c.json({
    success: true,
    message: 'Departments reordered',
  })
})

// POST /api/companies/:companyId/departments/sync - Sync DB with file system
departmentsRoute.post('/sync', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  if (!companyId) {
    return c.json({ error: 'Company ID is required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  if (!canEditDepartments(membership.role)) {
    return c.json({ error: 'Only owners and admins can sync departments' }, 403)
  }

  try {
    // Same folder listing as GET /, from the bare repo's shared branch
    const folders = await listFoldersFromRepo(companyId)

    // Get existing DB records
    const dbDepts = db.prepare(`
      SELECT * FROM departments WHERE company_id = ?
    `).all(companyId) as Record<string, unknown>[]

    const dbFolders = new Set(dbDepts.map(d => d.folder as string))
    const fsFolders = new Set(folders)

    const timestamp = now()
    let added = 0
    let removed = 0

    // Add folders that exist in FS but not in DB
    for (const folder of folders) {
      if (!dbFolders.has(folder)) {
        const id = generateId()
        const maxOrder = db.prepare(`
          SELECT MAX(sort_order) as max FROM departments WHERE company_id = ?
        `).get(companyId) as { max: number | null }
        const sortOrder = (maxOrder?.max ?? -1) + 1

        db.prepare(`
          INSERT INTO departments (
            id, company_id, parent_id,
            name, name_en, folder,
            icon, color, description,
            sort_order, is_active,
            created_at, updated_at, created_by
          ) VALUES (?, ?, NULL, ?, NULL, ?, 'Folder', '#6366f1', NULL, ?, 1, ?, ?, ?)
        `).run(id, companyId, folder, folder, sortOrder, timestamp, timestamp, user.id)
        added++
      }
    }

    // Remove DB records for folders that no longer exist
    for (const dept of dbDepts) {
      if (!fsFolders.has(dept.folder as string)) {
        db.prepare('DELETE FROM departments WHERE id = ?').run(dept.id)
        removed++
      }
    }

    // Departments added/removed above get / lose their permission scopes
    syncCompanyScopes(db, companyId)

    return c.json({
      success: true,
      message: `Synced: ${added} added, ${removed} removed`,
      added,
      removed,
    })
  } catch (error) {
    console.error('Failed to sync departments:', error)
    return c.json({
      error: `Failed to sync: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }, 500)
  }
})

// ============================================================================
// Department managers (部署の責任者)
//
// Owner/admin assign them per department. In Phase 1 the assignment is only
// stored and exposed; being a manager grants no file access (see
// lib/permissions.ts).
// ============================================================================

function departmentInCompany(deptId: string, companyId: string): boolean {
  return !!db.prepare('SELECT 1 FROM departments WHERE id = ? AND company_id = ?').get(deptId, companyId)
}

function managerList(deptId: string): Array<{ userId: string; name: string | null; email: string | null }> {
  const ids = listDepartmentManagerIds(db, deptId)
  const users = getUsersByIds(ids)
  return ids.map(id => ({ userId: id, name: users.get(id)?.name ?? null, email: users.get(id)?.email ?? null }))
}

// GET /api/companies/:companyId/departments/:id/managers - any member (read-only)
departmentsRoute.get('/:id/managers', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const deptId = c.req.param('id')
  if (!companyId || !deptId) {
    return c.json({ error: 'Company ID and Department ID are required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }
  if (!departmentInCompany(deptId, companyId)) {
    return c.json({ error: 'Department not found' }, 404)
  }

  return c.json({ success: true, data: { managers: managerList(deptId) } })
})

export const MAX_MANAGERS_PER_DEPARTMENT = 50

// PUT /api/companies/:companyId/departments/:id/managers - owner/admin; replaces the set
departmentsRoute.put('/:id/managers', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('companyId')
  const deptId = c.req.param('id')
  if (!companyId || !deptId) {
    return c.json({ error: 'Company ID and Department ID are required' }, 400)
  }

  const membership = getUserMembership(user.id, companyId)
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }
  if (!canEditDepartments(membership.role)) {
    return c.json({ error: 'Only owners and admins can assign department managers' }, 403)
  }
  if (!departmentInCompany(deptId, companyId)) {
    return c.json({ error: 'Department not found' }, 404)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const userIds = (body as { userIds?: unknown } | null)?.userIds
  if (!Array.isArray(userIds) || !userIds.every(id => typeof id === 'string' && id.length > 0)) {
    return c.json({ error: 'userIds must be an array of user IDs' }, 400)
  }
  const unique = [...new Set(userIds as string[])]
  if (unique.length > MAX_MANAGERS_PER_DEPARTMENT) {
    return c.json({ error: `A department can have at most ${MAX_MANAGERS_PER_DEPARTMENT} managers` }, 400)
  }
  const notMembers = unique.filter(id => !getUserMembership(id, companyId))
  if (notMembers.length > 0) {
    return c.json({ error: `Not members of this company: ${notMembers.join(', ')}` }, 400)
  }

  replaceDepartmentManagers(db, deptId, unique, user.id)

  return c.json({ success: true, data: { managers: managerList(deptId) } })
})
