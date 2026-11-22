// The harness has to fail when sync misbehaves. These tests break sync (or
// its aftermath) on purpose and check that each invariant notices.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, type SyncImplFactory } from '../sync-harness/world'
import { assertConverged, assertNoLostLocalFiles, assertNoLostWork } from '../sync-harness/invariants'

describe('sync harness self-test', { concurrency: 4 }, () => {
  test('lost work is detected when the conflict backup is missing', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    b.write('x.md', 'b\n')
    await b.sync()
    a.write('x.md', 'member a edit\n')
    const out = await a.sync()
    assert.deepEqual(out.result.conflictFiles, ['x.md'])
    assertNoLostWork(world)
    fs.rmSync(a.path('.backups'), { recursive: true, force: true })
    assert.throws(() => assertNoLostWork(world), /committed work lost[\s\S]*a: x\.md/)
  })

  test('a lost local file is detected: an ignored note sync never commits, gone without a backup', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed: { '営業部/x.md': '0\n' } })
    const [a] = world.members
    a.write('営業部/.personal/memo.md', 'only here\n').write('営業部/.env', 'TOKEN=a\n')
    await a.sync()
    assertNoLostLocalFiles(world)
    // Sync moving it to a backup keeps it; the member's own deletion releases it.
    fs.mkdirSync(a.path('.backups/t1/営業部'), { recursive: true })
    fs.renameSync(a.path('営業部/.env'), a.path('.backups/t1/営業部/.env'))
    fs.writeFileSync(a.path('.backups/t1/_metadata.json'), '{}')
    a.write('営業部/.personal/other.md', 'x\n').remove('営業部/.personal/other.md')
    assertNoLostLocalFiles(world)
    fs.rmSync(a.path('営業部/.personal/memo.md'))
    assert.throws(() => assertNoLostLocalFiles(world), /local work lost[\s\S]*a: 営業部\/\.personal\/memo\.md/)
  })

  test('lost work is detected when a sync drops a commit (the rebase --skip fallback of the original single-round code)', async t => {
    // A broken sync in the shape of the original single-round code: skip conflicting picks.
    const skipping: SyncImplFactory = deps => async repoPath => {
      const git = deps.createGit(repoPath)
      await git.raw(['add', '-A'])
      await git.commit('local work')
      try {
        await git.pull('origin', 'main', ['--rebase'])
      } catch {
        while (fs.existsSync(path.join(repoPath, '.git', 'rebase-merge'))) {
          await git.rebase(['--skip']).catch(() => {})
        }
      }
      await git.push('origin', 'main')
      return { success: true, message: 'ok', restoredFolders: [], ignoredLargeFiles: [], excludedNestedRepos: [] }
    }
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' }, impl: skipping })
    const [a, b] = world.members
    b.write('x.md', 'b\n')
    await b.sync()
    a.write('x.md', 'member a edit\n')
    await a.sync()
    assert.throws(() => assertNoLostWork(world), /committed work lost[\s\S]*a: x\.md/)
  })

  test('divergence is detected', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    await world.settle(1)
    assertConverged(world)
    b.write('local-only-edit.md', 'not synced\n')
    assert.throws(() => assertConverged(world), /b: working tree not clean/)
    a.write('x.md', 'x\n')
    await a.sync()
    assert.throws(() => assertConverged(world), /b: HEAD/)
  })

  test('a hanging sync is reported as a hang', async t => {
    const hanging: SyncImplFactory = () => () => new Promise(() => {})
    const world = World.create(t, { members: [{ name: 'a' }], impl: hanging, syncTimeoutMs: 300 })
    await assert.rejects(world.members[0].sync(), /did not finish within 300ms \(hang\)/)
  })

  test('a rebase left in progress is reported', async t => {
    const leaving: SyncImplFactory = () => async repoPath => {
      fs.mkdirSync(path.join(repoPath, '.git', 'rebase-merge'), { recursive: true })
      return { success: true, message: 'ok', restoredFolders: [], ignoredLargeFiles: [], excludedNestedRepos: [] }
    }
    const world = World.create(t, { members: [{ name: 'a' }], impl: leaving })
    await assert.rejects(world.members[0].sync(), /left \.git\/rebase-merge behind/)
  })
})
