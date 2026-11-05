// What the next sync does about a sync that never finished (.claude/rules/
// sync-guards.md "Repository state and concurrency"): the app quit or crashed,
// git was killed. Whatever the member (or the AI) changed on disk while it was
// stopped survives the clean-up in the backups; a backup that fails stops with
// everything in place; a lock nobody holds any more does not stop sync forever.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { World, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'
import { privateBackupsDir } from '../../electron/sync/private-folders'
import { INDEX_LOCK_STALE_MS, REPOSITORY_BUSY_MESSAGE, REPOSITORY_RECORD_MESSAGE, RECOVERY_FAILED_MESSAGE, RECOVERY_UNREADABLE_MESSAGE, lockFailureMessage, nestedRepoInTheWayMessage, recoveryBackupFailedMessage } from '../../electron/sync/interrupted'
import { readLsofAnswer } from '../../electron/sync/live-git'
import { spawn } from 'node:child_process'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { timeout: 10 * 60_000 }, fn)

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

function create(t: TestContext) {
  const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', 'y.md': 'y\n' } })
  return { world, a: world.member('a'), b: world.member('b') }
}

/** A teammate and the member changed x.md; `stop` runs what a killed sync left behind. */
async function conflictingCommit(a: Member, b: Member) {
  b.write('x.md', 'b\n')
  ok(await b.sync(), 'b')
  a.write('x.md', 'a\n')
  a.git(['commit', '-qam', 'local work'])
  a.git(['fetch', '-q', 'origin'])
}

async function stoppedRebase(a: Member, b: Member) {
  await conflictingCommit(a, b)
  assert.throws(() => a.git(['rebase', 'origin/main']))
}

/** A second stop after the first was cleaned up: the teammate changes x.md again. */
async function stoppedRebaseAgain(a: Member, b: Member) {
  ok(await b.sync(), 'b')
  b.write('x.md', 'b again\n')
  ok(await b.sync(), 'b')
  a.write('x.md', 'a again\n')
  a.git(['commit', '-qam', 'local work again'])
  a.git(['fetch', '-q', 'origin'])
  assert.throws(() => a.git(['rebase', 'origin/main']))
}

const stopped = (m: Member) => ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some(s => fs.existsSync(m.path(`.git/${s}`)))

function recoveryBackup(m: Member) {
  const found = m.backups().filter(b => b.folder.endsWith('_before_recovery'))
  assert.equal(found.length, 1, JSON.stringify(m.backups()))
  return found[0]
}

const backupFile = (m: Member, root: string, rel: string) => fs.readFileSync(path.join(root, recoveryBackup(m).folder.replace(/^private:/, ''), rel), 'utf-8')

/** Backups cannot be written until `unlock`, which the scenario calls before it goes on. */
function lockBackups(m: Member) {
  const dir = m.path('.backups')
  fs.mkdirSync(dir, { recursive: true })
  fs.chmodSync(dir, 0o555)
  return () => fs.chmodSync(dir, 0o755)
}

function leaveIndexLock(m: Member, ageMs: number, dir = m.dir) {
  return leaveLock(m, 'index.lock', ageMs, dir)
}

function leaveLock(m: Member, name: string, ageMs: number, dir = m.dir) {
  const lock = path.join(dir, '.git', name)
  fs.writeFileSync(lock, '')
  const at = new Date(Date.now() - ageMs)
  fs.utimesSync(lock, at, at)
  return lock
}

const OLD = INDEX_LOCK_STALE_MS + 60_000

