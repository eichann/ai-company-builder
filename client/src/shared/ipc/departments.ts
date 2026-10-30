// The company's departments (tabs, the settings' folder list), as one small
// port over the IPC contract (src/shared/ipc/electron-api.ts). The function
// takes its port as the last parameter, defaulting to window.electronAPI.
import type { ElectronPort } from './electron-api'

/** Reading the department list from the company server (sends only who the member is). */
export type DepartmentReads = ElectronPort<'getDepartments'>

export function getDepartments(companyId: string, reads: DepartmentReads = window.electronAPI) {
  return reads.getDepartments(companyId)
}
