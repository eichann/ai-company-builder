import { Hono } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { toCamelCase } from '../lib/camel-case'
import { isValidFolderName } from '../../shared/core/names'
import type {
  Department,
  CreateDepartmentInput,
  UpdateDepartmentInput,
  ReorderDepartmentItem,
} from '../../shared/types'
import { services } from '../composition'
import { requireFullAccess } from '../services/access'
import { INVALID_FOLDER_NAME_ERROR, MAX_MANAGERS_PER_DEPARTMENT } from '../services/departments'
import type { DepartmentRow } from '../ports/departments'
import { refusal } from './respond'
import { logError } from '../lib/error-log'

export { MAX_MANAGERS_PER_DEPARTMENT }

export const departmentsRoute = new Hono()
const { access, departments } = services

// A departments row as the API returns it — camelCase keys, and is_active
// (SQLite 0/1) as a boolean
function departmentToCamelCase(row: DepartmentRow): Record<string, unknown> {
  const result = toCamelCase(row)
  if (Object.prototype.hasOwnProperty.call(row, 'is_active')) result.isActive = Boolean(row.is_active)
  return result
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error')

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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)

  try {
    // Folders of the shared branch, read from the bare repo (no pull/clone);
    // DB-registered departments only
    const rows = await departments.list(member.value)
    return c.json({
      success: true,
      data: rows.map(departmentToCamelCase) as unknown as Department[],
    })
  } catch (error) {
    logError('departments', 'failed to list departments', error)
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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)

  const department = departments.get(member.value, deptId)
  if (!department.ok) return refusal(c, department)

  return c.json({
    success: true,
    data: departmentToCamelCase(department.value),
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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireFullAccess(member.value, 'Only owners and admins can create departments')
  if (!actor.ok) return refusal(c, actor)

  const body = await c.req.json() as CreateDepartmentInput

  // Validate required fields
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: 'Department name is required' }, 400)
  }

  if (!body.folder || typeof body.folder !== 'string' || body.folder.trim().length === 0) {
    return c.json({ error: 'Folder name is required' }, 400)
  }

  if (!isValidFolderName(body.folder)) {
    return c.json({ error: INVALID_FOLDER_NAME_ERROR }, 400)
  }

  // A private folder's path is reserved in the company repository.
  const available = departments.checkFolderAvailable(actor.value, body.folder)
  if (!available.ok) return refusal(c, available)

  try {
    const created = await departments.create(actor.value, body)
    if (!created.ok) return refusal(c, created)

    return c.json({
      success: true,
      data: departmentToCamelCase(created.value),
    }, 201)
  } catch (error) {
    logError('departments', 'failed to create a department', error)
    return c.json({
      error: `Failed to create department: ${errorMessage(error)}`,
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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireFullAccess(member.value, 'Only owners and admins can update departments')
  if (!actor.ok) return refusal(c, actor)

  const existing = departments.get(actor.value, deptId)
  if (!existing.ok) return refusal(c, existing)

  const body = await c.req.json() as UpdateDepartmentInput

  try {
    // A new folder name must pass isValidFolderName (checked in the service,
    // after the repository check, as it always was)
    const updated = await departments.update(actor.value, existing.value, body)
    if (!updated.ok) return refusal(c, updated)

    return c.json({
      success: true,
      data: departmentToCamelCase(updated.value),
    })
  } catch (error) {
    logError('departments', 'failed to update a department', error)
    return c.json({
      error: `Failed to update department: ${errorMessage(error)}`,
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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireFullAccess(member.value, 'Only owners and admins can delete departments')
  if (!actor.ok) return refusal(c, actor)

  const existing = departments.get(actor.value, deptId)
  if (!existing.ok) return refusal(c, existing)

  // Deleting the folder would strand its private folders' repositories.
  const deletable = departments.checkDeletable(actor.value, existing.value)
  if (!deletable.ok) return refusal(c, deletable)

  try {
    const { deletedFiles, deletedFolders } = await departments.delete(actor.value, existing.value)

    return c.json({
      success: true,
      message: deletedFiles > 0
        ? `Department deleted with ${deletedFiles} file(s) and ${deletedFolders} subfolder(s)`
        : 'Department deleted',
      deletedFiles,
      deletedFolders,
    })
  } catch (error) {
    logError('departments', 'failed to delete a department', error)
    return c.json({
      error: `Failed to delete department: ${errorMessage(error)}`,
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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)

  const existing = departments.get(member.value, deptId)
  if (!existing.ok) return refusal(c, existing)

  // Read from the bare repo's shared branch (no pull/clone)
  return c.json({
    success: true,
    data: await departments.stats(member.value, existing.value),
  })
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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireFullAccess(member.value, 'Only owners and admins can reorder departments')
  if (!actor.ok) return refusal(c, actor)

  const body = await c.req.json() as { items: ReorderDepartmentItem[] }

  if (!body.items || !Array.isArray(body.items)) {
    return c.json({ error: 'items array is required' }, 400)
  }

  departments.reorder(actor.value, body.items)

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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireFullAccess(member.value, 'Only owners and admins can sync departments')
  if (!actor.ok) return refusal(c, actor)

  try {
    // Same folder listing as GET /, from the bare repo's shared branch
    const { added, removed } = await departments.syncWithRepo(actor.value)

    return c.json({
      success: true,
      message: `Synced: ${added} added, ${removed} removed`,
      added,
      removed,
    })
  } catch (error) {
    logError('departments', 'failed to sync departments', error)
    return c.json({
      error: `Failed to sync: ${errorMessage(error)}`,
    }, 500)
  }
})

// ============================================================================
// Department managers (部署の責任者)
//
// Owner/admin assign them per department. Being a manager grants no file
// access by itself (see shared/core/permissions.ts).
// ============================================================================

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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)
  const found = departments.exists(member.value, deptId)
  if (!found.ok) return refusal(c, found)

  return c.json({ success: true, data: { managers: departments.managers(member.value, deptId) } })
})

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

  const member = access.member(companyId, user.id)
  if (!member.ok) return refusal(c, member)
  const actor = requireFullAccess(member.value, 'Only owners and admins can assign department managers')
  if (!actor.ok) return refusal(c, actor)
  const found = departments.exists(actor.value, deptId)
  if (!found.ok) return refusal(c, found)

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

  const managers = departments.replaceManagers(actor.value, deptId, userIds as string[])
  if (!managers.ok) return refusal(c, managers)

  return c.json({ success: true, data: { managers: managers.value } })
})
