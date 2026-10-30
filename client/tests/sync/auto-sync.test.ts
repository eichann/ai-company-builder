// Automatic sync while the app is open (owner decision 2026-10-30;
// .claude/rules/sync.md "Automatic sync"). Each member runs the same
// decision main makes for `git:autoSync` (electron/sync/auto-sync.ts) on the
// real createGitSync:
// - 「自動で受け取る」 only fast-forwards: it never commits, pushes, moves or
//   overwrites anything of the member's (electron/sync/receive.ts);
// - 「自動で送る」 is the normal sync with a template message, and stops
//   (changing nothing) where a manual sync would ask;
// - a run that must wait (unsaved edits, AI working, …) changes nothing.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, privateMarker, type Member, type SyncOutcome, type AutoSyncConditions } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'
import type { AutoSyncSkipReason } from '../../shared/auto-sync'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { timeout: 10 * 60_000 }, fn)

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const DOC = '営業部/提案.md'
const OTHER = '営業部/議事録.md'

function create(t: TestContext) {
  const world = World.create(t, {
    members: [{ name: 'a' }, { name: 'b' }],
    departments: ['営業部', '開発部'],
    seed: { [DOC]: '提案 v1\n', [OTHER]: '議事録 v1\n', '開発部/設計.md': '設計 v1\n' },
  })
  return { world, a: world.member('a'), b: world.member('b') }
}

/** Everything a run could have changed on this computer: HEAD, index + worktree status, and the files. */
function snapshot(m: Member, files: string[]) {
  return {
    head: m.head(),
    status: m.git(['status', '--porcelain=v1', '--untracked-files=all']),
    files: files.map(f => (m.exists(f) ? m.readText(f) : null)),
  }
}

async function received(m: Member, conditions?: AutoSyncConditions) {
  const answer = await m.autoSync('receive', conditions)
  assert.equal(answer.status, 'received', JSON.stringify(answer))
  return answer.status === 'received' ? answer.result : assert.fail()
}

