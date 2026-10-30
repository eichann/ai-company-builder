// Open file tabs are one strip for the whole company: switching department
// tabs keeps every open file. A tab whose file lives outside the selected
// department carries a short department label so the member can tell
// 「台本.md」 of コンテンツG from one in another department.
import { normalizePathSeparators } from '../../shared/lib/path'

export interface TabDepartment { id: string; name: string; folder: string }

/** Label for files at the company root (outside every department folder). */
export const COMPANY_ROOT_LABEL = '全社'

function isInside(filePath: string, folderPath: string): boolean {
  return filePath === folderPath || filePath.startsWith(`${folderPath}/`)
}

/** The department whose folder contains `filePath` (deepest folder wins), or null for the company root. */
export function departmentOfFile(filePath: string, rootPath: string, departments: TabDepartment[]): TabDepartment | null {
  const file = normalizePathSeparators(filePath)
  const root = normalizePathSeparators(rootPath).replace(/\/+$/, '')
  let best: TabDepartment | null = null
  for (const dept of departments) {
    const folder = normalizePathSeparators(dept.folder).replace(/^\/+|\/+$/g, '')
    if (!folder) continue
    if (isInside(file, `${root}/${folder}`) && (!best || folder.length > normalizePathSeparators(best.folder).replace(/^\/+|\/+$/g, '').length)) best = dept
  }
  return best
}

/**
 * Department labels for tabs whose file is outside the selected department.
 * `selectedDeptId` null = the company-wide tab, whose file tree shows every
 * department, so no tab is labelled there. Files outside the company folder
 * (should not happen) are left unlabelled.
 */
export function tabDepartmentLabels(openFiles: string[], context: { rootPath: string; departments: TabDepartment[]; selectedDeptId: string | null }): Record<string, string> {
  const labels: Record<string, string> = {}
  if (!context.selectedDeptId || !context.rootPath) return labels
  const root = normalizePathSeparators(context.rootPath).replace(/\/+$/, '')
  for (const filePath of openFiles) {
    if (!isInside(normalizePathSeparators(filePath), root)) continue
    const dept = departmentOfFile(filePath, context.rootPath, context.departments)
    if (dept?.id === context.selectedDeptId) continue
    labels[filePath] = dept ? dept.name : COMPANY_ROOT_LABEL
  }
  return labels
}
