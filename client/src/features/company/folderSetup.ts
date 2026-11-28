// The asynchronous steps of setting a company folder up, over the feature's ports (api.ts).
import type { CompanyView, DepartmentFolder } from '../../types'
import type { CompanyInfo } from '../../../shared/ipc-contract'
import { answeredCompanyFolderKind } from '../../../shared/company-folder'
import { getDepartments } from '../../shared/ipc/departments'
import { companyPathExists, getMyDepartments, inspectCompanyFolder, openWorkingFolder, readCompanyFolder } from './api'
import { planFolderSetup } from './folderPlan'
import { departmentIdFor, isDepartmentEntry, membershipFolders, pickableDepartments, type PlaceCheck } from './model'

/** Said when the first setup cannot read the company's departments (nothing is downloaded). */
export const DEPARTMENTS_UNREAD = '部署の一覧を読み込めませんでした。インターネット接続を確かめて、もう一度お試しください。何もダウンロードしていません。'

/**
 * What a place is for this company, asked before the join screen shows it (read-only: main
 * inspects the folder, folderPlan.ts). A folder with nothing downloaded yet comes with the
 * company's departments and the member's 所属 (the picker asks when none is known); an existing
 * clone opens as before; a folder that cannot be used is refused before anything in it changes.
 * A company without the shared folder is not inspected: main checks its working folder when
 * ［始める］ is pressed (`openCompanyWithoutFolder`).
 */
export async function checkCompanyPlace(company: Pick<CompanyInfo, 'id' | 'folderKind'>, companyPath: string): Promise<PlaceCheck> {
  if (opensWithoutSharedFolder(company)) return { kind: 'working' }
  const inspected = await inspectCompanyFolder(companyPath, company.id).catch(() => null)
  const plan = planFolderSetup(inspected)
  if (plan.kind !== 'firstSetup') return plan
  const result = await getDepartments(company.id).catch(() => null)
  // The list could not be read: say so rather than download every department unasked.
  if (!result?.success) return { kind: 'error', message: DEPARTMENTS_UNREAD }
  const departments = pickableDepartments(result.data ?? [])
  if (departments.length === 0) return { kind: 'firstSetup', departments, mine: [] }
  const mine = await Promise.resolve().then(() => getMyDepartments(company.id)).catch(() => null)
  return { kind: 'firstSetup', departments, mine: membershipFolders(departments, mine?.success ? mine.departmentIds : null) }
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

export interface WorkingFolderOpening {
  openWorkingFolder: (folder: string, companyId: string) => Promise<{ success: boolean; error?: string }>
  readDepartments: (folder: string) => Promise<DepartmentFolder[]>
}

/**
 * Whether a chosen company opens without the shared company folder: only a company the
 * server answered exactly `none` for (an older server's answer → git, set up as before).
 */
export function opensWithoutSharedFolder(company: Pick<CompanyInfo, 'folderKind'>): boolean {
  return answeredCompanyFolderKind(company.folderKind) === 'none'
}

/**
 * Opening a company without the shared folder (client/shared/company-folder.ts) in
 * `companyPath`: main prepares the plain working folder; nothing is inspected, downloaded or
 * set up as a clone, and no department picker is shown (nothing is downloaded).
 */
export async function openCompanyWithoutFolder(
  company: CompanyInfo,
  companyPath: string,
  ports: WorkingFolderOpening = { openWorkingFolder, readDepartments: readFolderDepartments },
): Promise<{ company: CompanyView } | { error: string }> {
  const opened = await ports.openWorkingFolder(companyPath, company.id).catch(() => null)
  if (!opened?.success) return { error: opened?.error || 'フォルダを準備できませんでした。もう一度お試しください。' }
  return {
    company: {
      id: company.id,
      name: company.name,
      rootPath: companyPath,
      departments: await ports.readDepartments(companyPath),
      createdAt: new Date(company.createdAt),
      folderKind: 'none',
    },
  }
}
