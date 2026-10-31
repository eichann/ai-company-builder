/**
 * Departments: folder on the shared branch = source of truth, row = display
 * settings (order, icon, color, display name), scope = permission rules,
 * managers = who may edit them (.claude/rules/server.md "Departments").
 *
 * Folder changes go through the RepoStore (commits built in the bare
 * repository, company lock, async git); the rows follow only once the folder change succeeded. A
 * private folder's path is reserved: no department may take it, and a
 * department containing one can be neither renamed nor deleted.
 */
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { DepartmentChanges, DepartmentRow } from '../ports/departments'
import type { MembershipRepository } from '../ports/memberships'
import type { RepoStore } from '../ports/repo-store'
import type { Transactions } from '../ports/transactions'
import { pathKey } from '../../shared/core/paths'
import { isValidFolderName } from '../../shared/core/names'
import { reservedPathMessage } from '../../shared/types/private-folders'
import type { CreateDepartmentInput, UpdateDepartmentInput } from '../../shared/types'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const MAX_MANAGERS_PER_DEPARTMENT = 50

export const INVALID_FOLDER_NAME_ERROR =
  'Invalid folder name. Use letters, numbers, Japanese characters, dots, hyphens, and underscores.'

const FOLDER_EXISTS_ERROR = 'A folder with this name already exists'

export interface ManagerView {
  userId: string
  name: string | null
  email: string | null
}

export interface DepartmentServiceDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  accounts: AccountDirectory
  repoStore: RepoStore
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

