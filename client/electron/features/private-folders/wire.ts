// Private folders (stage 3c): the server client, the guards the chat and the
// file operations ask, and the 「新しいフォルダ…」 dialog's IPC.
import { createPrivateFoldersApi } from '../../private-folders-api'
import type { Session } from '../../services/session'
import type { SyncActivity } from '../../services/sync-activity'
import type { PathChecker } from '../../sync/path-check'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'
import { createPrivateFolderGuards } from './guards'
import { registerPrivateFoldersIpc } from './ipc'

export interface PrivateFoldersWiring {
  serverUrl: () => string
  session: Pick<Session, 'cookies'>
  paths: PathGuard
  /** Sync's shared, cached paths/check client. */
  pathChecker: PathChecker
  activity: Pick<SyncActivity, 'during'>
}

export function wirePrivateFolders(ipc: IpcRegistrar, { serverUrl, session, paths, pathChecker, activity }: PrivateFoldersWiring) {
  const api = createPrivateFoldersApi({ baseUrl: serverUrl, cookies: session.cookies })
  const guards = createPrivateFolderGuards({ api, pathChecker })
  registerPrivateFoldersIpc(ipc, { paths, api, guards, activity })
  return guards
}
