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
