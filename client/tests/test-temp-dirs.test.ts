/**
 * Temporary folders of tests (`shared/testing/temp-dirs.ts`, testing.md "Temporary folders"). 2026-11-28: killed,
 * timed-out and failed tests left ~8,500 `acb-*` folders (50 GB+) in the temp folder and the Mac ran out of disk.
 * What is protected:
 * - the start-of-run sweep removes only this prefix's folders older than six hours: never a running test's (newer),
 *   another prefix's (also one that only starts the same), a file, or anything through a symbolic link;
 * - a folder goes when its process ends normally, by an uncaught exception or by SIGTERM / SIGINT, and a child
 *   registered as writing there is stopped first;
 * - the test files that left the most (kept logins, the document player) leave nothing behind.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STALE_TEMP_DIR_MS, makeTempDir, sweepStaleTempDirs } from '../../shared/testing/temp-dirs'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const helper = path.join(clientDir, '..', 'shared', 'testing', 'temp-dirs.ts')

const ageBy = (p: string, ms: number) => { const t = new Date(Date.now() - ms); fs.lutimesSync(p, t, t) }
const OLD = STALE_TEMP_DIR_MS + 60_000

test('the sweep removes only this prefix\'s folders older than six hours, never a newer one, another prefix\'s, a file or a link\'s target', () => {
  const root = fs.realpathSync(makeTempDir('acb-temp-dirs-test-'))
  const outside = fs.realpathSync(makeTempDir('acb-temp-dirs-outside-'))
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x')
  const dir = (name: string, ms: number) => { const p = path.join(root, name); fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'f'), 'x'); ageBy(p, ms); return p }
  const old = dir('acb-x-Aa1234', OLD)
  fs.symlinkSync(outside, path.join(old, 'link'))          // a link inside an old folder: removed, its target kept
  ageBy(old, OLD)
  dir('acb-x-Bb1234', 60_000)                              // a run that is still going
  dir('acb-y-Cc1234', OLD)                                 // another prefix
  dir('acb-x-longer-Dd1234', OLD)                          // a prefix that only starts the same
  dir('acb-x-Ee12', OLD)                                   // not mkdtemp's shape
  fs.writeFileSync(path.join(root, 'acb-x-Ff1234'), 'x'); ageBy(path.join(root, 'acb-x-Ff1234'), OLD)   // a file
  fs.symlinkSync(outside, path.join(root, 'acb-x-Gg1234')); ageBy(path.join(root, 'acb-x-Gg1234'), OLD) // a link of that name

  assert.deepEqual(sweepStaleTempDirs('acb-x-', { root }), ['acb-x-Aa1234'])
  assert.deepEqual(fs.readdirSync(root).sort(), ['acb-x-Bb1234', 'acb-x-Ee12', 'acb-x-Ff1234', 'acb-x-Gg1234', 'acb-x-longer-Dd1234', 'acb-y-Cc1234'])
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'x', 'nothing removed through a link')
  assert.equal(fs.lstatSync(path.join(root, 'acb-x-Gg1234')).isSymbolicLink(), true)
  assert.throws(() => sweepStaleTempDirs('tmp-', { root }), /acb-/, 'only test folders are ever swept')
  assert.throws(() => makeTempDir('x-'), /acb-/)
})

test('the first folder of a prefix in a run sweeps that prefix\'s old leftovers first', () => {
  const root = fs.realpathSync(makeTempDir('acb-temp-dirs-test-'))
  const leftover = path.join(root, 'acb-first-Aa1234')
  fs.mkdirSync(leftover); ageBy(leftover, OLD)
  const made = makeTempDir('acb-first-', { root })
  assert.equal(fs.existsSync(leftover), false)
  assert.equal(fs.existsSync(made), true)
})

/** A child Node process that makes a folder under `root` with the helper, then ends as `how` says. */
function child(root: string, how: string): { pid: number; done: Promise<void>; ready: Promise<string> } {
  const script = `
    import { spawn } from 'node:child_process'
    import fs from 'node:fs'
    import { makeTempDir, stopWithTempDirs } from ${JSON.stringify(helper)}
    const dir = makeTempDir('acb-end-', { root: ${JSON.stringify(root)} })
    fs.writeFileSync(dir + '/f', 'x')
    const how = ${JSON.stringify(how)}
    if (how === 'writer') {
      // A grandchild that keeps writing in the folder (an Electron harness's stand-in).
      const writer = spawn(process.execPath, ['-e', 'setInterval(() => { try { require("fs").writeFileSync(process.argv[1] + "/w", "x") } catch {} }, 5)', dir], { stdio: 'ignore' })
      stopWithTempDirs(writer)
      fs.writeFileSync(${JSON.stringify(path.join(root, 'writer.pid'))}, String(writer.pid))
    }
    console.log(dir)
    if (how === 'normal') process.exit(0)
    if (how === 'throw') setTimeout(() => { throw new Error('boom') }, 0)
    else setInterval(() => {}, 1000)
  `
  const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: clientDir, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const ready = new Promise<string>(resolve => proc.stdout.on('data', c => { out += c; if (out.includes('\n')) resolve(out.trim()) }))
  const done = new Promise<void>(resolve => proc.on('close', () => resolve()))
  return { pid: proc.pid!, done, ready }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test('a folder goes when its process ends: normally, by an uncaught exception, by SIGTERM or SIGINT', async () => {
  const root = fs.realpathSync(makeTempDir('acb-temp-dirs-test-'))
  for (const how of ['normal', 'throw', 'SIGTERM', 'SIGINT']) {
    const c = child(root, how)
    const dir = await c.ready
    assert.equal(dir.startsWith(path.join(root, 'acb-end-')), true)
    if (how.startsWith('SIG')) process.kill(c.pid, how as NodeJS.Signals)
    await c.done
    assert.equal(fs.existsSync(dir), false, `${how}: the folder is gone`)
  }
})

test('a child still writing in the folder is stopped before the folder goes', async () => {
  const root = fs.realpathSync(makeTempDir('acb-temp-dirs-test-'))
  const c = child(root, 'writer')
  const dir = await c.ready
  const writer = Number(fs.readFileSync(path.join(root, 'writer.pid'), 'utf8'))
  process.kill(c.pid, 'SIGTERM')
  await c.done
  for (let i = 0; i < 100 && alive(writer); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(alive(writer), false, 'the writer was stopped')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(fs.existsSync(dir), false, 'and nothing wrote the folder back')
})

test('the test files that left the most behind (kept logins, the document player) leave no temp folder', () => {
  const tmp = fs.realpathSync(makeTempDir('acb-temp-dirs-run-'))
  // Not as a child of this test runner (NODE_TEST_CONTEXT would make it report here instead of running on its own).
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  for (const file of ['tests/browser-kept-logins.test.ts', 'tests/doc-player.test.ts']) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', file], { cwd: clientDir, env: { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, encoding: 'utf8', timeout: 240_000 })
    assert.equal(run.status, 0, `${file} passed:\n${run.stdout.slice(-2000)}\n${run.stderr.slice(-2000)}`)
    assert.match(run.stdout, /# pass [1-9]/, `${file} ran its tests`)
    assert.deepEqual(fs.readdirSync(tmp).filter(name => name.startsWith('acb-')), [], `${file} left nothing`)
  }
})
