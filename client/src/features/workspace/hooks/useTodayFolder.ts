import { useCallback, useSyncExternalStore } from 'react'
import type { DepartmentConfig } from '../../../types'
import { ensureTodayFolder, todayFolderDepartment, todayFolderPath, type TodayFolderChoice } from '../../../../shared/today-folder'
import { todayFolderSetting } from '../../../shared/lib/todayFolderSetting'
import { getMyDepartmentIds, todayFolderFs } from '../api'

export interface TodayFolder extends TodayFolderChoice<DepartmentConfig> {
  /** The departments it may be in (downloaded here), for 自分の設定's choice. */
  choices: DepartmentConfig[]
  chosenId: string | null
  /** What おまかせ uses (the first 所属 department downloaded here). */
  defaultDepartment: DepartmentConfig | null
  /** The departments the member belongs to (所属); null = not known (offline, an older server). */
  myDepartmentIds: readonly string[] | null
  choose: (departmentId: string | null) => void
  /** Today's folder (company path) at this moment; null = no department downloaded. */
  folderNow: () => string | null
  /** Makes today's folder when missing: its company path, or the reason in words. */
  ensure: () => Promise<{ folder: string; department: DepartmentConfig } | { error: string }>
}

// 所属, read once per company while the app runs (null = not known: offline, an older server).
const membership = new Map<string, readonly string[] | null>()
const asked = new Set<string>()
const membershipListeners = new Set<() => void>()
function subscribeMembership(companyId: string | undefined, listener: () => void) {
  membershipListeners.add(listener)
  if (companyId && !asked.has(companyId)) {
    asked.add(companyId)
    const settle = (ids: readonly string[] | null) => { membership.set(companyId, ids); membershipListeners.forEach(fn => fn()) }
    void Promise.resolve().then(() => getMyDepartmentIds(companyId))
      .then(r => settle(r?.success && Array.isArray(r.departmentIds) ? r.departmentIds : null), () => settle(null))
  }
  return () => { membershipListeners.delete(listener) }
}

/** The member's 今日のフォルダ in this company (client/shared/today-folder.ts): which department, and making it. */
export function useTodayFolder(
  companyId: string | undefined,
  rootPath: string | undefined,
  departments: DepartmentConfig[],
  isDownloaded: (folder: string) => boolean,
): TodayFolder {
  const chosenId = useSyncExternalStore(todayFolderSetting.subscribe, () => (companyId ? todayFolderSetting.get(companyId) : null))
  const subscribe = useCallback((listener: () => void) => subscribeMembership(companyId, listener), [companyId])
  const myDepartmentIds = useSyncExternalStore(subscribe, () => (companyId ? membership.get(companyId) ?? null : null))
  const choice = todayFolderDepartment({ departments, chosenId, myDepartmentIds, isDownloaded })
  const department = choice.department
  const choose = useCallback((id: string | null) => { if (companyId) todayFolderSetting.set(companyId, id) }, [companyId])
  const folderNow = useCallback(() => (department ? todayFolderPath(department.folder, Date.now()) : null), [department])
  const ensure = useCallback(async () => {
    if (!department || !rootPath) return { error: 'このPCにダウンロードしている部署がないため、今日のフォルダを作れません。設定でダウンロードしてください。' }
    const folder = todayFolderPath(department.folder, Date.now())
    const abs = await ensureTodayFolder(rootPath, folder, todayFolderFs())
    return abs ? { folder, department } : { error: '今日のフォルダを作れませんでした。もう一度試してください。' }
  }, [department, rootPath])
  const defaultDepartment = choice.chosen ? todayFolderDepartment({ departments, chosenId: null, myDepartmentIds, isDownloaded }).department : department
  return { ...choice, defaultDepartment, myDepartmentIds, choices: departments.filter(d => d.folder && isDownloaded(d.folder)), chosenId, choose, folderNow, ensure }
}
