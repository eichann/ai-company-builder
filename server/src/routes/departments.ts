import { Hono } from 'hono'
import { toCamelCase } from '../lib/camel-case'
import { isValidFolderName } from '../../shared/core/names'
import { z } from 'zod'
import type { Department } from '../../shared/types'
import { services } from '../composition'
import { requireFullAccess } from '../services/access'
import { INVALID_FOLDER_NAME_ERROR, MAX_MANAGERS_PER_DEPARTMENT } from '../services/departments'
import type { DepartmentRow } from '../ports/departments'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'
import { logError } from '../lib/error-log'

export { MAX_MANAGERS_PER_DEPARTMENT }

export const departmentsRoute = new Hono()
const { departments, taskSettings } = services

// A departments row as the API returns it — camelCase keys, and is_active
// (SQLite 0/1) as a boolean
function departmentToCamelCase(row: DepartmentRow): Record<string, unknown> {
  const result = toCamelCase(row)
  if (Object.prototype.hasOwnProperty.call(row, 'is_active')) result.isActive = Boolean(row.is_active)
  return result
}

// Request bodies (shared/types CreateDepartmentInput / UpdateDepartmentInput / ReorderDepartmentItem).
// Parsed after the role check, so a member without the role still gets 403 first.
const optionalText = z.string().nullable().optional().transform(v => v ?? undefined)
const CreateDepartmentBody = z.object({
  name: z.string().refine(v => v.trim().length > 0),
  folder: z.string().refine(v => v.trim().length > 0),
  parentId: z.string().nullable().optional(),
  nameEn: optionalText,
  icon: optionalText,
  color: optionalText,
  description: optionalText,
})
const UpdateDepartmentBody = z.object({
  name: z.string().optional(),
  folder: z.string().optional(),
  // The admin console clears these with null (department-form-dialog.tsx).
  nameEn: z.string().nullable().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  isActive: z.boolean().optional(),
})
const ReorderBody = z.object({
  items: z.array(z.object({ id: z.string(), sortOrder: z.number(), parentId: z.string().nullable().optional() })),
})
const ManagersBody = z.object({ userIds: z.array(z.string().min(1)) })
const INVALID_BODY = 'Invalid request body'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error')

// GET /api/companies/:companyId/departments - List departments
departmentsRoute.get('/', companyMember, async (c) => {
  const member = c.var.member

  try {
    // Folders of the shared branch, read from the bare repo (no pull/clone);
    // DB-registered departments only
    const rows = await departments.list(member)
    return c.json({
      success: true,
      data: rows.map(departmentToCamelCase) as unknown as Department[],
    })
  } catch (error) {
    // A failure is an error, never an empty list (code review 2026-11): "no
    // departments" made the app and the admin console look as if the company
    // had none. Released apps treat a non-OK answer as "could not load".
    // A company created since its creation became all or nothing always has
    // its repository; an empty one answers [] (repo-folders.ts).
    logError('departments', 'failed to list departments', error)
    return c.json({ error: 'Failed to list departments' }, 500)
  }
})

// GET /api/companies/:companyId/departments/:id - Get single department
departmentsRoute.get('/:id', companyMember, async (c) => {
  const deptId = c.req.param('id')
  const member = c.var.member

  const department = departments.get(member, deptId)
  if (!department.ok) return refusal(c, department)

  return c.json({
    success: true,
    data: departmentToCamelCase(department.value),
  })
})

