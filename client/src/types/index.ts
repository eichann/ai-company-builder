// Screen types several renderer features share. Contract types (server API, IPC) are imported
// from shared/types and client/shared/ipc-contract.ts, and a name here never repeats one of them.
import type { Company } from '../../../shared/types'

/** A department as the screen shows it: a root folder of the company repository. */
export interface DepartmentConfig {
  id: string
  name: string
  folder: string
  icon: string
  color: string
  description: string
}

/** A root folder found in the company folder when it was set up on this computer. */
export interface DepartmentFolder {
  /** Not the server's department id: the old template id for its folder name, else the name in lower case. */
  id: string
  name: string
  path: string
  hasAgent: boolean
}

/** The company open in the app: the server's company plus where its folder is on this computer. */
export interface CompanyView extends Pick<Company, 'id' | 'name' | 'createdAt'> {
  rootPath: string
  departments: DepartmentFolder[]
}
