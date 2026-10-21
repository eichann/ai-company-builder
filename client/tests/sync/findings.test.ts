// Bugs the harness found in git:sync, each as a regression scenario.
//
// A known issue that is not fixed yet is added here skipped with its reason,
// gated on SYNC_HARNESS_KNOWN_ISSUES=1 so it can still be run on demand.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World } from '../sync-harness/world'
import { assertNoLostWork, settleAndCheck } from '../sync-harness/invariants'

describe('git:sync findings', { concurrency: 4 }, () => {
  // Found by the soak. The conflict backup read every conflicted file from
  // the member's final local commit (localHash). When a later unpushed commit
  // had renamed or deleted that file, the read failed silently: the member's
  // conflicted edit was replaced by the server version and saved nowhere,
  // while the result still said the local version was in .backups/.
  test('a conflicted edit is backed up even when a later unpushed commit renamed the file', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '開発部/notes.md': 'base\n' } })
    const [a, b] = world.members
    a.offline().write('開発部/notes.md', 'edit by a, written offline\n')
    assert.equal((await a.sync()).result.errorType, 'push_failed')
    a.rename('開発部/notes.md', 'archive/notes.md')
    assert.equal((await a.sync()).result.errorType, 'push_failed')
    b.write('開発部/notes.md', 'edit by b\n')
    assert.equal((await b.sync()).result.success, true)
    a.online()
    const out = await a.sync()
    assert.equal(out.result.success, true)
    assert.deepEqual(out.result.conflictFiles, ['開発部/notes.md'])
    const backup = path.join(String(out.result.backupPath), '開発部/notes.md')
    assert.equal(fs.readFileSync(backup, 'utf-8'), 'edit by a, written offline\n')
    assertNoLostWork(world)
    await settleAndCheck(world)
  })

  // Same root cause, second shape: the path still exists in localHash but
  // holds a *later* file (renamed away, then the name reused), so the backup
  // saved that one and the conflicted edit was lost all the same.
  test('an earlier conflicted version is backed up when the path was later reused', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '総務/規程.md': 'base\n' } })
    const [a, b] = world.members
    a.offline().write('総務/規程.md', 'first edit by a\n')
    await a.sync()
    a.rename('総務/規程.md', 'archive/規程-old.md')
    await a.sync()
    a.write('総務/規程.md', 'new file by a under the old name\n')
    await a.sync()
    b.write('総務/規程.md', 'edit by b\n')
    assert.equal((await b.sync()).result.success, true)
    a.online()
    const out = await a.sync()
    assert.equal(out.result.success, true)
    const saved = a.backups().flatMap(x => x.files.map(f => fs.readFileSync(path.join(a.dir, '.backups', x.folder, f), 'utf-8')))
    assert.ok(saved.includes('first edit by a\n'), `backups: ${JSON.stringify(saved)}`)
    assert.ok(saved.includes('new file by a under the old name\n'))
    assertNoLostWork(world)
    await settleAndCheck(world)
  })

  // Found by the soak once it could exclude shared folders (after the
  // .gitignore union fix). A member answers "exclude" for a shared folder
  // with a stray .git — the commit untracks the folder and adds it to
  // .gitignore — while a teammate edits a file in it. Replaying the pick
  // conflicts (modify/delete), sync takes the server version, and
  // `git add` refused it as ignored: the rebase was aborted, and the next
  // sync stopped at the same pick again.
  test('excluding a shared folder while a teammate edits it does not get stuck', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '営業部/提案書.md': 'v0\n' } })
    const [a, b] = world.members
    b.write('営業部/提案書.md', 'edit by b\n')
    assert.equal((await b.sync()).result.success, true)
    a.initNestedRepo('営業部').willAnswer('sharedNestedRepo', 'exclude')
    const out = await a.sync()
    assert.equal(out.result.success, true, JSON.stringify(out.result))
    // The exclusion holds within this one sync: the folder left the server.
    assert.equal(world.serverFile('営業部/提案書.md'), null)
    assert.equal(a.head(), world.serverHead())
    assert.equal(a.readText('営業部/提案書.md'), 'edit by b\n')
    assert.ok(a.isIgnored('営業部/提案書.md'))
    await settleAndCheck(world)
  })

  // Found when the harness first ran in CI (server hook). The pre-receive
  // hook's "paths differing only by case" check piped the tree through
  // `tr | sort | uniq -d` in the inherited locale. Under a UTF-8 locale whose
  // collation does not order these characters (macOS en_US.UTF-8 here), uniq
  // treated different Japanese names as equal and the push was rejected with
  // WINPATH_DETECTED. The hook now pins LC_ALL=C itself. This world runs every
  // git process — and so the hook — with LC_ALL=en_US.UTF-8, overriding the
  // harness's usual C pin, so it fails if the hook relies on its environment.
  test('Japanese file names pass the hook under a UTF-8 locale', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], locale: 'en_US.UTF-8' })
    const [a] = world.members
    a.write('営業部/見積.md', '1\n').write('営業部/提案書.md', '2\n')
    const out = await a.sync()
    assert.equal(out.result.success, true, JSON.stringify(out.result))
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), '2\n')
  })

  // Found by the soak (policy, no data loss). Lines sync itself appends to
  // .gitignore (nested-repo exclusions, large files) are committed with the
  // member's work, so when two members' syncs both changed .gitignore the
  // later one hit a conflict and "server wins" dropped its lines. The next
  // sync detected the nested repo again and asked the same question again;
  // with several members doing this at once, two rounds of syncing were not
  // enough to converge. .gitignore now merges with the union driver.
  test('concurrent .gitignore exclusions converge within two syncs each', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })
    for (const m of world.members) m.initNestedRepo(`ext-${m.name}`)
    for (const m of world.members) await m.sync()
    await settleAndCheck(world)
    const serverIgnore = world.serverFile('.gitignore')?.toString() ?? ''
    for (const m of world.members) {
      assert.equal(m.dialogHistory.length, 1, `${m.name} was asked about the same nested repo again`)
      assert.equal(serverIgnore.split('\n').filter(l => l === `/ext-${m.name}/`).length, 1, serverIgnore)
      assert.ok(m.isIgnored(`ext-${m.name}/inner.md`))
    }
  })
})
