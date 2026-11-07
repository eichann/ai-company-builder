/**
 * Departments: folder on the shared branch = source of truth, row = display
 * settings (order, icon, color, display name), scope = permission rules,
 * managers = who may edit them (.claude/rules/server.md "Departments").
 *
 * Folder changes go through the RepoStore (commits built in the bare
 * repository, company lock, async git); the rows follow only once the folder change succeeded. A
 * private folder's path is reserved: no department may take it, and a
 * department containing one can be neither renamed nor deleted.
 *
 * A company without the shared folder (services/company-folder.ts, owner decision 2026-11-07)
 * has no repository: its departments are its rows, and creating / renaming / deleting one
 * changes only rows (a folder name is taken when another department has it, compared as
 * `nameKey`). Nothing pretends a repository is there.
 */
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { DepartmentChanges, DepartmentRow } from '../ports/departments'
import type { MembershipRepository } from '../ports/memberships'
import type { RepoStore } from '../ports/repo-store'
import type { Transactions } from '../ports/transactions'
import { nameKey, pathKey } from '../../shared/core/paths'
import { isValidFolderName } from '../../shared/core/names'
import { reservedPathMessage } from '../../shared/types/private-folders'
import type { CreateDepartmentInput, UpdateDepartmentInput } from '../../shared/types'
import type { Member } from './access'
import type { CompanyFolders } from './company-folder'
import { ok, refuse, type Outcome } from './outcome'

export const MAX_MANAGERS_PER_DEPARTMENT = 50

export const INVALID_FOLDER_NAME_ERROR =
  'Invalid folder name. Use letters, numbers, Japanese characters, dots, hyphens, and underscores.'

const FOLDER_EXISTS_ERROR = 'A folder with this name already exists'

/** 「Skill を直せる人」 (`GET /skill-editors`). */
export interface SkillEditorsView {
  /** 「全員が直せる」 is on: the lists are kept, and count again when it goes off. */
  everyone: boolean
  company: ManagerView[]
  departments: Array<{ departmentId: string; editors: ManagerView[] }>
}

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
  companyFolders: CompanyFolders
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