describe('a sync that never finished', { concurrency: CONCURRENCY }, () => {
  scenario('files edited while a rebase was stopped are in .backups after the next sync, and the member is told', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    a.write('y.md', '衝突していないファイルも直した\n')

    const out = ok(await a.sync(), 'a')

    const backup = recoveryBackup(a)
    assert.equal(backup.metadata.reason, 'before_recovery')
    assert.deepEqual(backup.files, ['x.md', 'y.md'])
    assert.equal(backupFile(a, a.path('.backups'), 'x.md'), '止まっている間に直した内容\n')
    assert.equal(backupFile(a, a.path('.backups'), 'y.md'), '衝突していないファイルも直した\n')
    assert.deepEqual(out.result.recoveredFiles, ['x.md', 'y.md'])
    assert.equal(out.result.recoveryBackupPath, a.path(`.backups/${backup.folder}`))
    assert.match(String(out.result.message), /前回の同期が途中で止まっていたため/)
    assert.match(String(out.result.message), /『x\.md』/)
    await settleAndCheck(world)
  })

  scenario('a file edited during a stopped merge or cherry-pick is kept too', async t => {
    for (const stop of [
      (m: Member) => m.git(['merge', 'origin/main']),
      (m: Member) => m.git(['cherry-pick', 'origin/main']),
    ]) {
      const { world, a, b } = create(t)
      await conflictingCommit(a, b)
      assert.throws(() => stop(a))
      a.write('x.md', '止まっている間に直した内容\n')
      ok(await a.sync(), 'a')
      assert.equal(backupFile(a, a.path('.backups'), 'x.md'), '止まっている間に直した内容\n')
      await settleAndCheck(world)
    }
  })

  scenario('git refuses to abort because a staged file was edited: the copy exists, so sync goes back anyway', async t => {
    for (const stop of [
      (m: Member) => m.git(['merge', 'origin/main']),
      (m: Member) => m.git(['cherry-pick', 'origin/main']),
    ]) {
      const { world, a, b } = create(t)
      b.write('y.md', 'bの変更\n')
      await conflictingCommit(a, b)
      assert.throws(() => stop(a))
      a.write('y.md', '止まっている間に直した内容\n')
      assert.throws(() => a.git([fs.existsSync(a.path('.git/MERGE_HEAD')) ? 'merge' : 'cherry-pick', '--abort']), /not uptodate/)

      ok(await a.sync(), 'a')

      assert.equal(stopped(a), false)
      assert.equal(backupFile(a, a.path('.backups'), 'y.md'), '止まっている間に直した内容\n')
      await settleAndCheck(world)
    }
  })

  scenario('a rebase git cannot read back any more is cleaned up too, on the member\'s branch', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    fs.rmSync(a.path('.git/rebase-merge/head-name'))

    ok(await a.sync(), 'a')

    assert.equal(backupFile(a, a.path('.backups'), 'x.md'), '止まっている間に直した内容\n')
    assert.equal(a.git(['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main')
    await settleAndCheck(world)
  })

  scenario('a leftover HEAD.lock under a stopped rebase is no dead end', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    leaveLock(a, 'HEAD.lock', OLD)
    ok(await a.sync(), 'a')
    assert.equal(backupFile(a, a.path('.backups'), 'x.md'), '止まっている間に直した内容\n')
    await settleAndCheck(world)
  })

  scenario('a clean-up that half failed never costs the member\'s text: the next try gets its own folder', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', 'zlock/z.md': 'z0\n' } })
    const [a, b] = world.members
    await stoppedRebase(a, b)
    a.write('x.md', '何時間もかけて直した内容\n')
    a.git(['add', 'x.md'])
    a.write('x.md', '何時間もかけて直した内容、さらに直した\n')
    a.write('zlock/z.md', 'z\n')
    // This folder cannot be written (a file another app holds): abort and reset fail half-way,
    // after git has already put x.md back.
    fs.chmodSync(a.path('zlock'), 0o555)

    a.mayLeaveOperation = true
    const failed = await a.sync()
    assert.equal(failed.result.error, RECOVERY_FAILED_MESSAGE)
    assert.ok(failed.result.recoveryBackupPath, 'the member can reach the copy from the failed sync')
    assert.notEqual(a.readText('x.md'), '何時間もかけて直した内容、さらに直した\n', 'the reset did rewrite it')
    const first = failed.result.recoveryBackupPath as string
    fs.chmodSync(a.path('zlock'), 0o755)
    a.mayLeaveOperation = false

    const out = ok(await a.sync(), 'a')

    assert.equal(fs.readFileSync(path.join(first, 'x.md'), 'utf-8'), '何時間もかけて直した内容、さらに直した\n')
    assert.equal(out.result.recoveryBackupPath, first, 'the notice points at what the member really had')
    assert.match(String(out.result.message), /保存先も2か所あります/)
    assert.ok((out.result.recoveredFiles ?? []).includes('x.md'))
    await settleAndCheck(world)
  })

  scenario('someone else finishes the stopped rebase after a failed try: the member still hears of the copy, and the next incident touches nothing of it', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', 'zlock/z.md': 'z0\n' } })
    const [a, b] = world.members
    await stoppedRebase(a, b)
    a.write('x.md', '一度目の内容\n')
    a.write('zlock/z.md', 'z\n')
    fs.chmodSync(a.path('zlock'), 0o555)
    a.mayLeaveOperation = true
    const first = (await a.sync()).result.recoveryBackupPath as string
    fs.chmodSync(a.path('zlock'), 0o755)
    a.mayLeaveOperation = false
    a.git(['rebase', '--abort'])

    const told = ok(await a.sync(), 'a')
    assert.equal(told.result.recoveryBackupPath, first)
    assert.equal(fs.existsSync(a.path('.git/acb-recovery-pending.json')), false)

    await stoppedRebaseAgain(a, b)
    a.write('x.md', '二度目の内容\n')
    const again = ok(await a.sync(), 'a')
    assert.notEqual(again.result.recoveryBackupPath, first)
    assert.equal(fs.readFileSync(path.join(first, 'x.md'), 'utf-8'), '一度目の内容\n')
    await settleAndCheck(world)
  })

  scenario('a try that leaves the state behind still gets its note at the next press', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    a.git(['add', 'x.md'])
    a.write('x.md', 'さらに直した\n')
    // The reset works, removing the state does not.
    fs.chmodSync(a.path('.git/rebase-merge'), 0o555)
    a.mayLeaveOperation = true
    const failed = await a.sync()
    assert.equal(failed.result.error, RECOVERY_FAILED_MESSAGE)
    fs.chmodSync(a.path('.git/rebase-merge'), 0o755)
    a.mayLeaveOperation = false

    const out = ok(await a.sync(), 'a')

    assert.deepEqual(out.result.recoveredFiles, ['x.md'])
    assert.match(String(out.result.message), /前回の同期が途中で止まっていたため/)
    await settleAndCheck(world)
  })

  scenario('a nested repository where the local version has a file stops everything: nothing is wiped', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', sub: 'file\n' } })
    const [a, b] = world.members
    await stoppedRebase(a, b)
    fs.rmSync(a.path('sub'))
    fs.mkdirSync(a.path('sub'))
    world.git(a.path('sub'), ['init', '-q'])
    a.write('sub/own.md', '取り込んだフォルダの中身\n')

    a.mayLeaveOperation = true
    const failed = await a.sync()

    assert.equal(failed.result.error, nestedRepoInTheWayMessage('sub'))
    assert.ok(stopped(a))
    assert.ok(fs.existsSync(a.path('sub/.git')))
    assert.equal(a.readText('sub/own.md'), '取り込んだフォルダの中身\n')

    // The way out the sentence gives.
    a.mayLeaveOperation = false
    fs.renameSync(a.path('sub'), path.join(a.dir, '..', 'moved-away'))
    ok(await a.sync(), 'a')
    assert.equal(stopped(a), false)
  })

  scenario('commits made during the stop are kept: their files, a ref, and the member is told', async t => {
    for (const onMain of [false, true]) {
      const { world, a, b } = create(t)
      await stoppedRebase(a, b)
      if (onMain) a.git(['checkout', '-q', '-f', 'main'])
      else a.write('x.md', 'AIが解決した内容\n')
      a.write('new.md', '止まっている間にコミットした内容\n')
      a.git(['add', '-A'])
      a.git(['commit', '-qm', 'work made during the stop'])
      const madeDuringStop = a.head()

      const out = ok(await a.sync(), 'a')

      assert.equal(backupFile(a, a.path('.backups'), 'new.md'), '止まっている間にコミットした内容\n')
      assert.ok((out.result.recoveredFiles ?? []).includes('new.md'))
      assert.match(a.git(['for-each-ref', '--format=%(objectname)', 'refs/acb-recovery/']), new RegExp(madeDuringStop))
      await settleAndCheck(world)
    }
  })

  scenario('a rebase that only replayed the member\'s commits copies nothing extra', async t => {
    const { world, a, b } = create(t)
    b.write('t.md', 'teammate\n')
    ok(await b.sync(), 'b')
    a.write('first.md', 'first\n')
    a.git(['add', '-A'])
    a.git(['commit', '-qm', 'first'])
    a.write('x.md', 'a\n')
    a.git(['commit', '-qam', 'second'])
    b.write('x.md', 'b\n')
    ok(await b.sync(), 'b')
    a.git(['fetch', '-q', 'origin'])
    assert.throws(() => a.git(['rebase', 'origin/main']))

    const out = ok(await a.sync(), 'a')

    assert.deepEqual(out.result.recoveredFiles, ['x.md'], 'the replayed first.md and the teammate\'s t.md are nobody\'s lost work')
    await settleAndCheck(world)
  })

  scenario('content only the index holds is kept: staged, then changed back or removed on disk', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('y.md', 'ステージだけにある内容\n')
    a.git(['add', 'y.md'])
    a.write('y.md', 'y\n')
    a.write('n.md', 'ステージだけにある新しいファイル\n')
    a.git(['add', 'n.md'])
    fs.rmSync(a.path('n.md'))

    ok(await a.sync(), 'a')

    assert.equal(backupFile(a, a.path('.backups'), 'y.md.staged-version'), 'ステージだけにある内容\n')
    assert.equal(backupFile(a, a.path('.backups'), 'n.md'), 'ステージだけにある新しいファイル\n')
    await settleAndCheck(world)
  })

  scenario('ignored files the clean-up would take are kept too', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], gitignore: '*.secret\n', seed: { 'x.md': '0\n', doc: 'file\n' } })
    const [a, b] = world.members
    await stoppedRebase(a, b)
    fs.rmSync(a.path('doc'))
    a.write('doc/key.secret', 'フォルダの中の無視されるファイル\n')
    a.write('doc/plain.txt', '普通のファイル\n')

    ok(await a.sync(), 'a')

    assert.equal(backupFile(a, a.path('.backups'), 'doc/key.secret'), 'フォルダの中の無視されるファイル\n')
    assert.equal(backupFile(a, a.path('.backups'), 'doc/plain.txt'), '普通のファイル\n')
    await settleAndCheck(world)
  })

  scenario('a file the local version tracks and the stop has ignored and untracked is kept: nothing but the local version knows it', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', 'notes/a.txt': 'old\n' } })
    const [a, b] = world.members
    // The teammate stopped sharing the folder, so during the stop git neither tracks nor lists it.
    b.remove('notes/a.txt')
    b.append('.gitignore', 'notes/\n')
    await stoppedRebase(a, b)
    a.write('notes/a.txt', '止まっている間に作り直した内容\n')
    assert.equal(a.git(['status', '--porcelain', '--', 'notes']).trim(), '')

    ok(await a.sync(), 'a')

    assert.equal(backupFile(a, a.path('.backups'), 'notes/a.txt'), '止まっている間に作り直した内容\n')
  })

  scenario('a file and a folder with one name in the same stop are both kept: no permanent stop', async t => {
    // Ordinary work, nothing done during the stop: doc became a folder in the first commit, the
    // app was killed in the conflict of the second, so HEAD has the folder and the local version a file.
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', 'y.md': '0\n', doc: 'd\n' } })
    const [a, b] = world.members
    b.write('x.md', 'server\n').write('y.md', 'server\n')
    ok(await b.sync(), 'b')
    fs.rmSync(a.path('doc'))
    a.write('doc/new.md', '作業の内容\n').write('x.md', 'local\n')
    a.git(['add', '-A'])
    a.git(['commit', '-qm', 'first'])
    a.write('y.md', 'local\n')
    a.git(['add', '-A'])
    a.git(['commit', '-qm', 'second'])
    a.git(['fetch', '-q', 'origin'])
    assert.throws(() => a.git(['rebase', 'origin/main']))
    a.git(['checkout', '--ours', 'x.md'])
    a.git(['add', '-f', 'x.md'])
    assert.throws(() => a.git(['-c', 'core.editor=true', 'rebase', '--continue']))

    const out = ok(await a.sync(), 'a')

    assert.equal(stopped(a), false)
    assert.equal(backupFile(a, a.path('.backups'), 'doc/new.md'), '作業の内容\n')
    assert.ok(!(out.result.recoveredFiles ?? []).includes('doc'), 'a folder at that version is no file to copy')
    await settleAndCheck(world)
  })

  scenario('commits that swapped a file and a folder during the stop, and a staged file under a name now a file, keep every version', async t => {
    for (const swap of [
      (m: Member) => {
        m.write('p/q.md', 'フォルダの中の版\n')
        m.git(['add', '-A'])
        m.git(['commit', '-qm', 'folder'])
        fs.rmSync(m.path('p'), { recursive: true })
        m.write('p', 'ファイルの版\n')
        m.git(['add', '-A'])
        m.git(['commit', '-qm', 'file'])
        m.write('p', 'あとで直した版\n')
      },
      (m: Member) => {
        m.write('p/q.md', 'フォルダの中の版\n')
        m.git(['add', 'p/q.md'])
        fs.rmSync(m.path('p'), { recursive: true })
        m.write('p', 'あとで直した版\n')
      },
    ]) {
      const { world, a, b } = create(t)
      await stoppedRebase(a, b)
      a.write('x.md', 'AIが解決した内容\n')
      a.git(['add', '-A'])
      a.git(['commit', '-qm', 'resolved'])
      swap(a)

      ok(await a.sync(), 'a')

      const texts = recoveryBackup(a).files.map(f => fs.readFileSync(path.join(a.path('.backups'), recoveryBackup(a).folder, f), 'utf-8'))
      assert.ok(texts.includes('フォルダの中の版\n'), JSON.stringify(recoveryBackup(a).files))
      // A new file the clean-up does not touch stays where it is (the staged case); otherwise it is in the copy.
      const onDisk = a.exists('p') && fs.statSync(a.path('p')).isFile() && a.readText('p') === 'あとで直した版\n'
      assert.ok(onDisk || texts.includes('あとで直した版\n'), JSON.stringify(recoveryBackup(a).files))
      await settleAndCheck(world)
    }
  })

  scenario('a recovery ref goes with its backup folder', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    ok(await a.sync(), 'a')
    assert.notEqual(a.git(['for-each-ref', 'refs/acb-recovery/']).trim(), '')

    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const folder = a.path(`.backups/${recoveryBackup(a).folder}`)
    fs.utimesSync(folder, old, old)
    ok(await a.sync(), 'a')

    assert.equal(fs.existsSync(folder), false)
    assert.equal(a.git(['for-each-ref', 'refs/acb-recovery/']).trim(), '')
    await settleAndCheck(world)
  })

  scenario('a stop that cannot be read never counts as nothing at risk', async t => {
    for (const breakIt of [
      (m: Member) => fs.writeFileSync(m.path('.git/index'), 'garbage'),
      (m: Member) => {
        const tree = m.git(['rev-parse', 'main^{tree}']).trim()
        fs.rmSync(m.path(`.git/objects/${tree.slice(0, 2)}/${tree.slice(2)}`), { force: true })
      },
    ]) {
      const { a, b } = create(t)
      await stoppedRebase(a, b)
      a.write('x.md', '止まっている間に直した内容\n')
      breakIt(a)
      a.mayLeaveOperation = true
      const failed = await a.sync()
      assert.equal(failed.result.error, RECOVERY_UNREADABLE_MESSAGE)
      assert.ok(stopped(a))
      assert.equal(a.readText('x.md'), '止まっている間に直した内容\n')
    }
  })

  scenario('a rebase something is still running is left alone', async t => {
    const { a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    a.mayLeaveOperation = true

    a.otherGitRunning = true
    const ai = await a.sync()
    assert.equal(ai.result.errorType, 'locked')
    assert.equal(ai.result.error, REPOSITORY_BUSY_MESSAGE)
    assert.ok(stopped(a))
    a.otherGitRunning = false

    const other = spawn('git', ['cat-file', '--batch'], { cwd: a.dir, stdio: ['pipe', 'ignore', 'ignore'] })
    t.after(() => { other.kill() })
    await new Promise(resolve => other.once('spawn', resolve))
    const live = await a.sync()
    assert.equal(live.result.error, REPOSITORY_BUSY_MESSAGE)
    assert.ok(stopped(a))
    assert.deepEqual(a.backups(), [])
    assert.equal(a.readText('x.md'), '止まっている間に直した内容\n')
  })

  scenario('a read-only private folder cleaned up just before going offline still tells the member', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    world.createPrivateFolder('秘密', { viewers: ['a', 'b'], editors: ['b'], files: { 's.md': '0\n' } })
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    b.write('秘密/s.md', 'b\n')
    ok(await b.sync(), 'b')
    const clone = a.path('秘密')
    fs.writeFileSync(path.join(clone, 's.md'), 'a\n')
    world.git(clone, ['commit', '-qam', 'local work'])
    world.git(clone, ['fetch', '-q', 'origin'])
    assert.throws(() => world.git(clone, ['rebase', 'origin/main']))
    fs.writeFileSync(path.join(clone, 's.md'), '止まっている間に直した内容\n')
    a.offline()

    const out = await a.sync()

    const report = out.result.privateFolders?.find(f => f.path === '秘密')
    assert.equal(report?.setAside, true)
    assert.ok(report?.backupPath)
    assert.match(String(out.result.error), /前回の同期が途中で止まっていたため/)
  })

  scenario('a backup that cannot be written names the file, says nothing about the disk, and leaves no half copy', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    a.write('y.md', 'こちらは読めないファイル\n')
    fs.chmodSync(a.path('y.md'), 0o000)

    a.mayLeaveOperation = true
    const failed = await a.sync()

    assert.equal(failed.result.success, false)
    assert.match(String(failed.result.error), /『y\.md』をバックアップに保存できなかった/)
    assert.doesNotMatch(String(failed.result.error), /ディスク/)
    assert.ok(stopped(a), 'the stopped rebase is left alone')
    assert.equal(a.readText('x.md'), '止まっている間に直した内容\n')
    assert.deepEqual(a.backups(), [], 'no half copy')

    a.mayLeaveOperation = false
    fs.chmodSync(a.path('y.md'), 0o644)
    ok(await a.sync(), 'a')
    assert.equal(backupFile(a, a.path('.backups'), 'x.md'), '止まっている間に直した内容\n')
    await settleAndCheck(world)
  })

  scenario('the disk is named only when it is the disk', () => {
    const full = recoveryBackupFailedMessage('x.md', Object.assign(new Error('x'), { code: 'ENOSPC' }))
    assert.match(full, /ディスクの空きが足りず/)
    const busy = recoveryBackupFailedMessage('x.md', Object.assign(new Error('x'), { code: 'EBUSY' }))
    assert.match(busy, /『x\.md』/)
    assert.doesNotMatch(busy, /ディスク/)
    return Promise.resolve()
  })

  scenario('a folder replaced by a file of the same name neither stops the sync nor loses the file', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', 'd/f.md': 'f\n' } })
    const [a, b] = world.members
    await stoppedRebase(a, b)
    fs.rmSync(a.path('d'), { recursive: true })
    a.write('d', 'フォルダだった名前のファイル\n')

    ok(await a.sync(), 'a')

    assert.equal(backupFile(a, a.path('.backups'), 'd'), 'フォルダだった名前のファイル\n')
    await settleAndCheck(world)
  })

  scenario('only what the clean-up can touch is copied: a new file it would overwrite, not any other', async t => {
    const { world, a, b } = create(t)
    b.write('x.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('x.md', 'a\n')
    a.git(['commit', '-qam', 'first local commit'])
    a.write('later.md', 'committed later\n')
    a.git(['add', 'later.md'])
    a.git(['commit', '-qm', 'second local commit'])
    a.git(['fetch', '-q', 'origin'])
    assert.throws(() => a.git(['rebase', 'origin/main']))
    assert.equal(a.exists('later.md'), false, 'the rebase has not reached it')
    a.write('later.md', 'the abort overwrites this\n')
    a.write('other.md', 'nothing touches this\n')

    const out = ok(await a.sync(), 'a')

    assert.deepEqual([...(out.result.recoveredFiles ?? [])].sort(), ['later.md', 'x.md'])
    assert.equal(backupFile(a, a.path('.backups'), 'later.md'), 'the abort overwrites this\n')
    assert.equal(a.readText('other.md'), 'nothing touches this\n')
    await settleAndCheck(world)
  })

  scenario('backups past their 30 days go first, private ones too: a full disk gets its space back', async t => {
    const { a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const company = a.path('.backups/old')
    const secret = path.join(privateBackupsDir(a.dir), 'old')
    for (const dir of [company, secret]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.utimesSync(dir, old, old)
    }
    // The copy fails, as on a full disk.
    fs.chmodSync(a.path('x.md'), 0o000)

    a.mayLeaveOperation = true
    await a.sync()
    fs.chmodSync(a.path('x.md'), 0o644)

    assert.equal(fs.existsSync(company), false)
    assert.equal(fs.existsSync(secret), false)
  })

  scenario('a member\'s own _metadata.json survives next to the backup\'s', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n', '_metadata.json': '{}\n' } })
    const [a, b] = world.members
    await stoppedRebase(a, b)
    a.write('_metadata.json', '{"mine":true}\n')

    ok(await a.sync(), 'a')

    assert.equal(recoveryBackup(a).metadata.reason, 'before_recovery')
    assert.equal(backupFile(a, a.path('.backups'), '_metadata (member).json'), '{"mine":true}\n')
    await settleAndCheck(world)
  })

  scenario('what sync keeps on this computer anyway is not copied into the recovery backup', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], gitignore: '.backups/\n!.backups/\n', seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    await stoppedRebase(a, b)
    a.write('.backups/earlier/old.md', 'an earlier backup\n')
    a.write('x.md', '止まっている間に直した内容\n')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.recoveredFiles, ['x.md'])
  })

  scenario('a stopped rebase in a private folder keeps its copy with the private backups', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    world.createPrivateFolder('秘密', { viewers: ['a', 'b'], editors: ['a', 'b'], files: { 's.md': '0\n' } })
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    b.write('秘密/s.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('秘密/s.md', 'a\n')
    const clone = a.path('秘密')
    world.git(clone, ['commit', '-qam', 'local work'])
    world.git(clone, ['fetch', '-q', 'origin'])
    assert.throws(() => world.git(clone, ['rebase', 'origin/main']))
    a.write('秘密/s.md', '止まっている間に直した内容\n')

    const out = ok(await a.sync(), 'a')

    assert.equal(backupFile(a, privateBackupsDir(a.dir), '秘密/s.md'), '止まっている間に直した内容\n')
    assert.ok(recoveryBackup(a).folder.startsWith('private:'), 'never in the working tree')
    const report = out.result.privateFolders?.find(f => f.path === '秘密')
    assert.equal(report?.setAside, true)
    assert.equal(report?.backupPath, path.join(privateBackupsDir(a.dir), recoveryBackup(a).folder.replace(/^private:/, '')))
    assert.match(String(out.result.message), /非公開フォルダのバックアップ/)
    await settleAndCheck(world)
  })

  scenario('a read-only private folder keeps what a stopped rebase left too', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    world.createPrivateFolder('秘密', { viewers: ['a', 'b'], editors: ['b'], files: { 's.md': '0\n' } })
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    b.write('秘密/s.md', 'b\n')
    ok(await b.sync(), 'b')
    const clone = a.path('秘密')
    fs.writeFileSync(path.join(clone, 's.md'), 'a\n')
    world.git(clone, ['commit', '-qam', 'local work'])
    world.git(clone, ['fetch', '-q', 'origin'])
    assert.throws(() => world.git(clone, ['rebase', 'origin/main']))
    fs.writeFileSync(path.join(clone, 's.md'), '止まっている間に直した内容\n')

    const out = ok(await a.sync(), 'a')

    assert.equal(backupFile(a, privateBackupsDir(a.dir), '秘密/s.md'), '止まっている間に直した内容\n')
    assert.equal(out.result.privateFolders?.find(f => f.path === '秘密')?.setAside, true)
  })
})

