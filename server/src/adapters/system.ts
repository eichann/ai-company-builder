import { randomBytes, randomUUID } from 'crypto'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyLock } from '../ports/transactions'
import { withCompanyLock } from '../lib/company-lock'

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}

export const randomIds: IdGenerator = {
  newId: () => randomUUID(),
  newToken: () => randomBytes(32).toString('hex'),
}

/** The process-wide lock the RepoStore's working-clone work also takes. */
export const processCompanyLock: CompanyLock = {
  run: (companyId, fn) => withCompanyLock(companyId, fn),
}
