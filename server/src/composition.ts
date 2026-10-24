/**
 * Composition root: the one place that picks the adapters (SQLite, the local
 * repository store, the system clock) and hands them to the services. Routes
 * get their services from here; nothing else imports src/adapters.
 *
 * Built at import time from the process's database connection (src/db),
 * which tests point at a temporary DATA_DIR. Repositories prepare their
 * statements per call, so building them before initDatabase() is safe.
 */
import type Database from 'better-sqlite3'
import { db } from './db'
import { sqliteCompanyRepository } from './adapters/sqlite/companies'
import { sqliteMembershipRepository } from './adapters/sqlite/memberships'
import { sqliteInvitationRepository } from './adapters/sqlite/invitations'
import { sqliteDepartmentRepository } from './adapters/sqlite/departments'
import { sqliteScopeRepository } from './adapters/sqlite/scopes'
import { sqlitePrivateFolderRepository } from './adapters/sqlite/private-folders'
import { sqliteClientActivityRepository } from './adapters/sqlite/client-activity'
import { sqlitePushRejectionRepository } from './adapters/sqlite/push-rejections'
import { sqliteTransactions } from './adapters/sqlite/transactions'
import { gitOrphanedScopeReader } from './adapters/orphaned-scopes'
import { betterAuthAccountDirectory } from './adapters/accounts'
import { localRepoStore } from './adapters/git-repo-store'
import { randomIds, systemClock } from './adapters/system'
import { createAccessPolicy } from './services/access'
import { createCompanyService } from './services/companies'
import { createInvitationService } from './services/invitations'
import { createDepartmentService } from './services/departments'
import { createPermissionViewService } from './services/permission-views'

export function createServices(conn: Database.Database) {
  const repos = {
    companies: sqliteCompanyRepository(conn),
    memberships: sqliteMembershipRepository(conn),
    invitations: sqliteInvitationRepository(conn),
    departments: sqliteDepartmentRepository(conn),
    scopes: sqliteScopeRepository(conn),
    privateFolders: sqlitePrivateFolderRepository(conn),
    clientActivity: sqliteClientActivityRepository(),
    pushRejections: sqlitePushRejectionRepository(),
    orphanedScopes: gitOrphanedScopeReader(),
  }
  const shared = {
    accounts: betterAuthAccountDirectory(),
    transactions: sqliteTransactions(conn),
    clock: systemClock,
    ids: randomIds,
  }
  const repoStore = localRepoStore()

  return {
    access: createAccessPolicy(repos.memberships),
    companies: createCompanyService({ ...repos, ...shared, repoStore }),
    invitations: createInvitationService({ ...repos, ...shared }),
    departments: createDepartmentService({ ...repos, ...shared, repoStore }),
    permissionViews: createPermissionViewService({ ...repos, ...shared }),
    accounts: shared.accounts,
    repoStore,
  }
}

export type Services = ReturnType<typeof createServices>

export const services: Services = createServices(db)
