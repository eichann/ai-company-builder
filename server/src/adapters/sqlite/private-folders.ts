import type Database from 'better-sqlite3'
import type { PrivateFolderRepository } from '../../ports/private-folders'
import { listPrivateFolders } from '../../lib/private-folders'

export function sqlitePrivateFolderRepository(conn: Database.Database): PrivateFolderRepository {
  return {
    paths: companyId => listPrivateFolders(conn, companyId).map(p => p.scope.path),
  }
}
