// The company selector's screens and the departments it offers or finds, without React.
import type { DepartmentInfo, DirectoryEntry } from '../../../shared/ipc-contract'
import type { FolderSetupPlan } from './folderPlan'

/** list → (create →) folder choice (clone: 既存 / 新しく; openExisting: 新しく作成) → departments → setup. */
export type SelectorView = 'list' | 'create' | 'clone' | 'openExisting' | 'departments' | 'setup'

/** What the setup screen is doing: a first download, reopening a clone, or the owner's first upload. */
export type SetupKind = Exclude<FolderSetupPlan['kind'], 'error'>

export type SetupStep = 'folder' | 'git' | 'done'

export interface PickableDepartment {
  id: string
  name: string
  folder: string
}

/** Departments the picker offers: root folders only (a sparse exclusion is per root folder here). */
export function pickableDepartments(departments: DepartmentInfo[]): PickableDepartment[] {
  return departments
    .filter(d => d.folder && !d.folder.includes('/'))
    .map(d => ({ id: d.id, name: d.name, folder: d.folder }))
}

// The ids the retired department templates gave their folders; any other folder's id is its name in lower case.
const TEMPLATE_DEPARTMENT_IDS = new Map([
  ['shared', 'common'], ['hr', 'hr'], ['sales', 'sales'],
  ['development', 'dev'], ['accounting', 'finance'], ['general', 'general'],
])

export function departmentIdFor(folderName: string): string {
  return TEMPLATE_DEPARTMENT_IDS.get(folderName) || folderName.toLowerCase()
}

/** A folder in the company folder's root that is a department (not `_…` or `.…`). */
export function isDepartmentEntry(entry: DirectoryEntry): boolean {
  return entry.isDirectory && !entry.name.startsWith('_') && !entry.name.startsWith('.')
}

/**
 * The folders a first setup downloads without asking (管理画面の見直し 2-2): the departments
 * the member belongs to (所属), in the list's order. Empty = nothing known → ask as before.
 * Only for a first setup (a folder with nothing downloaded): an existing clone's choices are
 * never changed (download-choices.md "First setup").
 */
export function membershipFolders(departments: PickableDepartment[], myDepartmentIds: readonly string[] | null | undefined): string[] {
  const mine = new Set(myDepartmentIds ?? [])
  return departments.filter(d => mine.has(d.id)).map(d => d.folder)
}

/**
 * The company opened without choosing (2-2 「会社が1つなら選ばせない」): the only one, unless
 * a company is remembered for this member (App.tsx restores that one; starting another setup
 * beside it would race it).
 */
export function companyToOpenWithoutChoosing<T>(companies: readonly T[], remembered: boolean): T | null {
  return !remembered && companies.length === 1 ? companies[0] : null
}
