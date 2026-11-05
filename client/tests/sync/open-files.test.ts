// Files open in Excel / Word / LibreOffice (sync-guards.md "Files open in
// another app"). Two guards:
// - the lock and temporary files those apps write next to a document
//   (`~$見積.xlsx`, `.~lock.見積.xlsx#`, `~WRL0001.tmp`) are never shared:
//   teammates saw 「〇〇が編集中」 and every save came back as a change;
// - a file a teammate changed is not replaced while an app has it open on
//   this computer (the app would later save its old copy over the
//   teammate's version): the manual sync asks (default: stop, nothing
//   changed), 「自動で送る」 waits, 「自動で受け取る」 holds back and says which file.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { timeout: 10 * 60_000 }, fn)

const SHEET = '営業部/見積.xlsx'
const LOCK = '営業部/~$見積.xlsx'
const MEMO = '営業部/メモ.md'

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

function create(t: TestContext) {
  const world = World.create(t, {
    members: [{ name: 'a' }, { name: 'b' }],
    departments: ['営業部'],
    seed: { [SHEET]: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), [MEMO]: 'メモ v1\n' },
  })
  return { world, a: world.member('a'), b: world.member('b') }
}

/** Everything a run could have changed on this computer. */
function snapshot(m: Member, files: string[]) {
  return {
    head: m.head(),
    status: m.git(['status', '--porcelain=v1', '--untracked-files=all']),
    files: files.map(f => (m.exists(f) ? m.read(f).toString('base64') : null)),
  }
}