describe('automatic sync', { concurrency: CONCURRENCY }, () => {
  scenario('自動で受け取る with a clean tree brings teammates\' changes and sends nothing', async t => {
    const { world, a, b } = create(t)
    b.write(DOC, '提案 v2\n').write('開発部/新規.md', 'new\n')
    ok(await b.sync(), 'b')
    const serverBefore = world.serverHead()

    const result = await received(a)
    assert.equal(result.received, 2)
    assert.equal(result.heldBack, 0)
    assert.equal(a.readText(DOC), '提案 v2\n')
    assert.equal(a.readText('開発部/新規.md'), 'new\n')
    assert.equal(a.head(), world.serverHead(), 'a fast-forward to the server: no commit of its own')
    assert.equal(world.serverHead(), serverBefore, 'nothing was pushed')
    assert.equal(a.git(['status', '--porcelain']).trim(), '')
    await settleAndCheck(world)
  })

  scenario('自動で受け取る leaves the member\'s own edits uncommitted and unshared while other files arrive', async t => {
    const { world, a, b } = create(t)
    a.write(OTHER, '議事録 a の編集中\n').write('営業部/メモ.md', 'a の新しいメモ\n')
    b.write(DOC, '提案 v2\n')
    ok(await b.sync(), 'b')

    const result = await received(a)
    assert.equal(result.received, 1)
    assert.equal(a.readText(DOC), '提案 v2\n')
    assert.equal(a.readText(OTHER), '議事録 a の編集中\n', 'the edit is still on disk')
    assert.equal(a.readText('営業部/メモ.md'), 'a の新しいメモ\n')
    assert.equal(a.head(), world.serverHead(), 'nothing committed')
    assert.equal(world.serverFile(OTHER)?.toString(), '議事録 v1\n', 'nothing shared')
    assert.equal(world.serverFile('営業部/メモ.md'), null)
    const status = a.git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'])
    assert.match(status, / M 営業部\/議事録\.md/)
    assert.match(status, /\?\? 営業部\/メモ\.md/)
    await settleAndCheck(world)
  })

  scenario('自動で受け取る holds back when the member edited a file a teammate changed; the manual sync then backs it up', async t => {
    const { world, a, b } = create(t)
    a.write(DOC, '提案 a の版\n')
    b.write(DOC, '提案 b の版\n').write(OTHER, '議事録 v2\n')
    ok(await b.sync(), 'b')
    const before = snapshot(a, [DOC, OTHER])

    const result = await received(a)
    assert.equal(result.received, 0)
    assert.equal(result.heldBack, 1)
    assert.deepEqual(snapshot(a, [DOC, OTHER]), before, 'nothing changed: not even the file nobody else touched')

    const manual = ok(await a.sync(), 'a')
    assert.equal(manual.result.hadConflicts, true)
    await settleAndCheck(world)
  })

  scenario('自動で受け取る never overwrites a file the member keeps ignored at a path a teammate adds', async t => {
    const { a, b } = create(t)
    const NOTE = '営業部/個人メモ.md'
    fs.appendFileSync(path.join(a.dir, '.git', 'info', 'exclude'), `${NOTE}\n`)
    fs.writeFileSync(a.path(NOTE), 'a だけのメモ\n')
    b.write(NOTE, 'b の共有メモ\n').write(DOC, '提案 v2\n')
    ok(await b.sync(), 'b')
    const before = snapshot(a, [NOTE, DOC])

    const result = await received(a)
    assert.equal(result.heldBack, 1)
    assert.deepEqual(snapshot(a, [NOTE, DOC]), before, 'git would replace an ignored file silently: the receive must not run')
    assert.equal(a.readText(NOTE), 'a だけのメモ\n')
  })

  scenario('自動で受け取る holds back while the member has commits the server does not have yet', async t => {
    const { world, a, b } = create(t)
    a.write(OTHER, '議事録 a\n').failNextPush('before-server')
    assert.equal((await a.sync()).result.success, false)
    assert.ok(a.hasPendingPush())
    b.write(DOC, '提案 v2\n')
    ok(await b.sync(), 'b')
    const before = snapshot(a, [DOC, OTHER])

    const result = await received(a)
    assert.equal(result.heldBack, 1)
    assert.deepEqual(snapshot(a, [DOC, OTHER]), before)
    await settleAndCheck(world)
  })

  const waits: Array<[string, AutoSyncConditions, AutoSyncSkipReason]> = [
    ['the editor has unsaved edits', { unsavedEdits: true }, 'unsaved-edits'],
    ['an AI turn is running', { aiRunning: true }, 'ai-running'],
    ['the last sync needs the member', { needsMember: true }, 'needs-member'],
    ['the computer is offline', { offline: true }, 'offline'],
    ['download choices are being applied', { activity: 'download-choices' }, 'download-choices'],
    ['a private folder is being set up', { activity: 'private-folder-setup' }, 'private-folder-setup'],
  ]
  scenario('a run that must wait changes nothing, for receiving and for sending', async t => {
    const { world, a, b } = create(t)
    b.write(DOC, '提案 v2\n')
    ok(await b.sync(), 'b')
    a.write(OTHER, '議事録 a の編集\n')
    const serverBefore = world.serverHead()
    for (const [what, conditions, reason] of waits) {
      for (const mode of ['receive', 'send'] as const) {
        const before = snapshot(a, [DOC, OTHER])
        const answer = await a.autoSync(mode, conditions)
        assert.deepEqual(answer, { status: 'skipped', reason }, `${mode} while ${what}`)
        assert.deepEqual(snapshot(a, [DOC, OTHER]), before, `${mode} while ${what} changed this computer`)
        assert.equal(world.serverHead(), serverBefore, `${mode} while ${what} reached the server`)
      }
    }
    await settleAndCheck(world)
  })

  scenario('自動で送る is the normal sync with a template message; a conflict still backs the member\'s version up', async t => {
    const { world, a, b } = create(t)
    a.write(DOC, '提案 a の版\n').write('営業部/新規.md', 'new\n')
    b.write(DOC, '提案 b の版\n')
    ok(await b.sync(), 'b')

    const answer = await a.autoSync('send')
    assert.equal(answer.status, 'sent')
    const result = answer.status === 'sent' ? answer.result : assert.fail()
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.hadConflicts, true)
    assert.equal(world.serverFile(DOC)?.toString(), '提案 b の版\n', 'the server version wins, as in a manual sync')
    const backup = a.backups().find(bk => bk.metadata.reason === 'conflict')
    assert.ok(backup, 'the member\'s version is in .backups')
    assert.equal(fs.readFileSync(path.join(a.dir, '.backups', backup.folder, DOC), 'utf-8'), '提案 a の版\n')
    assert.equal(world.serverFile('営業部/新規.md')?.toString(), 'new\n')
    const message = world.git(world.bare, ['log', '-1', '--format=%B', 'main'])
    assert.match(message, /^自動同期：2件の変更\n\n/)
    assert.match(message, /追加: 営業部\/新規\.md/)
    assert.match(message, /変更: 営業部\/提案\.md/)
    await settleAndCheck(world)
  })

  scenario('自動で送る never answers a question for the member: a deleted file stops it with nothing changed', async t => {
    const { world, a } = create(t)
    a.remove(OTHER).write(DOC, '提案 a\n')
    const before = snapshot(a, [DOC, OTHER])
    const serverBefore = world.serverHead()

    const answer = await a.autoSync('send')
    const result = answer.status === 'sent' ? answer.result : assert.fail(JSON.stringify(answer))
    assert.equal(result.success, false)
    assert.equal(result.errorType, 'needs_member')
    assert.match(result.error ?? '', /^自動で送る途中で、確認が必要なことがありました。/)
    assert.deepEqual(a.lastDialogs(), [], 'no dialog popped up on its own')
    assert.deepEqual(snapshot(a, [DOC, OTHER]), before)
    assert.equal(world.serverHead(), serverBefore)

    // The member's own press asks, as always.
    const manual = ok(await a.sync(), 'a')
    assert.equal(manual.dialogs.length, 1)
    assert.equal(world.serverFile(OTHER), null)
    await settleAndCheck(world)
  })

  scenario('private folders: a teammate\'s change inside a readable private folder arrives, nothing private reaches the company repository', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      departments: ['人事'],
      seed: { '人事/規程.md': '規程 v1\n' },
    })
    const [a, b] = [world.member('a'), world.member('b')]
    const folder = world.createPrivateFolder('人事/評価', { viewers: ['a', 'b'], editors: ['a', 'b'], files: { '評価表.md': `${privateMarker('auto-1')}\n評価 v1\n` } })
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    b.write('人事/評価/評価表.md', `${privateMarker(folder)}\n評価 v2\n`).write('人事/規程.md', '規程 v2\n')
    ok(await b.sync(), 'b')

    const result = await received(a)
    assert.equal(result.received, 2, 'one file in the company repository, one in the private folder')
    assert.match(a.readText('人事/評価/評価表.md'), /評価 v2/)
    assert.equal(a.readText('人事/規程.md'), '規程 v2\n')
    assert.equal(a.git(['status', '--porcelain', '--untracked-files=all']).trim(), '')
    await settleAndCheck(world)
  })

  scenario('download choices: a partial member receives its departments and downloads nothing it left out', async t => {
    const world = World.create(t, {
      members: [{ name: 'b' }],
      departments: ['営業部', '開発部'],
      seed: { [DOC]: '提案 v1\n', '開発部/設計.md': '設計 v1\n' },
    })
    const b = world.member('b')
    const p = await world.addPartialMember('p', { departments: ['営業部'] })
    b.write(DOC, '提案 v2\n').write('開発部/設計.md', '設計 v2 (大きな変更)\n')
    ok(await b.sync(), 'b')

    const result = await received(p)
    assert.equal(p.readText(DOC), '提案 v2\n')
    assert.equal(result.heldBack, 0)
    assert.equal(p.exists('開発部'), false, 'the folder left out stays left out')
    const devBlob = world.serverTree().get('開発部/設計.md')
    assert.ok(devBlob && p.missingObjects().has(devBlob), 'its new content was not downloaded')
    await settleAndCheck(world)
  })
})
