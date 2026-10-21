// Multi-member git:sync scenarios. Each scenario maps to a row of the
// "Non-Negotiable Guards" table in CLAUDE.md (or to a documented step of the
// sync flow), runs the real extracted sync against a real bare repository
// with the production pre-receive hook, and ends by settling (everyone syncs
// twice) and checking the invariants in ../sync-harness/invariants.ts.
//
// Adding a scenario: create a World, script members (write / remove /
// rename / initNestedRepo / offline / beforeNextPush / willAnswer), call
// sync(), assert on the result, and finish with settleAndCheck(world).

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, FAKE_AWS_KEY, type Member, type SyncOutcome } from '../sync-harness/world'
import { assertConverged, assertNoLostWork, settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

function logged(outcome: SyncOutcome, text: string): boolean {
  return outcome.logs.some(l => typeof l[1] === 'string' && l[1].includes(text))
}

const PNG = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, seed, 0x00, 0x10, 0x80, seed ^ 0xff])

/** The conflict backup folder (the one with reason "conflict"). */
function conflictBackup(m: Member) {
  const b = m.backups().filter(x => x.metadata.reason === 'conflict')
  assert.ok(b.length > 0, `${m.name} has no conflict backup`)
  return b[b.length - 1]
}

describe('git:sync multi-member scenarios', { concurrency: CONCURRENCY }, () => {
  test('baseline: interleaved edits by three members converge', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], departments: ['営業部', '開発部'] })
    const [a, b, c] = world.members
    a.write('営業部/週報.md', 'a1\n')
    b.write('開発部/設計.md', 'b1\n')
    ok(await b.sync(), 'b')
    ok(await a.sync(), 'a')
    c.write('営業部/週報2.md', 'c1\n').rename('README.md', 'docs/README.md')
    ok(await c.sync(), 'c')
    a.append('営業部/週報.md', 'a2\n')
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
    assert.equal(world.serverFile('営業部/週報.md')?.toString(), 'a1\na2\n')
    assert.equal(world.serverFile('README.md'), null)
    assert.equal(world.serverFile('docs/README.md')?.toString(), 'company\n')
  })

  // Guard: conflicts are classified by stage-2 presence (classifyConflicts).
  test('modify/delete conflict (DU): the server deletion wins, the member edit is backed up', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      seed: { '営業部/提案書.md': 'v0\n', '営業部/見積.md': 'q0\n' },
    })
    const [a, b] = world.members
    b.remove('営業部/提案書.md')
    const bOut = ok(await b.sync(), 'b')
    assert.deepEqual(bOut.dialogs.map(d => d.kind), ['deletedFiles'])
    assert.equal(world.serverFile('営業部/提案書.md'), null)

    a.write('営業部/提案書.md', 'v0\nmember edit\n').write('営業部/見積.md', 'q1\n')
    const aOut = ok(await a.sync(), 'a')
    assert.equal(aOut.result.hadConflicts, true)
    assert.deepEqual(aOut.result.deletedConflictFiles, ['営業部/提案書.md'])
    assert.match(aOut.result.message ?? '', /1件はサーバー側で削除されていたため削除/)
    const backup = conflictBackup(a)
    assert.deepEqual(backup.files, ['営業部/提案書.md'])
    assert.deepEqual(backup.metadata.deletedConflictFiles, ['営業部/提案書.md'])
    assert.equal(fs.readFileSync(path.join(a.dir, '.backups', backup.folder, '営業部/提案書.md'), 'utf-8'), 'v0\nmember edit\n')
    assert.equal(a.exists('営業部/提案書.md'), false)
    assert.equal(world.serverFile('営業部/見積.md')?.toString(), 'q1\n')
    await settleAndCheck(world)
  })

  // Guard: conflict resolution is a loop, not a single round.
  test('several conflicting picks in one rebase are all resolved, no commit is dropped', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      seed: { 'f1.md': '0\n', 'f2.md': '0\n', 'f3.md': '0\n' },
    })
    const [a, b] = world.members
    a.offline()
    for (const n of [1, 2, 3]) {
      a.write(`f${n}.md`, `a${n}\n`).write(`a-only-${n}.md`, `only a ${n}\n`)
      const out = await a.sync(`a commit ${n}`)
      assert.equal(out.result.success, false)
      assert.equal(out.result.errorType, 'push_failed')
      assert.equal(a.hasPendingPush(), true)
    }
    for (const n of [1, 2, 3]) b.write(`f${n}.md`, `b${n}\n`)
    ok(await b.sync(), 'b')

    a.online()
    const out = ok(await a.sync(), 'a')
    assert.equal(out.result.hadConflicts, true)
    assert.deepEqual([...(out.result.conflictFiles ?? [])].sort(), ['f1.md', 'f2.md', 'f3.md'])
    assert.equal(a.hasPendingPush(), false)
    for (const n of [1, 2, 3]) {
      assert.equal(world.serverFile(`f${n}.md`)?.toString(), `b${n}\n`, 'server wins')
      assert.equal(world.serverFile(`a-only-${n}.md`)?.toString(), `only a ${n}\n`, 'non-conflicting work kept')
    }
    const backup = conflictBackup(a)
    assert.deepEqual(backup.files, ['f1.md', 'f2.md', 'f3.md'])
    await settleAndCheck(world)
  })

  // Guard: rebase --skip only when the pick is genuinely empty.
  test('a pick left empty by taking the server version is skipped, later picks survive', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    a.offline().write('x.md', 'A\n')
    await a.sync('only x')
    a.write('y.md', 'later work\n')
    await a.sync('y')
    b.write('x.md', 'B\n')
    ok(await b.sync(), 'b')
    a.online()
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.conflictFiles, ['x.md'])
    assert.equal(world.serverFile('x.md')?.toString(), 'B\n')
    assert.equal(world.serverFile('y.md')?.toString(), 'later work\n')
    t.diagnostic(`empty-pick path: ${logged(out, 'Pick became empty') ? 'rebase --skip' : 'git dropped the empty pick itself'}`)
    await settleAndCheck(world)
  })

  // Backups use git cat-file into a Buffer: git show would corrupt binaries.
  test('binary conflict: the local version is backed up byte for byte', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '営業部/図.png': PNG(1) } })
    const [a, b] = world.members
    b.write('営業部/図.png', PNG(2))
    ok(await b.sync(), 'b')
    a.write('営業部/図.png', PNG(3))
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.conflictFiles, ['営業部/図.png'])
    const backup = conflictBackup(a)
    assert.deepEqual(fs.readFileSync(path.join(a.dir, '.backups', backup.folder, '営業部/図.png')), PNG(3))
    assert.deepEqual(world.serverFile('営業部/図.png'), PNG(2))
    assert.deepEqual(a.read('営業部/図.png'), PNG(2))
    await settleAndCheck(world)
  })

  // Guard: nested-repo handling asks before any mutation.
  test('nested repo inside a shared folder → "remove .git and keep sharing"', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '営業部/資料/a.md': 'shared\n' } })
    const [a, b] = world.members
    a.initNestedRepo('営業部/資料', { 'new.md': 'new inside\n' })
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['sharedNestedRepo', 'keep-sharing']])
    assert.equal(a.exists('営業部/資料/.git'), false)
    assert.deepEqual(out.result.excludedNestedRepos, [])
    assert.equal(world.serverFile('営業部/資料/new.md')?.toString(), 'new inside\n')
    assert.equal(world.serverFile('営業部/資料/a.md')?.toString(), 'shared\n')
    ok(await b.sync(), 'b')
    assert.equal(b.readText('営業部/資料/new.md'), 'new inside\n')
    await settleAndCheck(world)
  })

  test('nested repo inside a shared folder → "exclude": unshared, kept on disk, no deletion warning', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '営業部/資料/a.md': 'shared\n', '営業部/他.md': 'x\n' } })
    const [a, b] = world.members
    a.initNestedRepo('営業部/資料').willAnswer('sharedNestedRepo', 'exclude')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => d.kind), ['sharedNestedRepo'], 'no deleted-files warning for the consented exclusion')
    assert.deepEqual(out.result.excludedNestedRepos, ['営業部/資料'])
    assert.equal(a.readText('営業部/資料/a.md'), 'shared\n', 'stays on disk')
    assert.equal(a.isIgnored('営業部/資料/a.md'), true)
    assert.equal(world.serverFile('営業部/資料/a.md'), null)
    assert.equal(world.serverFile('営業部/他.md')?.toString(), 'x\n')
    ok(await b.sync(), 'b')
    assert.equal(b.exists('営業部/資料/a.md'), false, 'unshared for everyone else')
    await settleAndCheck(world)
  })

  test('new nested repo (not shared yet) → cancel changes nothing, exclude keeps it local', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.initNestedRepo('tools/外部ツール').write('memo.md', 'memo\n').willAnswer('externalNestedRepo', 'cancel')
    const gitignoreBefore = a.readText('.gitignore')
    const headBefore = a.head()
    const cancelled = await a.sync()
    assert.equal(cancelled.result.success, false)
    assert.match(cancelled.result.error ?? '', /同期を中止しました（「tools\/外部ツール」は外部Gitリポジトリです）/)
    assert.equal(a.readText('.gitignore'), gitignoreBefore, 'nothing modified before consent')
    assert.equal(a.head(), headBefore)
    assert.equal(a.git(['diff', '--cached', '--name-only']).trim(), '')

    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['externalNestedRepo', 'exclude']])
    assert.deepEqual(out.result.excludedNestedRepos, ['tools/外部ツール'])
    assert.match(a.readText('.gitignore'), /\/tools\/外部ツール\//)
    assert.equal(world.serverFile('memo.md')?.toString(), 'memo\n')
    assert.equal(world.serverFile('tools/外部ツール/inner.md'), null)
    assert.ok(![...world.serverTree().keys()].some(p => p.startsWith('tools/')), 'no gitlink on the server')
    ok(await b.sync(), 'b')
    await settleAndCheck(world)
  })

  test('PERSONAL_PATH: legacy .personal/ content is untracked (kept on disk), other changes shared', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b', role: 'owner' }],
      legacySeed: { '営業部/.personal/memo.md': 'legacy\n', '営業部/.personal/.gitignore': '*\n!.gitignore\n' },
    })
    const [a, b] = world.members
    a.write('営業部/.personal/memo.md', 'legacy\nprivate edit\n').write('営業部/報告.md', 'report\n')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.untrackedPersonalFiles, ['営業部/.personal/memo.md'])
    assert.match(out.result.message ?? '', /個人用フォルダ（.personal）のファイル1件は共有できないため/)
    assert.equal(a.readText('営業部/.personal/memo.md'), 'legacy\nprivate edit\n')
    assert.equal(world.serverFile('営業部/.personal/memo.md'), null)
    assert.equal(world.serverFile('営業部/.personal/.gitignore')?.toString(), '*\n!.gitignore\n')
    assert.equal(world.serverFile('営業部/報告.md')?.toString(), 'report\n')
    // An owner gets the same treatment — .personal/ is never shared, for anyone.
    b.write('営業部/.personal/owner.md', 'x\n')
    b.git(['add', '-f', '営業部/.personal/owner.md'])
    const bOut = ok(await b.sync(), 'b')
    assert.deepEqual(bOut.result.untrackedPersonalFiles, ['営業部/.personal/owner.md'])
    await settleAndCheck(world)
  })

  // Guard: a rejected push never becomes a permanent failure.
  test('PROTECTED_CONFIG (member): cancel, then the next sync restores and succeeds; admin passes', async t => {
    const mcp = '{"mcpServers":{"playwright":{"command":"npx"}}}\n'
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'admin', role: 'admin' }],
      seed: { '.mcp.json': mcp },
    })
    const [a, admin] = world.members
    a.write('.mcp.json', '{"mcpServers":{"evil":{"command":"sh"}}}\n').write('notes.md', 'notes\n')
    a.willAnswer('protectedConfig', 'cancel')
    const rejected = await a.sync()
    assert.equal(rejected.result.success, false)
    assert.equal(rejected.result.errorType, 'protected_config')
    assert.deepEqual(rejected.result.protectedFiles, ['.mcp.json'])
    assert.equal(a.hasPendingPush(), false, 'never PENDING_PUSH for a rejection')

    const out = ok(await a.sync(), 'a') // no new edits; default answer = restore
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['protectedConfig', 'restore']])
    assert.deepEqual(out.result.restoredProtectedFiles, ['.mcp.json'])
    assert.equal(a.readText('.mcp.json'), mcp)
    assert.equal(world.serverFile('notes.md')?.toString(), 'notes\n')
    assert.equal(world.serverFile('.mcp.json')?.toString(), mcp)
    const protectedBackup = a.backups().find(x => x.metadata.reason === 'protected_config')
    assert.ok(protectedBackup)
    assert.deepEqual(protectedBackup.files, ['.mcp.json'])

    const adminMcp = '{"mcpServers":{"playwright":{"command":"npx"},"db":{"command":"psql"}}}\n'
    admin.write('.mcp.json', adminMcp)
    const adminOut = ok(await admin.sync(), 'admin')
    assert.deepEqual(adminOut.dialogs, [])
    assert.equal(world.serverFile('.mcp.json')?.toString(), adminMcp)
    await settleAndCheck(world)
    assert.equal(a.readText('.mcp.json'), adminMcp)
  })

  test('PROTECTED_CONFIG with no window: reported, not recovered; recovered once a window exists', async t => {
    const world = World.create(t, { members: [{ name: 'a' }] })
    const [a] = world.members
    a.hasWindow = false
    a.write('.claude/settings.json', '{"hooks":{}}\n').write('ok.md', 'ok\n')
    const out = await a.sync()
    assert.equal(out.result.errorType, 'protected_config')
    assert.deepEqual(out.dialogs, [])
    a.hasWindow = true
    ok(await a.sync(), 'a')
    assert.equal(a.exists('.claude/settings.json'), false)
    assert.equal(world.serverFile('ok.md')?.toString(), 'ok\n')
    await settleAndCheck(world)
  })

  test('skill with auto-run parts: member is rejected; removing the auto-run part keeps the skill (squash path)', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'admin', role: 'admin' }] })
    const [a, admin] = world.members
    const withHooks = '---\nname: deploy\nhooks:\n  PreToolUse: []\n---\n# Deploy\n'
    const clean = '---\nname: deploy\n---\n# Deploy\n'
    a.write('.claude/skills/deploy/SKILL.md', withHooks).willAnswer('protectedConfig', 'cancel')
    const rejected = await a.sync()
    assert.equal(rejected.result.errorType, 'protected_config')
    assert.deepEqual(rejected.result.protectedFiles, ['.claude/skills/deploy/SKILL.md'])

    a.write('.claude/skills/deploy/SKILL.md', clean)
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.restoredProtectedFiles, [], 'final version kept as is')
    assert.equal(world.serverFile('.claude/skills/deploy/SKILL.md')?.toString(), clean)

    // A brand-new skill with auto-run parts and the restore answer: removed locally, backed up.
    a.write('.claude/skills/run/SKILL.md', '# Run\n\n!`date`\n')
    const restored = ok(await a.sync(), 'a')
    assert.deepEqual(restored.result.restoredProtectedFiles, ['.claude/skills/run/SKILL.md'])
    assert.equal(a.exists('.claude/skills/run/SKILL.md'), false)

    admin.write('.claude/skills/run/SKILL.md', '# Run\n\n!`date`\n')
    ok(await admin.sync(), 'admin')
    assert.ok(world.serverFile('.claude/skills/run/SKILL.md'))
    await settleAndCheck(world)
  })

  // Failure handling: PENDING_PUSH is retried first by the next sync.
  test('push failure while offline writes PENDING_PUSH; the next online sync pushes it', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.offline().write('offline.md', 'written offline\n')
    const failed = await a.sync()
    assert.equal(failed.result.errorType, 'push_failed')
    assert.equal(a.hasPendingPush(), true)
    a.online()
    const out = ok(await a.sync(), 'a')
    assert.ok(logged(out, 'Pending push succeeded'))
    assert.equal(a.hasPendingPush(), false)
    assert.equal(world.serverFile('offline.md')?.toString(), 'written offline\n')
    ok(await b.sync(), 'b')
    await settleAndCheck(world)
  })

  test('a teammate pushes between pull and push: push_failed, then the next sync succeeds', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'shared.md': '0\n' } })
    const [a, b] = world.members
    a.write('a.md', 'a\n').write('shared.md', 'from a\n')
    a.beforeNextPush(async () => {
      b.write('b.md', 'b\n').write('shared.md', 'from b\n')
      ok(await b.sync(), 'b')
    })
    const raced = await a.sync()
    assert.equal(raced.result.success, false)
    assert.equal(raced.result.errorType, 'push_failed')
    assert.equal(a.hasPendingPush(), true)
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.conflictFiles, ['shared.md'])
    assert.equal(world.serverFile('a.md')?.toString(), 'a\n')
    await settleAndCheck(world)
  })

  // Guard: rebase detection uses rebase-merge / rebase-apply, stale state is recovered.
  test('stale rebase and stale merge left by a crash are recovered', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    b.write('x.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('x.md', 'a\n')
    a.git(['commit', '-qam', 'local work'])
    a.git(['fetch', '-q', 'origin'])
    assert.throws(() => a.git(['rebase', 'origin/main']))
    assert.ok(fs.existsSync(path.join(a.dir, '.git', 'rebase-merge')) || fs.existsSync(path.join(a.dir, '.git', 'rebase-apply')))
    const out = ok(await a.sync(), 'a')
    assert.ok(logged(out, 'Detected stale rebase'))
    assert.deepEqual(out.result.conflictFiles, ['x.md'])

    b.write('x.md', 'b2\n')
    ok(await b.sync(), 'b')
    a.write('x.md', 'a2\n')
    a.git(['commit', '-qam', 'local work 2'])
    a.git(['fetch', '-q', 'origin'])
    assert.throws(() => a.git(['merge', 'origin/main']))
    assert.ok(fs.existsSync(path.join(a.dir, '.git', 'MERGE_HEAD')))
    const merged = ok(await a.sync(), 'a')
    assert.ok(logged(merged, 'Detected stale MERGE_HEAD'))
    await settleAndCheck(world)
  })

  test('Japanese paths: conflicts, a server-side folder rename, and deletions', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      departments: ['経理部'],
      seed: { '経理部/請求書/２０２６年１月.md': '0\n', '経理部/規程.md': '規程\n', '総務部/名簿.md': '名簿\n' },
    })
    const [a, b, c] = world.members
    b.rename('総務部', '人事総務部')
    b.write('経理部/請求書/２０２６年１月.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('経理部/請求書/２０２６年１月.md', 'a\n').write('総務部/名簿.md', '名簿\n追加\n')
    const out = ok(await a.sync(), 'a')
    assert.ok(out.result.conflictFiles?.includes('経理部/請求書/２０２６年１月.md'))
    c.remove('経理部/規程.md')
    ok(await c.sync(), 'c')
    await settleAndCheck(world)
    assert.equal(world.serverFile('経理部/規程.md'), null)
    assert.ok(world.serverFile('人事総務部/名簿.md'))
  })

  // Guard: syncLocks registers the run before awaiting the previous one.
  test('concurrent sync clicks are serialized; simultaneous members both get through', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.write('a1.md', '1\n')
    const clicks = await Promise.all([a.sync(), a.sync(), a.sync()])
    for (const c of clicks) ok(c, 'a')
    assert.ok(logged(clicks[0], 'Already syncing'))
    assert.equal(world.serverFile('a1.md')?.toString(), '1\n')

    a.write('a2.md', '2\n')
    b.write('b2.md', '2\n')
    const both = await Promise.all([a.sync(), b.sync()])
    for (const [m, o] of [[a, both[0]], [b, both[1]]] as const) {
      if (!o.result.success) {
        assert.equal(o.result.errorType, 'push_failed', `${m.name}: ${JSON.stringify(o.result)}`)
      }
    }
    await settleAndCheck(world)
  })

  test('secret detected: rejected, then removing the secret lets the next sync through', async t => {
    const world = World.create(t, { members: [{ name: 'a' }] })
    const [a] = world.members
    a.write('config/aws.md', `key: ${FAKE_AWS_KEY}\n`)
    const rejected = await a.sync()
    assert.equal(rejected.result.secretDetected, true)
    a.write('config/aws.md', 'key: (see the vault)\n')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('config/aws.md')?.toString(), 'key: (see the vault)\n')
    // The rejected version stays only in the member's local history.
    a.obligations.delete('config/aws.md')
    await settleAndCheck(world)
  })

  test('deleted files: restore, cancel and sync-deletions; department folders are protected', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      departments: ['営業部'],
      seed: { 'one.md': '1\n', 'two.md': '2\n', '営業部/顧客.md': 'c\n' },
    })
    const [a] = world.members
    a.remove('one.md').willAnswer('deletedFiles', 'cancel')
    const cancelled = await a.sync()
    assert.equal(cancelled.result.error, '同期がキャンセルされました')
    a.willAnswer('deletedFiles', 'restore')
    ok(await a.sync(), 'a')
    assert.equal(a.readText('one.md'), '1\n')
    a.remove('two.md')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('two.md'), null)

    a.remove('営業部')
    const restored = ok(await a.sync(), 'a')
    assert.deepEqual(restored.result.restoredFolders, ['営業部'])
    assert.equal(a.readText('営業部/顧客.md'), 'c\n')
    assert.equal(world.serverFile('営業部/顧客.md')?.toString(), 'c\n')
    await settleAndCheck(world)
  })

  test('first sync on a repository without .gitignore essentials converges for everyone', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], gitignore: null })
    const [a, b, c] = world.members
    a.write('a.md', 'a\n')
    b.write('b.md', 'b\n')
    c.write('.env', 'SECRET=1\n')
    ok(await a.sync(), 'a')
    ok(await b.sync(), 'b')
    ok(await c.sync(), 'c')
    await settleAndCheck(world)
    assert.equal(world.serverFile('.env'), null)
    assertConverged(world)
    assertNoLostWork(world)
  })
})