export function createDepartmentService(deps: DepartmentServiceDeps) {
  const { companyData, memberships, accounts, repoStore, companyFolders, transactions, clock, ids } = deps
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

  // Without the shared folder: is `folder` another department's folder (nameKey: NFC, A–Z folded)?
  const folderTakenByRow = (member: Member, folder: string, exceptId: string | null) =>
    departmentsOf(member).listUnordered().some(d => d.id !== exceptId && nameKey(d.folder) === nameKey(folder))

  function nextSortOrder(member: Member): number {
    return (departmentsOf(member).maxSortOrder() ?? -1) + 1
  }

  function skillEditors(member: Member): SkillEditorsView {
    const scopes = scopesOf(member.companyId)
    const view = (ids: string[]): ManagerView[] => {
      const users = accounts.byIds(ids)
      return ids.map(id => ({ userId: id, name: users.get(id)?.name ?? null, email: users.get(id)?.email ?? null }))
    }
    return {
      everyone: scopes.skillEditingOpen(),
      company: view(scopes.skillEditorIds(null)),
      departments: departmentsOf(member).listUnordered()
        .map(d => ({ departmentId: d.id, editors: view(scopes.skillEditorIds(d.id)) }))
        .filter(d => d.editors.length > 0),
    }
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
      // Without the shared folder the rows are the departments.
      if (!companyFolders.has(member.companyId)) return departmentsOf(member).list().sort((a, b) => a.sort_order - b.sort_order)
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
      if (privateFoldersAtOrUnder(member.companyId, department.folder).length > 0) return privateInside()
      // A read-restricted place (a company without the shared folder, server.md "Groups") at or
      // under it: deleting would drop its rules, and the records placed there would fall back to
      // the company's rules — readable by everyone. Its readers are changed first, on purpose.
      const key = pathKey(department.folder)
      const restricted = scopesOf(member.companyId).listWithRules()
        .some(s => s.readRestricted === true && (pathKey(s.path) === key || pathKey(s.path).startsWith(`${key}/`)))
      return restricted
        ? refuse('conflict', 'この部署には見られる人を決めた場所があります。先にその設定を「全員」に戻してください。', { code: 'RESTRICTED_PLACES_INSIDE' })
        : ok(undefined)
    },

    /**
     * Create the folder (a commit on the shared branch), then the row and its permission
     * scope, in one transaction. The scope starts with `everyone: read` + `department:
     * read + write` (owner decision 2026-11-06): everyone reads; only the people who
     * belong to it (所属, PUT /:id/members) and owners/admins write. So until someone is
     * added, only owners and admins write there. Throws when git fails.
     */
    async create(member: Member, body: CreateDepartmentInput): Promise<Outcome<DepartmentRow>> {
      const { companyId, userId } = member
      if (!companyFolders.has(companyId)) {
        if (folderTakenByRow(member, body.folder.trim(), null)) return refuse('conflict', FOLDER_EXISTS_ERROR)
      } else if (!await repoStore.createDepartmentFolder(companyId, body.folder, `Add department: ${body.name}`)) {
        return refuse('conflict', FOLDER_EXISTS_ERROR)
      }

      const id = ids.newId()
      const timestamp = clock.now()
      const departments = departmentsOf(member)
      transactions.run(() => {
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
        scopesOf(companyId).seedDepartmentMemberWriting(id, userId)
      })

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
      const withFolder = companyFolders.has(companyId)
      if (withFolder && !repoStore.companyRepoExists(companyId)) {
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

        const renamed = withFolder
          ? await repoStore.renameDepartmentFolder(companyId, oldFolder, newFolder, `Rename department: ${oldFolder} -> ${newFolder}`)
          // Only rows: a case-only rename of its own folder is allowed, as with a repository.
          : !folderTakenByRow(member, newFolder, existing.id)
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
            // Records go with it (records.md "Links to files"): server records' readers' folder
            // (else they would take the old path's rules), links to files under it, the minutes
            // folder. No private folder is inside (refused above), so nothing private moves.
            companyData.forCompany(companyId).records.moveFolder(oldFolder, body.folder.trim())
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
      const counts = companyFolders.has(companyId)
        ? await repoStore.deleteDepartmentFolder(companyId, folder, `Delete department: ${existing.name} (${folder})`)
        : { deletedFiles: 0, deletedFolders: 0 }
      transactions.run(() => {
        // Who belonged goes with the department (ON DELETE CASCADE): recorded with the other
        // changes of who reads and writes (permission_history, server.md "Groups"), in the same transaction.
        const handle = companyData.forCompany(companyId)
        const members = handle.tasks.departmentMemberIds(existing.id)
        scopesOf(companyId).deleteDepartmentScopes(existing.id, folder)
        departmentsOf(member).delete(existing.id)
        handle.permissionHistory.append({
          action: 'department-delete', detail: { departmentId: existing.id, folder, members }, at: clock.now(), byUser: member.userId,
        })
      })
      return counts
    },

    /**
     * Files and folders in the department's folder on the shared branch (delete warning).
     * Throws when git cannot read them: "0 files, no folder" would tell the admin a
     * full folder is empty right before they delete it.
     */
    async stats(member: Member, existing: DepartmentRow): Promise<{ files: number; folders: number; exists: boolean }> {
      // Without the shared folder there is no folder to count: the server holds no files.
      if (!companyFolders.has(member.companyId)) return { files: 0, folders: 0, exists: false }
      const counts = await repoStore.countFilesInFolder(member.companyId, existing.folder)
      return counts ? { ...counts, exists: true } : { files: 0, folders: 0, exists: false }
    },

    reorder(member: Member, items: Array<{ id: string; sortOrder: number }>): void {
      departmentsOf(member).setSortOrders(items, clock.now())
    },

    /**
     * Rows follow the shared branch's root folders: a row for each folder
     * without one, none for folders that are gone; scopes follow the rows.
     * Throws without a repository.
     */
    async syncWithRepo(member: Member): Promise<Outcome<{ added: number; removed: number }>> {
      const { companyId, userId } = member
      // Nothing to follow without the shared folder: the rows are the departments.
      const withFolder = companyFolders.require(member)
      if (!withFolder.ok) return withFolder
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
      return ok({ added, removed })
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

    /** 「Skill を直せる人」: the whole company's list and each department's that has someone on it. */
    skillEditors,

    /** 「全員が直せる」 on or off (owner/admin acting). */
    setSkillEditingOpen(member: Member, open: boolean): SkillEditorsView {
      scopesOf(member.companyId).setSkillEditingOpen(open, member.userId)
      return skillEditors(member)
    },

    /**
     * Replace one list (owner/admin acting; `departmentId` null: the whole
     * company); every one must be a member. A department of another company
     * is simply not found.
     */
    replaceSkillEditors(member: Member, departmentId: string | null, userIds: string[]): Outcome<SkillEditorsView> {
      if (departmentId !== null && !departmentsOf(member).exists(departmentId)) return refuse('not-found', 'Department not found')
      const unique = [...new Set(userIds)]
      if (unique.length > MAX_MANAGERS_PER_DEPARTMENT) {
        return refuse('bad-request', `A list can have at most ${MAX_MANAGERS_PER_DEPARTMENT} people`)
      }
      const notMembers = unique.filter(id => memberships.roleOf(member.companyId, id) === null)
      if (notMembers.length > 0) {
        return refuse('bad-request', `Not members of this company: ${notMembers.join(', ')}`)
      }
      scopesOf(member.companyId).replaceSkillEditors(departmentId, unique, member.userId)
      return ok(skillEditors(member))
    },
  }
}

export type DepartmentService = ReturnType<typeof createDepartmentService>
