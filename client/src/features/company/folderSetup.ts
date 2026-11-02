// The asynchronous steps of setting a company folder up, over the feature's ports (api.ts).
import type { DepartmentFolder } from '../../types'
import { getDepartments } from '../../shared/ipc/departments'
import { companyPathExists, getMyDepartments, inspectCompanyFolder, readCompanyFolder } from './api'
import { planFolderSetup } from './folderPlan'
import { departmentIdFor, isDepartmentEntry, membershipFolders, pickableDepartments, type PickableDepartment, type SetupKind } from './model'

export type FolderNextStep =
  | { kind: 'pick'; departments: PickableDepartment[] }
  /** First setup with the member's 所属: download these without asking. */
  | { kind: 'mine'; folders: string[] }
  | { kind: 'error'; message: string }
  | { kind: SetupKind }

/**
 * Asks main what the folder is (folderPlan.ts). A folder with nothing
 * downloaded yet downloads the departments the member belongs to (所属), or
 * asks which ones when none is known (when the company has any); an existing clone opens as before; a folder that cannot be used is
 * refused before anything in it changes.
 */
export async function prepareCompanyFolder(companyPath: string, companyId: string): Promise<FolderNextStep> {
  const inspected = await inspectCompanyFolder(companyPath, companyId).catch(() => null)
  const plan = planFolderSetup(inspected)
  if (plan.kind === 'firstSetup') {
    const result = await getDepartments(companyId).catch(() => null)
    const departments = pickableDepartments(result?.success && result.data ? result.data : [])
    if (departments.length > 0) {
      const mine = await Promise.resolve().then(() => getMyDepartments(companyId)).catch(() => null)
      const folders = membershipFolders(departments, mine?.success ? mine.departmentIds : null)
      return folders.length > 0 ? { kind: 'mine', folders } : { kind: 'pick', departments }
    }
  }
  return plan
}

/** The departments in a set-up company folder (cloned from the server, or empty). */
export async function readFolderDepartments(companyPath: string): Promise<DepartmentFolder[]> {
  const departments: DepartmentFolder[] = []
  for (const entry of await readCompanyFolder(companyPath)) {
    if (!isDepartmentEntry(entry)) continue
    departments.push({
      id: departmentIdFor(entry.name),
      name: entry.name,
      path: entry.path,
      hasAgent: await companyPathExists(`${entry.path}/AGENT.md`),
    })
  }
  return departments
}
