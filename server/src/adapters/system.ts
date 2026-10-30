import { createHash, randomBytes, randomUUID } from 'crypto'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyLock } from '../ports/transactions'
import type { TokenDigest } from '../ports/key-broker'
import { withCompanyLock } from '../lib/company-lock'

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}

export const randomIds: IdGenerator = {
  newId: () => randomUUID(),
  newToken: () => randomBytes(32).toString('hex'),
}

/** The process-wide lock the RepoStore's own commits also take. */
export const processCompanyLock: CompanyLock = {
  run: (companyId, fn) => withCompanyLock(companyId, fn),
}

/** sha256 (hex) of a broker token: tokens are 256 random bits, so a plain hash is enough. */
export const sha256TokenDigest: TokenDigest = {
  digest: (token) => createHash('sha256').update(token, 'utf8').digest('hex'),
}
