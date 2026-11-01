/**
 * What a service answers: a value, or a refusal the route turns into an HTTP
 * answer (routes/respond.ts maps the kind to the status code). The body is
 * the API's JSON error body, exactly as clients receive it.
 */
export type RefusalKind = 'unauthorized' | 'bad-request' | 'forbidden' | 'not-found' | 'conflict' | 'gone' | 'unavailable' | 'too-large' | 'rate-limited'

export interface Refusal {
  ok: false
  kind: RefusalKind
  body: { error: string } & Record<string, unknown>
}

export type Outcome<T> = { ok: true; value: T } | Refusal

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

export function refuse(kind: RefusalKind, error: string, extra: Record<string, unknown> = {}): Refusal {
  return { ok: false, kind, body: { error, ...extra } }
}
