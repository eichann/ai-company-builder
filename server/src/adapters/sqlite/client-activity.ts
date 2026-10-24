import type { ClientActivityRepository } from '../../ports/client-activity'
import { getClientActivityForCompany } from '../../lib/client-activity'

/** lib/client-activity.ts (also written by the middleware and git-http), behind the port. */
export function sqliteClientActivityRepository(): ClientActivityRepository {
  return {
    forCompany: companyId => getClientActivityForCompany(companyId),
  }
}
