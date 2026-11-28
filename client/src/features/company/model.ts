// The company selector's screens and the departments it offers or finds, without React.
import type { AuthUser, DepartmentInfo, DirectoryEntry } from '../../../shared/ipc-contract'
import type { FolderSetupPlan } from './folderPlan'

/**
 * Whether 「新しい会社を作成」 is offered: creating a company is the server operators' work
 * (the first company of a fresh server excepted), and the server answers it per account.
 * Hidden only when it says no; an older server's answer lacks the field.
 */
export function offersCompanyCreation(user: Pick<AuthUser, 'canCreateCompany'> | null): boolean {
  return user?.canCreateCompany !== false
}

/**
 * list → (create →) join (「〇〇 に参加します」: the company, the departments for this PC and the
 * place, confirmed with one ［始める］; departments = the picker, from join or before it) → setup.
 */
export type SelectorView = 'list' | 'create' | 'join' | 'departments' | 'setup'

/** What the setup screen is doing: a first download, reopening a clone, or the owner's first upload. */
export type SetupKind = Exclude<FolderSetupPlan['kind'], 'error'>

export type SetupStep = 'folder' | 'git' | 'done'

export interface PickableDepartment {
  id: string
  name: string
  folder: string
}

/**
 * What the first setup's 「この PC に置く部署」 has chosen: every department (an explicit choice), some, or
 * nothing yet. Nothing chosen is never read as 「すべて」 (UX review 2026-11-28): the setup waits for a choice.
 */
export type DepartmentPick = { all: true } | { all: false; folders: ReadonlySet<string> }

export const NOTHING_PICKED: DepartmentPick = { all: false, folders: new Set() }

/**
 * A press on 「すべての部署」 or on one department (tagged: a department may be named anything, `all` included):
 * choosing one leaves 「すべて」, and the other way round.
 */
export function togglePick(pick: DepartmentPick, press: { all: true } | { folder: string }): DepartmentPick {
  if ('all' in press) return pick.all ? NOTHING_PICKED : { all: true }
  const folders = new Set(pick.all ? [] : pick.folders)
  if (folders.has(press.folder)) folders.delete(press.folder)
  else folders.add(press.folder)
  return { all: false, folders }
}

/** What the download button does: every department, these folders in the list's order, or nothing yet (disabled). */
export function pickedDownload(departments: readonly PickableDepartment[], pick: DepartmentPick): 'all' | string[] | null {
  if (pick.all) return 'all'
  const folders = departments.map(d => d.folder).filter(f => pick.folders.has(f))
  return folders.length > 0 ? folders : null
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
 * The company shown for joining without choosing it from the list (2-2 「会社が1つなら選ばせない」):
 * the only one, unless a company is remembered for this member (App.tsx restores that one;
 * starting another setup beside it would race it). It is not opened by itself: the member
 * still presses ［始める］ once on the join screen (UX review 20, owner decision 5).
 */
export function companyToJoinWithoutChoosing<T>(companies: readonly T[], remembered: boolean): T | null {
  return !remembered && companies.length === 1 ? companies[0] : null
}

/**
 * What the place on the join screen is (folderSetup.ts `checkCompanyPlace`, before anything in it
 * changes): a folder for a first download (with the company's departments and the member's 所属),
 * this company's existing folder (opens as it is), the owner's first upload, the working folder of
 * a company without the shared folder (main checks it when ［始める］ is pressed), or refused.
 */
export type PlaceCheck =
  | { kind: 'firstSetup'; departments: PickableDepartment[]; mine: string[] }
  | { kind: 'reopen' }
  | { kind: 'upload' }
  | { kind: 'working' }
  | { kind: 'error'; message: string }

/** The departments chosen for this PC on the join screen: every one, these folders, or not yet. */
export type DepartmentChoice = 'all' | string[] | null

/** The choice the join screen starts with: the member's 所属, else nothing (the picker asks first). */
export function firstDepartmentChoice(check: PlaceCheck): DepartmentChoice {
  return check.kind === 'firstSetup' && check.mine.length > 0 ? check.mine : null
}

/** Whether the picker comes before ［始める］ can be pressed: a first download with departments, none chosen. */
export function needsDepartmentChoice(check: PlaceCheck, choice: DepartmentChoice): boolean {
  return check.kind === 'firstSetup' && check.departments.length > 0 && choice === null
}

/**
 * What ［始める］ does, or null while it cannot be pressed (the place refused or not checked, or
 * no departments chosen yet). A first download takes only the chosen folders (none = a company
 * without departments, or 「すべて」: the whole company); an existing folder keeps its own choices.
 */
export type JoinStart = { kind: SetupKind; folders: string[] } | { kind: 'working' }

export function joinStart(check: PlaceCheck | null, choice: DepartmentChoice): JoinStart | null {
  if (!check || check.kind === 'error') return null
  if (check.kind === 'working') return { kind: 'working' }
  if (check.kind !== 'firstSetup') return { kind: check.kind, folders: [] }
  if (needsDepartmentChoice(check, choice)) return null
  return { kind: 'firstSetup', folders: choice === 'all' || choice === null ? [] : choice }
}

/** The department names a choice stands for, in the list's order (for the join screen's row). */
export function chosenDepartmentNames(departments: readonly PickableDepartment[], choice: DepartmentChoice): string[] {
  if (choice === 'all') return departments.map(d => d.name)
  const chosen = new Set(choice ?? [])
  return departments.filter(d => chosen.has(d.folder)).map(d => d.name)
}
