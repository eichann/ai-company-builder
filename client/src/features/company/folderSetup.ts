// The asynchronous steps of setting a company folder up, over the feature's ports (api.ts).
import type { DepartmentFolder } from '../../types'
import { getDepartments } from '../../shared/ipc/departments'
import { companyPathExists, inspectCompanyFolder, readCompanyFolder } from './api'
import { planFolderSetup } from './folderPlan'
import { departmentIdFor, isDepartmentEntry, pickableDepartments, type PickableDepartment, type SetupKind } from './model'

export type FolderNextStep =
  | { kind: 'pick'; departments: PickableDepartment[] }
  | { kind: 'error'; message: string }
  | { kind: SetupKind }

/**
 * Asks main what the folder is (folderPlan.ts). A folder with nothing
 * downloaded yet asks which departments to download first (when the company
 * has any); an existing clone opens as before; a folder that cannot be used is
 * refused before anything in it changes.
 */
export async function prepareCompanyFolder(companyPath: string, companyId: string): Promise<FolderNextStep> {
  const inspected = await inspectCompanyFolder(companyPath, companyId).catch(() => null)
  const plan = planFolderSetup(inspected)
  if (plan.kind === 'firstSetup') {
    const result = await getDepartments(companyId).catch(() => null)
    const departments = pickableDepartments(result?.success && result.data ? result.data : [])
    if (departments.length > 0) return { kind: 'pick', departments }
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
