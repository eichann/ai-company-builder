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

// --- Record tabs (plan A: files and records open side by side in the same tabs) ------------
// A record's tab sits in the same list as file tabs under a key no path can have (paths are
// absolute), so the order, the active tab and ← → hold both; only the file keys load text.
const RECORD_TAB_PREFIX = 'acb-record:'

export const recordTabKey = (recordId: string): string => `${RECORD_TAB_PREFIX}${recordId}`
export const recordIdOfTab = (key: string | null | undefined): string | null =>
  key && key.startsWith(RECORD_TAB_PREFIX) ? key.slice(RECORD_TAB_PREFIX.length) || null : null
export const fileTabsOf = (keys: readonly string[]): string[] => keys.filter(k => recordIdOfTab(k) === null)

/** What a record tab shows without reading the record again: its icon and title (saved with the tabs). */
export interface RecordTabLook {
  title: string
  type: string
  typeLabel?: string | null
  implements?: string[]
  state?: string | null
}

/** Looks only for the record tabs still open: closing a tab forgets its title. */
export function looksOfOpenTabs(keys: readonly string[], looks: Readonly<Record<string, RecordTabLook>>): Record<string, RecordTabLook> {
  const out: Record<string, RecordTabLook> = {}
  for (const k of keys) {
    const id = recordIdOfTab(k)
    if (id && looks[id]) out[id] = looks[id]
  }
  return out
}

/** Saved looks, each kept only when it has the shape (a hand-edited or older entry is dropped). */
export function parseRecordLooks(raw: unknown): Record<string, RecordTabLook> {
  const out: Record<string, RecordTabLook> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const l = v as Partial<RecordTabLook> | null
    if (!l || typeof l.title !== 'string' || typeof l.type !== 'string') continue
    out[id] = {
      title: l.title.slice(0, 200), type: l.type,
      ...(typeof l.typeLabel === 'string' ? { typeLabel: l.typeLabel } : {}),
      ...(Array.isArray(l.implements) ? { implements: l.implements.filter((x): x is string => typeof x === 'string') } : {}),
      ...(typeof l.state === 'string' ? { state: l.state } : {}),
    }
  }
  return out
}
