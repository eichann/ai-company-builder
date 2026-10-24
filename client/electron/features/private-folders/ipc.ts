// Private folders (stage 3c): the 「新しいフォルダ…」 dialog and the lock
// icons. Only the person's dialog creates them — never the chat (no tool).
//   privateFolders:mine, privateFolders:createContext, privateFolders:create,
//   privateFolders:reservedPathRefusal

import type { CreatePrivateFolderRequest } from '../../../shared/private-folder-ui'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PrivateFoldersApi } from '../../private-folders-api'
import type { PathGuard } from '../ports'
import type { PrivateFolderGuards } from './guards'

export interface PrivateFoldersDeps {
  paths: PathGuard
  api: PrivateFoldersApi
  guards: Pick<PrivateFolderGuards, 'reservedRefusal'>
}

export function registerPrivateFoldersIpc(ipc: IpcRegistrar, { paths, api, guards }: PrivateFoldersDeps): void {
  // The file tree asks before creating / renaming / moving to a path: a
  // folder named like a private folder the member cannot read is refused with
  // the server's [RESERVED_PATH] sentence (only the name the member typed).
  // The fs:* handlers refuse the same paths as a backstop (features/fs).
  ipc.handle('privateFolders:reservedPathRefusal', async (_, targetPath: string) => {
    try {
      return await guards.reservedRefusal(paths.validate(targetPath))
    } catch {
      return null
    }
  })

  ipc.handle('privateFolders:mine', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return { success: false, offline: false, error: 'companyId is required' }
    return api.mine(companyId)
  })
  ipc.handle('privateFolders:createContext', async (_, companyId: string, parentPath: string) => {
    if (typeof companyId !== 'string' || !companyId || typeof parentPath !== 'string') return { success: false, offline: false, error: 'Invalid arguments' }
    return api.createContext(companyId, parentPath)
  })
  ipc.handle('privateFolders:create', async (_, companyId: string, input: CreatePrivateFolderRequest) => {
    if (typeof companyId !== 'string' || !companyId || !input || typeof input.name !== 'string' || typeof input.parentPath !== 'string') {
      return { success: false, offline: false, error: 'Invalid arguments' }
    }
    return api.create(companyId, {
      parentPath: input.parentPath,
      name: input.name,
      ...(Array.isArray(input.viewers) ? { viewers: input.viewers.filter(v => typeof v === 'string') } : {}),
      ...(Array.isArray(input.editors) ? { editors: input.editors.filter(v => typeof v === 'string') } : {}),
      ...(input.force === true ? { force: true } : {}),
    })
  })
}
