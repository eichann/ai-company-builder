import type { Context } from 'hono'
import type { Refusal, RefusalKind } from '../services/outcome'

const STATUS = {
  'bad-request': 400,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  gone: 410,
  /** Busy right now (a push still running); try again in a moment. */
  unavailable: 503,
} as const satisfies Record<RefusalKind, number>

/** A service's refusal as the HTTP answer: its body, with the kind's status code. */
export function refusal(c: Context, r: Refusal) {
  return c.json(r.body, STATUS[r.kind])
}
