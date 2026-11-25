/**
 * Cookies on disk are encrypted (agent-browser.md "Keeping a login on disk": the backstage guard for what runs outside
 * the company sandbox, e.g. the member's own MCP servers). What is protected:
 * - the shipped build flips Electron's `EnableCookieEncryption` fuse (and no other fuse), so a kept login's cookie file
 *   holds no cookie value in plain text;
 * - the upgrade: a store an earlier, unencrypted build wrote is still read by the encrypting build (encrypted on its
 *   next write), so nobody loses a cookie the day this build arrives.
 * The real check copies this checkout's Electron, flips the fuse with the same `@electron/fuses` electron-builder uses,
 * and runs a small harness against one `persist:` partition (macOS; Chromium's mock keychain, so no Keychain item).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

test('the shipped build encrypts cookies on disk, and flips no other fuse', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8')) as { build: { electronFuses?: unknown } }
  assert.deepEqual(pkg.build.electronFuses, { enableCookieEncryption: true })
})

const canRun = process.platform === 'darwin'

function run(electron: string, dir: string, set: string | null): Promise<{ read: string | null }> {
  fs.rmSync(path.join(dir, 'result.json'), { force: true })
  return new Promise<{ read: string | null }>((resolve, reject) => {
    // Started outside the client folder (a copied Electron started there loads the client's own package instead), with
    // tsx's loader by its full path.
    const tsx = pathToFileURL(require.resolve('tsx')).href
    const child = spawn(electron, [path.join(clientDir, 'tests/cookie-encryption-harness/main.ts')], {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: `--import ${tsx}`, COOKIE_TEST_DIR: dir, COOKIE_TEST_SET: set ?? '' },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the harness did not finish')) }, 60_000)
    child.on('close', () => {
      clearTimeout(timer)
      const file = path.join(dir, 'result.json')
      if (!fs.existsSync(file)) { reject(new Error('no result')); return }
      const result = JSON.parse(fs.readFileSync(file, 'utf8')) as { read: string | null; error?: string }
      if (result.error) reject(new Error(result.error)); else resolve(result)
    })
  })
}

function cookieRow(dir: string): { file: string; value: string; encrypted: string } {
  const find = (p: string): string | null => {
    for (const name of fs.readdirSync(p)) {
      const full = path.join(p, name)
      if (fs.lstatSync(full).isDirectory()) { const hit = find(full); if (hit) return hit } else if (name === 'Cookies') return full
    }
    return null
  }
  const file = find(path.join(dir, 'userData', 'Partitions', 'acb-browser-keep-test'))
  assert.ok(file, 'the partition\'s cookie store is on disk')
  const out = execFileSync('sqlite3', ['-readonly', '-separator', '|', file, "select value, hex(encrypted_value) from cookies where name = 'sid'"], { encoding: 'utf8' }).trim()
  const [value, encrypted] = out.split('|')
  return { file, value: value ?? '', encrypted: encrypted ?? '' }
}

test('with the fuse a cookie is stored encrypted; a store an unencrypted build wrote is still read', { skip: canRun ? false : 'macOS only' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-cookie-enc-'))
  try {
    const plain = require('electron') as string
    // A copy of this checkout's Electron with the fuse flipped as electron-builder flips it (APFS clone: cheap).
    const app = path.join(work, 'Electron.app')
    execFileSync('cp', ['-cR', plain.replace(/\/Contents\/MacOS\/Electron$/, ''), app])
    const electronBuilder = createRequire(require.resolve('electron-builder'))
    const fuses = createRequire(electronBuilder.resolve('app-builder-lib'))('@electron/fuses') as typeof import('@electron/fuses')
    const flipped = path.join(app, 'Contents', 'MacOS', 'Electron')
    await fuses.flipFuses(flipped, { version: fuses.FuseVersion.V1, resetAdHocDarwinSignature: true, [fuses.FuseV1Options.EnableCookieEncryption]: true })

    const dir = path.join(work, 'run')
    fs.mkdirSync(dir)
    // An earlier build without the fuse: plain text on disk.
    await run(plain, dir, 'plain-before')
    assert.equal(cookieRow(dir).value, 'plain-before', 'without the fuse the value is plain text (what an older build left)')
    // The encrypting build reads it, then writes encrypted.
    assert.equal((await run(flipped, dir, 'kept-secret')).read, 'plain-before', 'the upgrade keeps the cookie')
    const row = cookieRow(dir)
    assert.equal(row.value, '', 'no plain value')
    assert.match(row.encrypted, /^763130/, 'encrypted (v10)')
    assert.ok(!fs.readFileSync(row.file).includes('kept-secret'), 'the value is nowhere in the file')
    assert.equal((await run(flipped, dir, null)).read, 'kept-secret', 'and read back after a restart')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
