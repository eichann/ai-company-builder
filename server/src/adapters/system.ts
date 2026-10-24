import { randomBytes, randomUUID } from 'crypto'
import type { Clock, IdGenerator } from '../ports/clock'

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}

export const randomIds: IdGenerator = {
  newId: () => randomUUID(),
  newToken: () => randomBytes(32).toString('hex'),
}
