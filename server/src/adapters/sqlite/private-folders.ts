import type Database from 'better-sqlite3'
import type { PrivateFolderRepository } from '../../ports/private-folders'
import {
  createPrivateFolder,
  deletePrivateFolder,
  folderAccess,
  getPrivateFolder,
  listPrivateFolders,
  makePrivateFolderPublic,
  MakePublicError,
  PathUnavailableError,
  PrivateFolderBusyError,
  replacePrivateFolderRules,
} from '../../lib/private-folders'

/**
 * lib/private-folders.ts behind the port (rows, scope repositories, the race
 * protections). Its refusals become results; any other error propagates.
 */
export function sqlitePrivateFolderRepository(conn: Database.Database): PrivateFolderRepository {
  return {
    list: (companyId, scopes) => listPrivateFolders(conn, companyId, scopes),
    get: (companyId, scopeId) => getPrivateFolder(conn, companyId, scopeId),
    paths: companyId => listPrivateFolders(conn, companyId).map(p => p.scope.path),
    access: (companyId, path, scopes) => folderAccess(conn, companyId, path, scopes),

    async create(input) {
      try {
        const { scopeId } = await createPrivateFolder(conn, input)
        return { ok: true, scopeId }
      } catch (err) {
        if (err instanceof PathUnavailableError) return { ok: false, reason: 'unavailable' }
        if (err instanceof PrivateFolderBusyError) {
          return { ok: false, reason: 'BUSY', message: 'Someone is still pushing to the company repository; try again in a moment' }
        }
        throw err
      }
    },

    replaceRules: (scopeId, rules, by) => replacePrivateFolderRules(conn, scopeId, rules, by),

    async makePublic(companyId, folder, by) {
      try {
        return { ok: true, value: await makePrivateFolderPublic(conn, companyId, folder, by) }
      } catch (err) {
        if (err instanceof MakePublicError) return { ok: false, reason: err.code, message: err.message }
        throw err
      }
    },

    async delete(companyId, folder, by) {
      try {
        return { ok: true, value: await deletePrivateFolder(conn, companyId, folder, by) }
      } catch (err) {
        if (err instanceof MakePublicError) return { ok: false, reason: err.code, message: err.message }
        throw err
      }
    },
  }
}