// POST /api/companies/:companyId/departments - Create department (creates folder)
departmentsRoute.post('/', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can create departments')
  if (!actor.ok) return refusal(c, actor)

  const parsed = CreateDepartmentBody.safeParse(c.var.body)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    if (field === 'name') return c.json({ error: 'Department name is required' }, 400)
    if (field === 'folder') return c.json({ error: 'Folder name is required' }, 400)
    return c.json({ error: INVALID_BODY }, 400)
  }
  const body = parsed.data

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
departmentsRoute.put('/:id', companyMember, serviceBody, async (c) => {
  const deptId = c.req.param('id')
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can update departments')
  if (!actor.ok) return refusal(c, actor)

  const existing = departments.get(actor.value, deptId)
  if (!existing.ok) return refusal(c, existing)

  const parsed = UpdateDepartmentBody.safeParse(c.var.body)
  if (!parsed.success) return c.json({ error: INVALID_BODY }, 400)
  const body = parsed.data

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
departmentsRoute.delete('/:id', companyMember, async (c) => {
  const deptId = c.req.param('id')
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can delete departments')
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
departmentsRoute.get('/:id/stats', companyMember, async (c) => {
  const deptId = c.req.param('id')
  const member = c.var.member

  const existing = departments.get(member, deptId)
  if (!existing.ok) return refusal(c, existing)

  // Read from the bare repo's shared branch (no pull/clone). A failure is an
  // error, never "empty": the admin console asks before deleting with these counts.
  try {
    return c.json({
      success: true,
      data: await departments.stats(member, existing.value),
    })
  } catch (error) {
    logError('departments', 'failed to count a department folder', error)
    return c.json({ error: 'Failed to read the department folder' }, 500)
  }
})

// POST /api/companies/:companyId/departments/reorder - Reorder departments
departmentsRoute.post('/reorder', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can reorder departments')
  if (!actor.ok) return refusal(c, actor)

  const parsed = ReorderBody.safeParse(c.var.body)
  if (!parsed.success) return c.json({ error: 'items array is required' }, 400)

  departments.reorder(actor.value, parsed.data.items)

  return c.json({
    success: true,
    message: 'Departments reordered',
  })
})

// POST /api/companies/:companyId/departments/sync - Sync DB with file system
departmentsRoute.post('/sync', companyMember, async (c) => {
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can sync departments')
  if (!actor.ok) return refusal(c, actor)

  try {
    // Same folder listing as GET /, from the bare repo's shared branch
    const synced = await departments.syncWithRepo(actor.value)
    if (!synced.ok) return refusal(c, synced)
    const { added, removed } = synced.value

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
// Department managers (部署の管理役)
//
// Owner/admin assign them per department. Being a manager grants no file
// access by itself (see shared/core/permissions.ts).
// ============================================================================

// GET /api/companies/:companyId/departments/:id/managers - any member (read-only)
departmentsRoute.get('/:id/managers', companyMember, async (c) => {
  const deptId = c.req.param('id')
  const member = c.var.member
  const found = departments.exists(member, deptId)
  if (!found.ok) return refusal(c, found)

  return c.json({ success: true, data: { managers: departments.managers(member, deptId) } })
})

// PUT /api/companies/:companyId/departments/:id/managers - owner/admin; replaces the set
departmentsRoute.put('/:id/managers', companyMember, serviceBody, async (c) => {
  const deptId = c.req.param('id')
  const member = c.var.member
  const actor = requireFullAccess(member, 'Only owners and admins can assign department managers')
  if (!actor.ok) return refusal(c, actor)
  const found = departments.exists(actor.value, deptId)
  if (!found.ok) return refusal(c, found)

  if (c.var.body === null) return c.json({ error: 'Invalid JSON body' }, 400)
  const parsed = ManagersBody.safeParse(c.var.body)
  if (!parsed.success) return c.json({ error: 'userIds must be an array of user IDs' }, 400)

  const managers = departments.replaceManagers(actor.value, deptId, parsed.data.userIds)
  if (!managers.ok) return refusal(c, managers)

  return c.json({ success: true, data: { managers: managers.value } })
})

// ============================================================================
// Department membership (所属する部署, stage 2 S6, .claude/rules/tasks.md)
//
// Who belongs to a department: any member reads; owner/admin and that
// department's managers replace it. Where a rule names the department (every
// department created since 2026-11-06), who belongs decides who writes there,
// so a change runs the outdated-app guard (409 OUTDATED_CLIENTS, `force`).
// ============================================================================

// GET /api/companies/:companyId/departments/:id/members - any member (read-only)
departmentsRoute.get('/:id/members', companyMember, async (c) => {
  const member = c.var.member
  const result = taskSettings.departmentMembers(member, c.req.param('id') ?? '')
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})

// PUT /api/companies/:companyId/departments/:id/members - owner/admin or this department's managers; replaces the set
departmentsRoute.put('/:id/members', companyMember, serviceBody, async (c) => {
  const member = c.var.member
  const result = taskSettings.setDepartmentMembers(member, c.req.param('id') ?? '', c.var.body)
  if (!result.ok) return refusal(c, result)
  return c.json({ success: true, data: result.value })
})
