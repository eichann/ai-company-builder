import { createHash, randomBytes, randomUUID } from 'crypto'
import { performance } from 'perf_hooks'
import type { Clock, IdGenerator, MonotonicClock, MonotonicWait } from '../ports/clock'
import type { CompanyLock } from '../ports/transactions'
import type { TokenDigest } from '../ports/key-broker'
import { withCompanyLock } from '../lib/company-lock'

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}

/** `performance.now()` counts from this process's start and is monotonic; the id is this start's. */
export const systemMonotonicClock: MonotonicClock = {
  bootId: randomUUID(),
  monoMs: () => performance.now(),
}

/** Waits on `performance.now()` with a timer. */
export const systemMonotonicWait: MonotonicWait = {
  monoMs: () => performance.now(),
  async sleepUntil(atMs) {
    const left = atMs - performance.now()
    if (left > 0) await new Promise<void>(resolve => setTimeout(resolve, left))
  },
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

/** sha256 (hex) of bytes: an outbound mail attachment's fingerprint (outbound-mail.md "Attachments"). */
export const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
