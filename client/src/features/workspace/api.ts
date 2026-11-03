// The workspace's access to the main process (department tabs, the
// download prompt), as one small port over the IPC contract
// (src/shared/ipc/electron-api.ts). The function takes its port as the last
// parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** Whether a department's folder is on this computer (the download prompt when it is not). */
export type DepartmentFolderReads = ElectronPort<'exists'>

export function departmentFolderExists(folderPath: string, reads: DepartmentFolderReads = window.electronAPI) {
  return reads.exists(folderPath)
}

/** 今日のフォルダ's default: the departments the member belongs to (所属); asks the company server, sends only who the member is. */
export type TodayMembershipReads = ElectronPort<'getMyDepartments'>

export function getMyDepartmentIds(companyId: string, reads: TodayMembershipReads = window.electronAPI) {
  return reads.getMyDepartments(companyId)
}

/** 今日のフォルダ on this computer: whether it is there, and making it (main refuses a folder that is not downloaded). */
export type TodayFolderWrites = ElectronPort<'exists' | 'createDirectory'>

export function todayFolderFs(writes: TodayFolderWrites = window.electronAPI) {
  return { exists: (p: string) => writes.exists(p), createDirectory: (p: string) => writes.createDirectory(p) }
}
