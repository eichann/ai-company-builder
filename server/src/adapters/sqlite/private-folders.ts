import type Database from 'better-sqlite3'
import type { PrivateFolderRepository } from '../../ports/private-folders'
import { getPrivateFolder, listPrivateFolders } from '../../lib/private-folders'

export function sqlitePrivateFolderRepository(conn: Database.Database): PrivateFolderRepository {
  return {
    list: companyId => listPrivateFolders(conn, companyId),
    get: (companyId, scopeId) => getPrivateFolder(conn, companyId, scopeId),
    paths: companyId => listPrivateFolders(conn, companyId).map(p => p.scope.path),
  }
}