describe('a conflict backup that fails', { concurrency: CONCURRENCY }, () => {
  scenario('stops the sync in plain Japanese: the rebase is undone and the member\'s commit stays', async t => {
    const { world, a, b } = create(t)
    b.write('x.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('x.md', 'a\n')
    const unlock = lockBackups(a)

    const failed = await a.sync()

    assert.equal(failed.result.success, false)
    assert.match(String(failed.result.error), /バックアップを保存できなかったため、同期を中止しました/)
    assert.doesNotMatch(String(failed.result.error), /[A-Za-z]{4}/, 'no git message for the member')
    assert.doesNotMatch(String(failed.result.error), /ディスク/, 'a folder that refuses writing is not a full disk')
    assert.equal(a.readText('x.md'), 'a\n')
    assert.equal(world.serverFile('x.md')?.toString(), 'b\n')

    unlock()
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.conflictFiles, ['x.md'])
    await settleAndCheck(world)
  })

  scenario('a copy that cannot be written is never taken for a file with nothing to save', async t => {
    const { world, a, b } = create(t)
    b.write('x.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('x.md', 'a\n')
    // Writing the copy fails (a folder is in its place); before, that read as
    // "not there" and the server's version replaced the member's without one.
    a.clock = new Date('2026-11-04T01:02:03.456Z')
    fs.mkdirSync(a.path('.backups/2026-11-04T01-02-03-456/x.md'), { recursive: true })

    const failed = await a.sync()

    assert.equal(failed.result.success, false)
    assert.match(String(failed.result.error), /バックアップを保存できなかった/)
    assert.equal(a.readText('x.md'), 'a\n')

    a.clock = null
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
  })
})

describe('an earlier version that cannot be saved', { concurrency: CONCURRENCY }, () => {
  scenario('stops the sync the same way', async t => {
    const { world, a, b } = create(t)
    b.write('x.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('x.md', 'first\n')
    a.git(['commit', '-qam', 'first version'])
    a.write('x.md', 'second\n')
    a.clock = new Date('2026-11-04T01:02:03.456Z')
    fs.mkdirSync(a.path('.backups/2026-11-04T01-02-03-456_1/x.md'), { recursive: true })

    const failed = await a.sync()

    assert.equal(failed.result.success, false)
    assert.match(String(failed.result.error), /バックアップを保存できなかった/)
    assert.equal(a.readText('x.md'), 'second\n')

    a.clock = null
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
  })
})

describe('a leftover index.lock', { concurrency: CONCURRENCY }, () => {
  scenario('older than a few minutes with no app git running: removed, and the sync goes through', async t => {
    const { world, a } = create(t)
    a.write('y.md', 'a\n')
    const lock = leaveIndexLock(a, OLD)
    ok(await a.sync(), 'a')
    assert.equal(fs.existsSync(lock), false)
    assert.equal(world.serverFile('y.md')?.toString(), 'a\n')
    await settleAndCheck(world)
  })

  scenario('removed first when a rebase is stopped as well, so the clean-up can run', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    leaveIndexLock(a, OLD)
    ok(await a.sync(), 'a')
    assert.equal(backupFile(a, a.path('.backups'), 'x.md'), '止まっている間に直した内容\n')
    await settleAndCheck(world)
  })

  scenario('younger, or with the app\'s other git running: left alone, with a plain sentence, and nothing changes', async t => {
    const { world, a } = create(t)
    a.write('y.md', 'a\n')
    a.mayLeaveOperation = true

    const lock = leaveIndexLock(a, 1000)
    const young = await a.sync()
    assert.equal(young.result.errorType, 'locked')
    assert.equal(young.result.error, REPOSITORY_BUSY_MESSAGE)
    assert.ok(fs.existsSync(lock))

    leaveIndexLock(a, OLD)
    a.otherGitRunning = true
    const busy = await a.sync()
    assert.equal(busy.result.error, REPOSITORY_BUSY_MESSAGE)
    assert.ok(fs.existsSync(lock))

    assert.equal(a.readText('y.md'), 'a\n')
    assert.equal(world.serverFile('y.md')?.toString(), 'y\n')

    a.otherGitRunning = false
    a.mayLeaveOperation = false
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
  })

  scenario('its age is read off the folder\'s own clock: a computer clock far ahead does not make a live lock old', async t => {
    const { a } = create(t)
    a.write('y.md', 'a\n')
    const lock = leaveIndexLock(a, 1000)
    a.clock = new Date(Date.now() + 24 * 60 * 60 * 1000)
    a.mayLeaveOperation = true
    const out = await a.sync()
    assert.equal(out.result.error, REPOSITORY_BUSY_MESSAGE)
    assert.ok(fs.existsSync(lock))
  })

  scenario('a live git working in the folder keeps its lock, however old', async t => {
    const { world, a } = create(t)
    a.write('y.md', 'a\n')
    const lock = leaveIndexLock(a, OLD)
    // Stays alive while its stdin is open, like any long git the app did not start.
    const other = spawn('git', ['cat-file', '--batch'], { cwd: a.dir, stdio: ['pipe', 'ignore', 'ignore'] })
    t.after(() => { other.kill() })
    await new Promise(resolve => other.once('spawn', resolve))

    a.mayLeaveOperation = true
    const out = await a.sync()
    assert.equal(out.result.error, REPOSITORY_BUSY_MESSAGE)
    assert.ok(fs.existsSync(lock))

    await new Promise(resolve => { other.once('exit', resolve); other.kill() })
    a.mayLeaveOperation = false
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
  })

  scenario('lsof that fails is no answer: the lock stays; a computer without lsof is not stopped for good', () => {
    const root = '/c/会社'
    assert.equal(readLsofAnswer(null, 'p1\nn/c/会社/部署\n', root), 'yes')
    assert.equal(readLsofAnswer(Object.assign(new Error('x'), { code: 1 }), '', root), 'no')
    assert.equal(readLsofAnswer(null, 'p1\nn/c/会社2\n', root), 'no')
    assert.equal(readLsofAnswer(Object.assign(new Error('timeout'), { killed: true, code: null }), '', root), 'unknown')
    assert.equal(readLsofAnswer(Object.assign(new Error('x'), { code: 2 }), '', root), 'unknown')
    assert.equal(readLsofAnswer(Object.assign(new Error('x'), { code: 'ENOENT' }), '', root), 'no')
    return Promise.resolve()
  })

  scenario('a leftover lock on the remote branch is cleared as well', async t => {
    const { world, a } = create(t)
    a.write('y.md', 'a\n')
    fs.mkdirSync(a.path('.git/refs/remotes/origin'), { recursive: true })
    const lock = leaveLock(a, 'refs/remotes/origin/main.lock', OLD)
    ok(await a.sync(), 'a')
    assert.equal(fs.existsSync(lock), false)
    await settleAndCheck(world)
  })

  scenario('a git inside a nested repository works on that repository: it does not hold this one back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-live-git-'))
    fs.mkdirSync(path.join(root, 'clone', '.git'), { recursive: true })
    fs.mkdirSync(path.join(root, 'clone', 'in'))
    assert.equal(readLsofAnswer(null, `n${root}/clone/in\n`, root), 'no')
    assert.equal(readLsofAnswer(null, `n${root}/plain\n`, root), 'yes')
    fs.rmSync(root, { recursive: true })
    return Promise.resolve()
  })

  scenario('a download-choice change does not read as busy to the private folders it applies', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    world.createPrivateFolder('秘密', { viewers: ['a', 'b'], editors: ['a', 'b'], files: { 's.md': '0\n' } })
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    assert.equal((await a.excludeFolder('秘密')).success, true)
    leaveIndexLock(a, OLD, a.path('秘密'))

    // The app's own change is running: it is what called this.
    a.otherGitRunning = true
    const reports = await a.applyPrivateFolderChoices()
    a.otherGitRunning = false

    assert.deepEqual(reports.map(r => [r.path, r.success, r.removed]), [['秘密', true, true]])
  })

  scenario('the sentence fits the failure, and a file named .lock is no lock', () => {
    assert.equal(lockFailureMessage("fatal: Unable to create '/c/.git/index.lock': File exists."), REPOSITORY_BUSY_MESSAGE)
    assert.equal(lockFailureMessage("error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def"), REPOSITORY_RECORD_MESSAGE)
    assert.equal(lockFailureMessage('error: could not lock config file .git/config: Permission denied'), REPOSITORY_RECORD_MESSAGE)
    assert.equal(lockFailureMessage('error: Your local changes to yarn.lock would be overwritten'), null)
    assert.equal(lockFailureMessage('hook blocked this'), null)
    return Promise.resolve()
  })

  scenario('one that may be in use comes before a stopped rebase: nothing is copied or aborted yet', async t => {
    const { world, a, b } = create(t)
    await stoppedRebase(a, b)
    a.write('x.md', '止まっている間に直した内容\n')
    const lock = leaveIndexLock(a, 1000)

    a.mayLeaveOperation = true
    const out = await a.sync()

    assert.equal(out.result.error, REPOSITORY_BUSY_MESSAGE)
    assert.deepEqual(a.backups(), [])
    assert.ok(stopped(a))

    a.mayLeaveOperation = false
    fs.rmSync(lock)
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
  })

  scenario('in a read-only private folder it ends in the same plain sentence', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    world.createPrivateFolder('秘密', { viewers: ['a', 'b'], editors: ['b'], files: { 's.md': '0\n' } })
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    const lock = leaveIndexLock(a, 1000, a.path('秘密'))

    const out = await a.sync()

    assert.equal(out.result.success, false)
    assert.equal(out.result.privateFolders?.find(f => f.path === '秘密')?.errorType, 'locked')
    assert.match(String(out.result.error), new RegExp(REPOSITORY_BUSY_MESSAGE))

    fs.rmSync(lock)
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
  })

  scenario('does not hold 自動で受け取る back once it is old; a young one still does', async t => {
    const { world, a, b } = create(t)
    b.write('y.md', 'b\n')
    ok(await b.sync(), 'b')

    a.mayLeaveOperation = true
    const lock = leaveIndexLock(a, 1000)
    const held = await a.autoSync('receive')
    assert.deepEqual(held, { status: 'received', result: { success: true, received: 0, heldBack: 1 } })
    assert.ok(fs.existsSync(lock))
    a.mayLeaveOperation = false

    leaveIndexLock(a, OLD)
    const answer = await a.autoSync('receive')
    assert.equal(answer.status === 'received' && answer.result.received, 1)
    assert.equal(a.readText('y.md'), 'b\n')
    await settleAndCheck(world)
  })

  scenario('a lock that appears during the sync ends in the same plain sentence', async t => {
    const { world, a } = create(t)
    a.write('y.md', 'a\n')
    a.mayLeaveOperation = true
    // Something else started git after the check before the run.
    const lock = a.path('.git/index.lock')
    a.beforeCommit = () => fs.writeFileSync(lock, '')
    const out = await a.sync()
    assert.equal(out.result.errorType, 'locked')
    assert.equal(out.result.error, REPOSITORY_BUSY_MESSAGE)

    a.beforeCommit = null
    a.mayLeaveOperation = false
    fs.rmSync(lock)
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
  })
})

describe('closing the app', { concurrency: CONCURRENCY }, () => {
  scenario('waits for the whole sync, not just the moment it was asked', async t => {
    const { a } = create(t)
    a.write('y.md', 'a\n')
    let finished = false
    const running = a.sync().then(out => { finished = true; return out })
    await a.whenIdle()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, true)
    ok(await running, 'a')
  })

  scenario('no automatic run starts while closing waits, and they go on when the member stays', async t => {
    const { world, a, b } = create(t)
    b.write('y.md', 'b\n')
    ok(await b.sync(), 'b')
    await a.whenIdle()

    assert.deepEqual(await a.autoSync('receive'), { status: 'skipped', reason: 'sync-running' })

    a.resumeAutomaticRuns()
    assert.equal((await a.autoSync('receive')).status, 'received')
    assert.equal(a.readText('y.md'), 'b\n')
    await settleAndCheck(world)
  })
})
