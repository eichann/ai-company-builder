/**
 * Where the key broker's key-encryption key comes from (adapters/kek-file.ts,
 * src/cli/generate-broker-kek.ts): a KEK the server would expose (readable by
 * others, inside DATA_DIR where backups copy it) is refused, a missing one
 * just leaves the broker off, the generator never overwrites a KEK and never
 * prints it, and neither the operator's log line nor the refusal contains it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { randomBytes } from 'crypto'
import { loadKekFile } from '../../src/adapters/kek-file'

const run = promisify(execFile)
const dir = mkdtempSync(join(tmpdir(), 'acb-kek-'))
const dataDir = join(dir, 'data')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function kekFile(name: string, content: string, mode = 0o600): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}

describe('loading the KEK', () => {
  const value = randomBytes(32).toString('base64')

  it('loads an owner-only file of 32 base64 bytes', () => {
    const r = loadKekFile(kekFile('ok', `${value}\n`), dataDir)
    expect(r.ok && r.kek.toString('base64')).toBe(value)
  })

  it('no KEK configured (unset, empty file, /dev/null mount) → broker off, server fine', () => {
    expect(loadKekFile(null, dataDir)).toMatchObject({ ok: false, reason: 'not-configured' })
    expect(loadKekFile(kekFile('empty', ''), dataDir)).toMatchObject({ ok: false, reason: 'not-configured' })
    expect(loadKekFile('/dev/null', dataDir)).toMatchObject({ ok: false, reason: 'not-configured' })
    expect(loadKekFile(join(dir, 'missing'), dataDir)).toMatchObject({ ok: false, reason: 'kek-unreadable' })
  })

  it('refuses a KEK readable by group or others, or inside DATA_DIR, without quoting it', () => {
    const loose = loadKekFile(kekFile('loose', value, 0o644), dataDir)
    expect(loose).toMatchObject({ ok: false, reason: 'kek-insecure' })
    expect(JSON.stringify(loose)).not.toContain(value)
    const inData = loadKekFile(join(dir, 'ok'), dir)
    expect(inData).toMatchObject({ ok: false, reason: 'kek-insecure' })
  })

  it('refuses anything but 32 bytes of base64, without quoting it', () => {
    for (const bad of [randomBytes(16).toString('base64'), randomBytes(48).toString('base64'), 'x'.repeat(44), `${value} extra`]) {
      const r = loadKekFile(kekFile('bad', bad), dataDir)
      expect(r).toMatchObject({ ok: false, reason: 'kek-invalid' })
      expect(JSON.stringify(r)).not.toContain(bad.slice(0, 20))
    }
  })
})

describe('generating a KEK (operator command)', () => {
  const cli = resolve(__dirname, '../../src/cli/generate-broker-kek.ts')
  const gen = (target: string, env: Record<string, string> = {}) =>
    run(process.execPath, ['--import', 'tsx', cli, target], { cwd: resolve(__dirname, '../..'), env: { ...process.env, ...env } })
      .then(r => ({ code: 0, out: r.stdout + r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }))

  it('writes a new owner-only key the server loads, and prints only the path and its id', async () => {
    const target = join(dir, 'generated')
    const r = await gen(target, { DATA_DIR: dataDir })
    expect(r.code).toBe(0)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    const content = readFileSync(target, 'utf8').trim()
    expect(r.out).not.toContain(content)
    expect(r.out).not.toContain(content.slice(0, 12))
    const loaded = loadKekFile(target, dataDir)
    expect(loaded.ok).toBe(true)
  }, 30_000)

  it('never overwrites an existing KEK and refuses a path inside DATA_DIR', async () => {
    const target = join(dir, 'generated')
    const before = readFileSync(target, 'utf8')
    expect((await gen(target)).code).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect((await gen(join(dataDir, 'kek'), { DATA_DIR: dataDir })).code).toBe(1)
  }, 30_000)
})
