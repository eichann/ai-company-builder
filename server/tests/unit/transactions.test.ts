// `Transactions.run` takes a synchronous body only (ports/transactions.ts, server.md "Layers"): whatever an async body
// does after its first `await` would run after COMMIT, outside the transaction — the shape of SERVERCORE-1. Guarded
// twice: the port's type refuses a body returning a Promise (an async function included), and the adapter throws on a
// thenable that got past it through `any`, rolling the transaction back.
import path from 'path'
import Database from 'better-sqlite3'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'

describe('Transactions.run refuses an asynchronous body', () => {
  it('as a type error: an async function or a Promise-returning one does not compile; a synchronous one keeps its type', () => {
    const port = path.resolve(__dirname, '../../src/ports/transactions.ts')
    const snippet = path.join(path.dirname(port), '__transactions_type_probe__.ts')
    const lines = [
      `import type { Transactions } from './transactions'`,
      `declare const tx: Transactions`,
      `export const a = tx.run(async () => 1)`,
      `export const b = tx.run(() => Promise.resolve(1))`,
      `export const c = tx.run(() => (Math.random() > 0.5 ? 1 : Promise.resolve(1)))`,
      `export const d: number = tx.run(() => 1)`,
      `export const e: string | undefined = tx.run(() => (Math.random() > 0.5 ? 'x' : undefined))`,
      `tx.run(() => { })`,
    ]
    const host = ts.createCompilerHost({ strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, skipLibCheck: true })
    const read = host.readFile.bind(host)
    host.readFile = f => (path.resolve(f) === snippet ? lines.join('\n') : read(f))
    const exists = host.fileExists.bind(host)
    host.fileExists = f => path.resolve(f) === snippet || exists(f)
    const program = ts.createProgram([snippet], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [] }, host)
    const source = program.getSourceFile(snippet)!
    const errorLines = ts.getPreEmitDiagnostics(program, source)
      .map(d => source.getLineAndCharacterOfPosition(d.start ?? 0).line + 1)
    // Lines 3–5 (the async body, the Promise, a body that may return one) and nothing else.
    expect([...new Set(errorLines)].sort()).toEqual([3, 4, 5])
  })

  it('at run time: a thenable slipped through `any` throws inside the transaction and its writes are rolled back', () => {
    const conn = new Database(':memory:')
    conn.exec('CREATE TABLE t (v INTEGER)')
    const tx = sqliteTransactions(conn)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asyncBody: any = async () => { conn.prepare('INSERT INTO t VALUES (1)').run() }
    expect(() => tx.run(asyncBody)).toThrow(TypeError)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 })
    // A synchronous body commits and answers its value.
    expect(tx.run(() => { conn.prepare('INSERT INTO t VALUES (2)').run(); return 'done' })).toBe('done')
    expect(conn.prepare('SELECT v FROM t').all()).toEqual([{ v: 2 }])
    conn.close()
  })
})