describe('files open in another app', { concurrency: CONCURRENCY }, () => {
  scenario('office lock and temporary files are never shared, stay on disk, ignored on this computer only', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    const locks = [LOCK, '営業部/.~lock.見積.xlsx#', '営業部/~WRL0001.tmp', '~$議事録.docx']
    for (const l of locks) a.write(l, 'owner')
    a.write(MEMO, 'メモ v2\n')
    ok(await a.sync(), 'a')

    for (const l of locks) {
      assert.equal(world.serverFile(l), null, `${l} is never committed`)
      assert.equal(a.readText(l), 'owner', `${l} left alone on disk`)
      assert.ok(a.isIgnored(l), `${l} ignored on this computer`)
    }
    assert.equal(world.serverFile(MEMO)?.toString(), 'メモ v2\n')
    const exclude = fs.readFileSync(path.join(a.dir, '.git', 'info', 'exclude'), 'utf-8')
    assert.match(exclude, /# >>> ACB office lock files \(managed by the app, local only\) >>>\n~\$\*\n\.~lock\.\*#\n~WRL\*\.tmp\n~WRD\*\.tmp\n# <<< ACB office lock files <<</)
    assert.equal(world.serverFile('.gitignore')?.toString().includes('~$'), false, 'never in the shared .gitignore')

    ok(await b.sync(), 'b')
    for (const l of locks) assert.equal(b.exists(l), false)
    for (const l of locks) a.remove(l)
    await settleAndCheck(world)
  })

  scenario('a shared .gitignore that re-includes everything (!*) still never shares a new lock file', async t => {
    const { world, a } = create(t)
    ok(await a.sync(), 'a')
    a.append('.gitignore', '!*\n').write(LOCK, 'owner').write(MEMO, 'メモ v2\n')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile(LOCK), null)
    assert.equal(world.serverFile(MEMO)?.toString(), 'メモ v2\n')
    a.releaseObligationsUnder(LOCK)
    a.remove(LOCK)
    await settleAndCheck(world)
  })

  scenario('a teammate changed a file open here: the sync asks, and by default stops with nothing changed; after closing it the sync goes through', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    b.write(SHEET, Buffer.from('b の見積'))
    ok(await b.sync(), 'b')

    a.write(LOCK, 'owner').write(MEMO, 'メモ a\n')
    const before = snapshot(a, [SHEET, MEMO])
    const out = await a.sync()
    assert.equal(out.result.success, false)
    assert.equal(out.result.errorType, 'file_open')
    assert.match(out.result.error ?? '', /^同期を中止しました。/)
    assert.ok((out.result.error ?? '').includes(SHEET), 'names the file')
    assert.deepEqual(out.result.openFiles, [SHEET])
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['openFiles', 'wait']])
    assert.ok(out.dialogs[0].options.detail.includes(SHEET))
    assert.deepEqual(snapshot(a, [SHEET, MEMO]), before, 'nothing changed: not committed, not replaced')

    a.remove(LOCK) // Excel closed
    ok(await a.sync(), 'a')
    assert.equal(a.readText(SHEET), 'b の見積')
    assert.equal(world.serverFile(MEMO)?.toString(), 'メモ a\n')
    await settleAndCheck(world)
  })

  scenario('「閉じたので続ける」 (a lock file left by a crash): the server version wins, this computer\'s edit goes to .backups', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    b.write(SHEET, Buffer.from('b の見積'))
    ok(await b.sync(), 'b')
    a.write(LOCK, 'stale').write(SHEET, Buffer.from('a の見積')).willAnswer('openFiles', 'continue')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => d.kind), ['openFiles'])
    assert.equal(a.readText(SHEET), 'b の見積')
    assert.deepEqual(out.result.conflictFiles, [SHEET])
    const backup = out.result.backupPath
    assert.ok(backup, 'conflict copy written')
    assert.equal(fs.readFileSync(path.join(backup, SHEET), 'utf-8'), 'a の見積')
    assert.equal(world.serverFile(LOCK), null)
    assert.equal(a.exists(LOCK), false, 'the lock the crash left is removed, so the question does not come back')

    b.write(SHEET, Buffer.from('b の見積 2'))
    ok(await b.sync(), 'b')
    const next = ok(await a.sync(), 'a')
    assert.deepEqual(next.dialogs, [], 'not asked again for the same file')
    assert.equal(a.readText(SHEET), 'b の見積 2')
    await settleAndCheck(world)
  })

  scenario('a lock file from before this computer last started (a crash, then a restart) does not hold anything', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    b.write(SHEET, Buffer.from('b の見積'))
    ok(await b.sync(), 'b')
    a.write(LOCK, 'stale')
    const old = new Date(Date.now() - 3 * 24 * 3600_000)
    fs.utimesSync(path.join(a.dir, LOCK), old, old)
    a.bootTimeMs = Date.now() - 3600_000
    const answer = await a.autoSync('receive')
    const result = answer.status === 'received' ? answer.result : assert.fail(JSON.stringify(answer))
    assert.equal(result.received, 1)
    assert.equal(result.openFiles, undefined)
    assert.equal(a.readText(SHEET), 'b の見積')
    // The same lock written after the start (the file really open) still holds the update.
    a.bootTimeMs = old.getTime() - 3600_000
    b.write(SHEET, Buffer.from('b の見積 2'))
    ok(await b.sync(), 'b')
    const out = await a.sync()
    assert.equal(out.result.errorType, 'file_open')
    a.remove(LOCK)
    await settleAndCheck(world)
  })

  scenario('no Office / LibreOffice app running (Mac process list): a lock is a crash leftover and holds nothing', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    b.write(SHEET, Buffer.from('b の見積'))
    ok(await b.sync(), 'b')
    a.write(LOCK, 'stale')
    a.officeAppsRunning = true
    const held = await a.sync()
    assert.equal(held.result.errorType, 'file_open', 'an app running: the lock counts')
    a.officeAppsRunning = false
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [])
    assert.equal(a.readText(SHEET), 'b の見積')
    a.remove(LOCK)
    await settleAndCheck(world)
  })

  scenario('a company file open here holds back only the company repository: private folders still sync', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      departments: ['営業部', '人事'],
      seed: { [SHEET]: 'v1' },
    })
    world.createPrivateFolder('人事/評価', { viewers: ['a', 'b'], files: { '評価表.md': '評価 v1\n' } })
    const [a, b] = world.members
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    b.write(SHEET, 'v2')
    ok(await b.sync(), 'b')
    a.write(LOCK, 'owner').write('人事/評価/評価表.md', '評価 a\n')
    const out = await a.sync()
    assert.equal(out.result.errorType, 'file_open')
    const folder = out.result.privateFolders?.find(f => f.path === '人事/評価')
    assert.equal(folder?.success, true, JSON.stringify(out.result))
    assert.equal(world.scopeFile('人事/評価', '評価表.md')?.toString(), '評価 a\n')
    assert.equal(a.readText(SHEET), 'v1')
    a.remove(LOCK)
    await settleAndCheck(world)
  })

  scenario('a file open here that nobody else changed syncs as always (the member\'s saved edit is shared)', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    b.write(MEMO, 'メモ b\n')
    ok(await b.sync(), 'b')
    a.write(LOCK, 'owner').write(SHEET, Buffer.from('a の見積'))
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [])
    assert.equal(world.serverFile(SHEET)?.toString(), 'a の見積')
    assert.equal(a.readText(MEMO), 'メモ b\n')
    a.remove(LOCK)
    await settleAndCheck(world)
  })

  scenario('自動で送る waits (no question, not a stop of automatic sync) while a file a teammate changed is open', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    b.write(SHEET, Buffer.from('b の見積'))
    ok(await b.sync(), 'b')
    a.write(LOCK, 'owner').write(MEMO, 'メモ a\n')
    const before = snapshot(a, [SHEET, MEMO])
    const answer = await a.autoSync('send')
    assert.equal(answer.status, 'sent')
    const result = answer.status === 'sent' ? answer.result : assert.fail()
    assert.equal(result.success, false)
    assert.equal(result.errorType, 'file_open', 'not needs_member: the next run goes through once it is closed')
    assert.deepEqual(snapshot(a, [SHEET, MEMO]), before)

    a.remove(LOCK)
    const next = await a.autoSync('send')
    assert.equal(next.status === 'sent' && next.result.success, true, JSON.stringify(next))
    assert.equal(a.readText(SHEET), 'b の見積')
    await settleAndCheck(world)
  })

  scenario('自動で受け取る holds back while a file a teammate changed is open, names it, and receives once it is closed', async t => {
    const { world, a, b } = create(t)
    ok(await a.sync(), 'a')
    b.write(SHEET, Buffer.from('b の見積')).write(MEMO, 'メモ b\n')
    ok(await b.sync(), 'b')
    a.write(LOCK, 'owner')
    const before = snapshot(a, [SHEET, MEMO])
    const answer = await a.autoSync('receive')
    const result = answer.status === 'received' ? answer.result : assert.fail(JSON.stringify(answer))
    assert.equal(result.received, 0)
    assert.equal(result.heldBack, 1)
    assert.deepEqual(result.openFiles, [SHEET])
    assert.deepEqual(snapshot(a, [SHEET, MEMO]), before)

    a.remove(LOCK)
    const again = await a.autoSync('receive')
    const second = again.status === 'received' ? again.result : assert.fail(JSON.stringify(again))
    assert.equal(second.received, 2)
    assert.equal(second.openFiles, undefined)
    assert.equal(a.readText(SHEET), 'b の見積')
    await settleAndCheck(world)
  })

  scenario('a lock file an older app shared (tracked, unchanged) is not this computer\'s app: receive and sync go on', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      departments: ['営業部'],
      seed: { [SHEET]: 'v1', [LOCK]: 'someone else' },
    })
    const [a, b] = world.members
    ok(await a.sync(), 'a')
    b.write(SHEET, 'v2')
    ok(await b.sync(), 'b')
    const answer = await a.autoSync('receive')
    const result = answer.status === 'received' ? answer.result : assert.fail(JSON.stringify(answer))
    assert.equal(result.received, 1)
    assert.equal(a.readText(SHEET), 'v2')
    await settleAndCheck(world)
  })

  scenario('inside a private folder\'s clone too (the question names the folder\'s path)', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], departments: ['人事'] })
    world.createPrivateFolder('人事/評価', { viewers: ['a', 'b'], files: { '評価表.xlsx': 'v1' } })
    const [a, b] = world.members
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    b.write('人事/評価/評価表.xlsx', 'v2')
    ok(await b.sync(), 'b')
    a.write('人事/評価/~$評価表.xlsx', 'owner')
    const out = await a.sync()
    assert.equal(out.result.success, false)
    const folder = out.result.privateFolders?.find(f => f.path === '人事/評価')
    assert.equal(folder?.errorType, 'file_open')
    assert.ok(out.dialogs[0]?.options.detail.includes('人事/評価/評価表.xlsx'))
    assert.equal(out.dialogs[0]?.options.detail.includes('人事/評価/人事/評価'), false, 'the folder named once')
    assert.equal(a.readText('人事/評価/評価表.xlsx'), 'v1')
    assert.equal(world.scopeFile('人事/評価', '~$評価表.xlsx'), null)
    a.remove('人事/評価/~$評価表.xlsx')
    await settleAndCheck(world)
  })

  scenario('in a private folder this member may only read: the update waits too', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], departments: ['人事'] })
    world.createPrivateFolder('人事/評価', { viewers: ['a', 'b'], editors: ['b'], files: { '評価表.xlsx': 'v1' } })
    const [a, b] = world.members
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    b.write('人事/評価/評価表.xlsx', 'v2')
    ok(await b.sync(), 'b')
    a.write('人事/評価/~$評価表.xlsx', 'owner')
    const out = await a.sync()
    const folder = out.result.privateFolders?.find(f => f.path === '人事/評価')
    assert.equal(folder?.errorType, 'file_open')
    assert.deepEqual(out.dialogs.map(d => d.kind), ['openFiles'])
    assert.ok(out.dialogs[0].options.detail.includes('人事/評価/評価表.xlsx'))
    assert.equal(out.dialogs[0].options.detail.includes('人事/評価/人事/評価'), false, 'the folder named once')
    assert.equal(a.readText('人事/評価/評価表.xlsx'), 'v1')
    a.remove('人事/評価/~$評価表.xlsx')
    await settleAndCheck(world)
  })
})
