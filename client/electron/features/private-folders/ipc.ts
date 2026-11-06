// Private folders (stage 3c): the 「新しいフォルダ…」 dialog and the lock
// icons. Only the person's dialog creates them — never the chat (no tool).
//   privateFolders:mine, privateFolders:createContext, privateFolders:create,
//   privateFolders:reservedPathRefusal, privateFolders:members / setMembers (a 非公開 案件's 参加者)

import type { CreatePrivateFolderRequest, SetPrivateFolderMembersRequest } from '../../../shared/private-folder-ui'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PrivateFoldersApi } from '../../private-folders-api'
import type { PathGuard } from '../ports'
import type { PrivateFolderGuards } from './guards'
import type { SyncActivity } from '../../services/sync-activity'

export interface PrivateFoldersDeps {
  paths: PathGuard
  api: PrivateFoldersApi
  guards: Pick<PrivateFolderGuards, 'writeRefusal'>
  /** Automatic sync waits while a folder is being created. */
  activity: Pick<SyncActivity, 'during'>
}

export function registerPrivateFoldersIpc(ipc: IpcRegistrar, { paths, api, guards, activity }: PrivateFoldersDeps): void {
  // The file tree asks before creating / renaming / moving to a path: a
  // folder named like a private folder the member cannot read is refused with
  // the server's [RESERVED_PATH] sentence (only the name the member typed), a
  // skill file the member may not change with its own sentence.
  // The fs:* handlers refuse the same paths as a backstop (features/fs).
  ipc.handle('privateFolders:reservedPathRefusal', async (_, targetPath: string) => {
    try {
      return await guards.writeRefusal(paths.validate(targetPath))
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
  // A 非公開 案件・プロジェクト's 参加者 (records.md "Private 案件・プロジェクト"): the folder's readers, read and
  // changed by a person on the 案件's card (the server allows owners/admins and the department's managers).
  ipc.handle('privateFolders:members', async (_, companyId: string, scopeId: string) => {
    if (typeof companyId !== 'string' || !companyId || typeof scopeId !== 'string') return { success: false, offline: false, error: 'Invalid arguments' }
    return api.members(companyId, scopeId)
  })
  ipc.handle('privateFolders:setMembers', async (_, companyId: string, scopeId: string, input: SetPrivateFolderMembersRequest) => {
    const ids = (v: unknown) => Array.isArray(v) && v.length <= 1000 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 200)
    if (typeof companyId !== 'string' || !companyId || typeof scopeId !== 'string' || !input || !ids(input.viewers) || !ids(input.editors)) {
      return { success: false, offline: false, error: 'Invalid arguments' }
    }
    return api.setMembers(companyId, scopeId, { viewers: input.viewers, editors: input.editors })
  })
  ipc.handle('privateFolders:create', async (_, companyId: string, input: CreatePrivateFolderRequest) => {
    if (typeof companyId !== 'string' || !companyId || !input || typeof input.name !== 'string' || typeof input.parentPath !== 'string') {
      return { success: false, offline: false, error: 'Invalid arguments' }
    }
    return activity.during('private-folder-setup', () => api.create(companyId, {
      parentPath: input.parentPath,
      name: input.name,
      ...(Array.isArray(input.viewers) ? { viewers: input.viewers.filter(v => typeof v === 'string') } : {}),
      ...(Array.isArray(input.editors) ? { editors: input.editors.filter(v => typeof v === 'string') } : {}),
      ...(input.force === true ? { force: true } : {}),
    }))
  })
}
