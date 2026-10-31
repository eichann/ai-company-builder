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