export function createDepartmentService(deps: DepartmentServiceDeps) {
  const { companyData, memberships, accounts, repoStore, transactions, clock, ids } = deps
  // Company handles (ports/company-data.ts): the company is always the member's / the one just checked.
  const scopesOf = (companyId: string) => companyData.forCompany(companyId).scopes
  const privateFoldersOf = (companyId: string) => companyData.forCompany(companyId).privateFolders

  // Private folders whose path is `folder` or inside it, compared NFC + A–Z
  // folded. Department endpoints are owner/admin only, who may see every
  // private folder.
  function privateFoldersAtOrUnder(companyId: string, folder: string): string[] {
    const key = pathKey(folder)
    return privateFoldersOf(companyId).paths().filter(p => {
      const k = pathKey(p)
      return k === key || k.startsWith(`${key}/`)
    })
  }

  const folderUnavailable = (folder: string) =>
    refuse('conflict', reservedPathMessage(folder), { code: 'FOLDER_NAME_UNAVAILABLE' })
  const privateInside = () =>
    refuse('conflict', 'This department contains private folders; make them public first', { code: 'PRIVATE_FOLDERS_INSIDE' })

  // The member's company: every department read or write below goes through it.
  const departmentsOf = (member: Member) => companyData.forCompany(member.companyId).departments

  function nextSortOrder(member: Member): number {
    return (departmentsOf(member).maxSortOrder() ?? -1) + 1
  }

  function managers(member: Member, departmentId: string): ManagerView[] {
    const managerIds = scopesOf(member.companyId).departmentManagerIds(departmentId)
    const users = accounts.byIds(managerIds)
    return managerIds.map(id => ({ userId: id, name: users.get(id)?.name ?? null, email: users.get(id)?.email ?? null }))
  }

  return {
    /**
     * The departments whose folder is on the shared branch, by sort_order.
     * Reads the bare repository (no pull/clone); throws without one.
     */
    async list(member: Member): Promise<DepartmentRow[]> {
      const folders = new Set(await repoStore.listRootFolders(member.companyId))
      return departmentsOf(member).list()
        .filter(d => folders.has(d.folder))
        .sort((a, b) => a.sort_order - b.sort_order)
    },

    get(member: Member, departmentId: string): Outcome<DepartmentRow> {
      const department = departmentsOf(member).find(departmentId)
      return department ? ok(department) : refuse('not-found', 'Department not found')
    },

    /** A private folder's path is reserved in the company repository. */
    checkFolderAvailable(member: Member, folder: string): Outcome<void> {
      return privateFoldersAtOrUnder(member.companyId, folder).length > 0 ? folderUnavailable(folder) : ok(undefined)
    },

    /** Deleting the folder would strand its private folders' repositories. */
    checkDeletable(member: Member, department: DepartmentRow): Outcome<void> {
      return privateFoldersAtOrUnder(member.companyId, department.folder).length > 0 ? privateInside() : ok(undefined)
    },

    /**
     * Create the folder (a commit on the shared branch), then the row and its permission
     * scope (no rules: inherits from the company). Throws when git fails.
     */
    async create(member: Member, body: CreateDepartmentInput): Promise<Outcome<DepartmentRow>> {
      const { companyId, userId } = member
      if (!await repoStore.createDepartmentFolder(companyId, body.folder, `Add department: ${body.name}`)) {
        return refuse('conflict', FOLDER_EXISTS_ERROR)
      }

      const id = ids.newId()
      const timestamp = clock.now()
      const departments = departmentsOf(member)
      departments.insert({
        id,
        name: body.name.trim(),
        nameEn: body.nameEn || null,
        folder: body.folder.trim(),
        icon: body.icon || 'Folder',
        color: body.color || '#6366f1',
        description: body.description || null,
        sortOrder: nextSortOrder(member),
        createdAt: timestamp,
        createdBy: userId,
      })
      scopesOf(companyId).ensureDepartmentScope(id, body.folder.trim(), userId)

      return ok(departments.find(id)!)
    },

    /**
     * Update display settings; a new folder name renames the folder first
     * (only a rename touches the repository). Private folders do not move
     * with a rename (their own repositories, every reader's checkout), so a
     * department containing one cannot be renamed, and the new name may not
     * be reserved. Throws when the repository is missing or git fails.
     */
    async update(member: Member, existing: DepartmentRow, body: UpdateDepartmentInput): Promise<Outcome<DepartmentRow>> {
      const { companyId, userId } = member
      if (!repoStore.companyRepoExists(companyId)) {
        throw new Error('Repository not found')
      }
      const oldFolder = existing.folder

      if (body.folder !== undefined && body.folder !== oldFolder) {
        if (!isValidFolderName(body.folder)) {
          return refuse('bad-request', INVALID_FOLDER_NAME_ERROR)
        }
        const newFolder = body.folder
        if (privateFoldersAtOrUnder(companyId, oldFolder).length > 0) return privateInside()
        if (privateFoldersAtOrUnder(companyId, newFolder).length > 0) return folderUnavailable(newFolder)

        const renamed = await repoStore.renameDepartmentFolder(
          companyId, oldFolder, newFolder, `Rename department: ${oldFolder} -> ${newFolder}`,
        )
        if (!renamed) {
          return refuse('conflict', FOLDER_EXISTS_ERROR)
        }
      }

      const changes: DepartmentChanges = {
        name: body.name !== undefined ? body.name.trim() : undefined,
        nameEn: body.nameEn,
        folder: body.folder !== undefined ? body.folder.trim() : undefined,
        icon: body.icon,
        color: body.color,
        description: body.description,
        isActive: body.isActive,
      }

      const departments = departmentsOf(member)
      if (Object.values(changes).some(v => v !== undefined)) {
        const updatedAt = clock.now()
        transactions.run(() => {
          departments.update(existing.id, changes, updatedAt)
          // Folder renamed: the department's scope and every folder scope
          // under it move with it (rules stay attached).
          if (body.folder !== undefined && body.folder.trim() !== oldFolder) {
            scopesOf(companyId).moveScopeSubtree(oldFolder, body.folder.trim())
            scopesOf(companyId).ensureDepartmentScope(existing.id, body.folder.trim(), userId)
          }
        })
      }

      return ok(departments.find(existing.id)!)
    },

    /**
     * Delete the folder (a commit on the shared branch), then the row with the department's
     * scopes, their rules and its managers. Throws when git fails.
     */
    async delete(member: Member, existing: DepartmentRow): Promise<{ deletedFiles: number; deletedFolders: number }> {
      const { companyId } = member
      const folder = existing.folder
      const counts = await repoStore.deleteDepartmentFolder(companyId, folder, `Delete department: ${existing.name} (${folder})`)
      transactions.run(() => {
        scopesOf(companyId).deleteDepartmentScopes(existing.id, folder)
        departmentsOf(member).delete(existing.id)
      })
      return counts
    },

    /** Files and folders in the department's folder on the shared branch (delete warning). */
    async stats(member: Member, existing: DepartmentRow): Promise<{ files: number; folders: number; exists: boolean }> {
      try {
        const counts = await repoStore.countFilesInFolder(member.companyId, existing.folder)
        return counts ? { ...counts, exists: true } : { files: 0, folders: 0, exists: false }
      } catch {
        return { files: 0, folders: 0, exists: false }
      }
    },

    reorder(member: Member, items: Array<{ id: string; sortOrder: number }>): void {
      departmentsOf(member).setSortOrders(items, clock.now())
    },

    /**
     * Rows follow the shared branch's root folders: a row for each folder
     * without one, none for folders that are gone; scopes follow the rows.
     * Throws without a repository.
     */
    async syncWithRepo(member: Member): Promise<{ added: number; removed: number }> {
      const { companyId, userId } = member
      const folders = await repoStore.listRootFolders(companyId)
      const departments = departmentsOf(member)
      const rows = departments.listUnordered()

      const rowFolders = new Set(rows.map(d => d.folder))
      const repoFolders = new Set(folders)
      const timestamp = clock.now()
      let added = 0
      let removed = 0

      for (const folder of folders) {
        if (!rowFolders.has(folder)) {
          departments.insert({
            id: ids.newId(),
            name: folder,
            nameEn: null,
            folder,
            icon: 'Folder',
            color: '#6366f1',
            description: null,
            sortOrder: nextSortOrder(member),
            createdAt: timestamp,
            createdBy: userId,
          })
          added++
        }
      }

      for (const row of rows) {
        if (!repoFolders.has(row.folder)) {
          departments.delete(row.id)
          removed++
        }
      }

      scopesOf(companyId).syncCompanyScopes()
      return { added, removed }
    },

    /** The department, when it belongs to the member's company. */
    exists(member: Member, departmentId: string): Outcome<void> {
      return departmentsOf(member).exists(departmentId) ? ok(undefined) : refuse('not-found', 'Department not found')
    },

    managers,

    /** Replace the managers (owner/admin acting); every one must be a member. */
    replaceManagers(member: Member, departmentId: string, userIds: string[]): Outcome<ManagerView[]> {
      const unique = [...new Set(userIds)]
      if (unique.length > MAX_MANAGERS_PER_DEPARTMENT) {
        return refuse('bad-request', `A department can have at most ${MAX_MANAGERS_PER_DEPARTMENT} managers`)
      }
      const notMembers = unique.filter(id => memberships.roleOf(member.companyId, id) === null)
      if (notMembers.length > 0) {
        return refuse('bad-request', `Not members of this company: ${notMembers.join(', ')}`)
      }
      scopesOf(member.companyId).replaceDepartmentManagers(departmentId, unique, member.userId)
      return ok(managers(member, departmentId))
    },
  }
}

export type DepartmentService = ReturnType<typeof createDepartmentService>
