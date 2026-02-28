import { Hono } from 'hono'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { db, generateId, now } from '../db'
import { getUserFromRequest } from '../lib/auth'
import type {
  Department,
  DepartmentWithChildren,
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

// Helper: Validate folder name (ASCII only)
function isValidFolderName(folder: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(folder)
}

// Helper: Get bare repo path for a company
function getBareRepoPath(companyId: string): string {
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  return join(REPOS_DIR, `${sanitizedId}.git`)
}

// Helper: Get or create working directory for a company
function getWorkingDir(companyId: string): string {
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  const workDir = join(WORKDIR_DIR, sanitizedId)
  const bareRepo = getBareRepoPath(companyId)

  if (!existsSync(bareRepo)) {
    throw new Error('Repository not found')
  }

  if (!existsSync(workDir)) {
    // Clone from bare repo
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' })
  } else {
    // Ensure remote URL points to correct bare repo path (fixes server migration issues)
    try {
      const currentUrl = execFileSync('git', ['-C', workDir, 'remote', 'get-url', 'origin'], { stdio: 'pipe' }).toString().trim()
      if (currentUrl !== bareRepo) {
        execFileSync('git', ['-C', workDir, 'remote', 'set-url', 'origin', bareRepo], { stdio: 'pipe' })
      }
    } catch {
      // Ignore - remote might not exist yet
    }

    // Pull latest changes
    try {
      execFileSync('git', ['-C', workDir, 'pull', 'origin', 'main'], { stdio: 'pipe' })
    } catch {
      try {
        execFileSync('git', ['-C', workDir, 'pull', 'origin', 'master'], { stdio: 'pipe' })
      } catch {
        // Ignore pull errors (might be empty repo)
      }
    }
  }

  return workDir
}

// Helper: Commit and push changes
function commitAndPush(workDir: string, message: string): void {
  try {
    execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'pipe' })
    execFileSync('git', ['-C', workDir, 'commit', '-m', message, '--allow-empty'], { stdio: 'pipe' })
    try {
      execFileSync('git', ['-C', workDir, 'push', 'origin', 'HEAD'], { stdio: 'pipe' })
    } catch {
      // Ignore push errors (remote might not be available)
    }
  } catch (error) {
    console.error('Git commit/push error:', error)
    // Don't throw - commit might fail if nothing changed
  }
}

// Helper: List folders from file system
function listFoldersFromFileSystem(workDir: string): string[] {
  if (!existsSync(workDir)) {
    return []
  }

  try {
    const items = readdirSync(workDir)
    return items.filter(item => {
      if (item.startsWith('.')) return false // Skip hidden files/folders
      const itemPath = join(workDir, item)
      return existsSync(itemPath) && statSync(itemPath).isDirectory()
    })
  } catch {
    return []
  }
}

// Helper: Count files in a directory (recursive)
function countFilesInDir(dirPath: string): { files: number; folders: number } {
  let files = 0
  let folders = 0

  function count(path: string) {
    if (!existsSync(path)) return
    const items = readdirSync(path)
    for (const item of items) {
      if (item.startsWith('.')) continue
      const itemPath = join(path, item)
      if (statSync(itemPath).isDirectory()) {
        folders++
        count(itemPath)
      } else {
        files++
      }
    }
  }

  count(dirPath)
  return { files, folders }
}

