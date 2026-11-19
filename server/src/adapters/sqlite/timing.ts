/**
 * Time spent inside better-sqlite3, reported to the OperationMetrics port as
 * `db` (server.md "Request log"): every connection of the process — app.sqlite,
 * Better Auth's auth.sqlite and the accounts adapter's own — through the
 * library's prototypes, so no repository or service learns about it.
 *
 * Measured: prepare (statements are prepared per call), a statement's
 * run / get / all / iterate (iterate: creating the iterator only), exec, pragma,
 * and a whole transaction function (BEGIN … COMMIT, with the JS run inside it:
 * synchronous, holding the database). The port counts nested operations once
 * (a statement inside a transaction), so nothing is added twice.
 *
 * Installed once by the composition root; a second call only changes where the
 * time is reported.
 */
import Database from 'better-sqlite3'
import type { OperationMetrics } from '../../ports/operation-metrics'

let metrics: OperationMetrics | null = null

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

function timed(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const end = metrics ? metrics.start('db') : null
    try {
      return original.apply(this, args)
    } finally {
      end?.()
    }
  }
}

function wrapMethods(proto: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    const original = proto[name]
    if (typeof original === 'function') proto[name] = timed(original as AnyFn)
  }
}

const TRANSACTION_VARIANTS = ['default', 'deferred', 'immediate', 'exclusive'] as const

export function timeSqliteCalls(to: OperationMetrics): void {
  const first = metrics === null
  metrics = to
  if (!first) return
  const dbProto = Database.prototype as unknown as Record<string, unknown>
  // The Statement class is not exported: take its prototype from a statement.
  const probe = new Database(':memory:')
  const stmtProto = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Record<string, unknown>
  probe.close()
  wrapMethods(stmtProto, ['run', 'get', 'all', 'iterate'])
  wrapMethods(dbProto, ['prepare', 'exec', 'pragma'])
  const transaction = dbProto.transaction as (this: Database.Database, fn: AnyFn) => AnyFn & Record<string, AnyFn>
  dbProto.transaction = function (this: Database.Database, fn: AnyFn) {
    const tx = transaction.call(this, fn)
    const outer = timed(tx) as AnyFn & Record<string, unknown>
    for (const variant of TRANSACTION_VARIANTS) {
      if (typeof tx[variant] === 'function') Object.defineProperty(outer, variant, { value: timed(tx[variant]) })
    }
    Object.defineProperty(outer, 'database', { value: this })
    return outer
  }
}