// Helper: Build department data by merging file system and DB
// Auto-creates DB records for folders that don't have one
function buildDepartmentList(companyId: string, folders: string[], userId?: string): Department[] {
  // Get DB settings for this company
  const dbDepts = db.prepare(`
    SELECT * FROM departments WHERE company_id = ? ORDER BY sort_order ASC
  `).all(companyId) as Record<string, unknown>[]

  const dbDeptMap = new Map<string, Record<string, unknown>>()
  for (const d of dbDepts) {
    dbDeptMap.set(d.folder as string, d)
  }

  const result: Department[] = []
  const timestamp = now()

  for (const folder of folders) {
    const dbDept = dbDeptMap.get(folder)

    if (dbDept) {
      // Merge DB settings with folder
      result.push(toCamelCase(dbDept) as unknown as Department)
    } else {
      // Folder exists but not in DB - auto-create a DB record
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
      `).run(id, companyId, folder, folder, sortOrder, timestamp, timestamp, userId || null)

      result.push({
        id,
        companyId,
        parentId: null,
        name: folder,
        nameEn: null,
        folder,
        icon: 'Folder',
        color: '#6366f1',
        description: null,
        sortOrder,
        isActive: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: userId || null,
      })
    }
  }

  // Sort by sortOrder
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
    // Get working directory and list folders
    const workDir = getWorkingDir(companyId)
    const folders = listFoldersFromFileSystem(workDir)

    // Build department list (auto-creates DB records for new folders)
    const departments = buildDepartmentList(companyId, folders, user.id)

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
      error: 'Invalid folder name. Use only ASCII letters, numbers, dots, hyphens, and underscores.',
    }, 400)
  }

  try {
    const workDir = getWorkingDir(companyId)
    const folderPath = join(workDir, body.folder)

    // Check if folder already exists
    if (existsSync(folderPath)) {
      return c.json({ error: 'A folder with this name already exists' }, 409)
    }

    // Create folder with .gitkeep and .personal workspace
    mkdirSync(folderPath, { recursive: true })
    writeFileSync(join(folderPath, '.gitkeep'), '')

    // Create .personal directory (gitignored personal workspace)
    const personalDir = join(folderPath, '.personal')
    mkdirSync(personalDir, { recursive: true })
    writeFileSync(join(personalDir, '.gitignore'), '# Personal workspace — not synced\n*\n!.gitignore\n')

    // Commit and push
    commitAndPush(workDir, `Add department: ${body.name}`)

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
    const workDir = getWorkingDir(companyId)
    const oldFolder = existing.folder as string

    // Handle folder rename if requested
    if (body.folder !== undefined && body.folder !== oldFolder) {
      if (!isValidFolderName(body.folder)) {
        return c.json({
          error: 'Invalid folder name. Use only ASCII letters, numbers, dots, hyphens, and underscores.',
        }, 400)
      }

      const oldPath = join(workDir, oldFolder)
      const newPath = join(workDir, body.folder)

      if (existsSync(newPath)) {
        return c.json({ error: 'A folder with this name already exists' }, 409)
      }

      if (existsSync(oldPath)) {
        // Use git mv for proper tracking
        execFileSync('git', ['-C', workDir, 'mv', oldFolder, body.folder], { stdio: 'pipe' })
        commitAndPush(workDir, `Rename department: ${oldFolder} -> ${body.folder}`)
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

      db.prepare(`
        UPDATE departments SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)
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
    const workDir = getWorkingDir(companyId)
    const folderPath = join(workDir, folder)

    let deletedFiles = 0
    let deletedFolders = 0

    if (existsSync(folderPath)) {
      // Count what will be deleted
      const counts = countFilesInDir(folderPath)
      deletedFiles = counts.files
      deletedFolders = counts.folders

      // Delete the folder
      rmSync(folderPath, { recursive: true, force: true })

      // Commit and push
      execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'pipe' })
      commitAndPush(workDir, `Delete department: ${existing.name} (${folder})`)
    }

    // Remove from DB
    db.prepare('DELETE FROM departments WHERE id = ?').run(deptId)

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
    const workDir = getWorkingDir(companyId)
    const folderPath = join(workDir, existing.folder as string)

    if (!existsSync(folderPath)) {
      return c.json({
        success: true,
        data: { files: 0, folders: 0, exists: false },
      })
    }

    const counts = countFilesInDir(folderPath)

    return c.json({
      success: true,
      data: {
        ...counts,
        exists: true,
      },
    })
  } catch (error) {
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
    const workDir = getWorkingDir(companyId)
    const folders = listFoldersFromFileSystem(workDir)

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
