// Multi-member git:sync scenarios. Each scenario maps to a row of the
// guards in .claude/rules/sync-guards.md (or to a documented step of the
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
import { World, FAKE_AWS_KEY, ESSENTIAL_GITIGNORE, type Member, type SyncOutcome } from '../sync-harness/world'
import { readNestedRepoExcludes } from '../../electron/sync/nested-repos'
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

  // A conflict backup's own _metadata.json must not replace the member's file of that name.
  test('a member\'s own top-level _metadata.json survives a conflict backup (latest and earlier versions)', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '_metadata.json': '{"v":0}\n', '_metadata (member).json': 'v0\n' } })
    const [a, b] = world.members
    a.offline().write('_metadata.json', '{"mine":1}\n')
    await a.sync('first')
    a.write('_metadata.json', '{"mine":2}\n').write('_metadata (member).json', 'mine too\n')
    await a.sync('second')
    b.write('_metadata.json', '{"theirs":true}\n').write('_metadata (member).json', 'theirs too\n')
    ok(await b.sync(), 'b')
    a.online()
    const out = ok(await a.sync(), 'a')
    assert.deepEqual([...(out.result.conflictFiles ?? [])].sort(), ['_metadata (member).json', '_metadata.json'])
    const conflicts = a.backups().filter(b => b.metadata.reason === 'conflict')
    const read = (folder: string, f: string) => fs.readFileSync(path.join(a.dir, '.backups', folder, f), 'utf-8')
    const latest = conflicts.find(c => !c.metadata.note)!
    assert.equal(read(latest.folder, '_metadata (member).json'), '{"mine":2}\n')
    // The member's own file of the copy's name gets a name of its own: neither replaces the other.
    assert.equal(read(latest.folder, '_metadata (member) (member).json'), 'mine too\n')
    // …recorded, so the list and 復元 use the member's names (nothing guessed from file names).
    assert.deepEqual(latest.metadata.copies, { '_metadata.json': '_metadata (member).json', '_metadata (member).json': '_metadata (member) (member).json' })
    assert.deepEqual([...(latest.metadata.conflictFiles as string[])].sort(), ['_metadata (member).json', '_metadata.json'], 'the backup keeps its own metadata')
    const earlier = conflicts.find(c => c.metadata.note)!
    assert.equal(read(earlier.folder, '_metadata (member).json'), '{"mine":1}\n')
    assert.equal(world.serverFile('_metadata.json')?.toString(), '{"theirs":true}\n')
    await settleAndCheck(world)
  })

  // Guard: nested-repo handling asks before any mutation; "don't share" (the
  // default) is the member's own choice, in .git/info/exclude — never the
  // shared .gitignore (owner decision 2026-10-24).
  test('nested repo inside a shared folder → "remove .git and share" (not the default)', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '営業部/資料/a.md': 'shared\n' } })
    const [a, b] = world.members
    a.initNestedRepo('営業部/資料', { 'new.md': 'new inside\n' }).willAnswer('sharedNestedRepo', 'keep-sharing')
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

  test('nested repo inside a shared folder → default keeps the .git, shares nothing new, removes nothing for anyone', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '営業部/資料/a.md': 'shared\n', '営業部/他.md': 'x\n' } })
    const [a, b] = world.members
    const gitignoreBefore = world.serverFile('.gitignore')?.toString()
    a.initNestedRepo('営業部/資料', { 'secret-notes.md': 'from the clone\n' })
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['sharedNestedRepo', 'exclude']], 'default answer; no deleted-files warning')
    const [question] = out.dialogs
    assert.equal(question.options.defaultId, 0)
    assert.match(question.options.buttons[0], /共有しない（おすすめ）/)
    assert.match(question.options.detail, /管理者に『外部リポジトリ』として登録してもらってください/)
    assert.deepEqual(out.result.excludedNestedRepos, ['営業部/資料'])
    assert.ok(a.exists('営業部/資料/.git'), 'the member\'s repository is left as it is')
    assert.deepEqual(readNestedRepoExcludes(a.dir), ['営業部/資料'])
    assert.equal(world.serverFile('.gitignore')?.toString(), gitignoreBefore, 'the shared .gitignore is not touched')
    assert.equal(world.serverFile('営業部/資料/secret-notes.md'), null, 'new files there are not shared')
    assert.equal(a.isIgnored('営業部/資料/secret-notes.md'), true)
    assert.equal(world.serverFile('営業部/資料/a.md')?.toString(), 'shared\n', 'already shared files stay shared')
    ok(await b.sync(), 'b')
    assert.equal(b.readText('営業部/資料/a.md'), 'shared\n', 'nothing disappears for teammates')
    // Edits to the files the company already shares keep syncing both ways.
    a.write('営業部/資料/a.md', 'edited by a\n')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('営業部/資料/a.md')?.toString(), 'edited by a\n')
    b.write('営業部/資料/b.md', 'new by b\n')
    ok(await b.sync(), 'b')
    const again = ok(await a.sync(), 'a')
    assert.deepEqual(again.dialogs, [], 'not asked again')
    assert.equal(a.readText('営業部/資料/b.md'), 'new by b\n')
    await settleAndCheck(world)
  })

  test('new nested repo (not shared yet) → cancel changes nothing; the default keeps it on this computer only', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.initNestedRepo('tools/外部ツール').write('memo.md', 'memo\n').willAnswer('externalNestedRepo', 'cancel')
    const gitignoreBefore = a.readText('.gitignore')
    const excludeFile = path.join(a.dir, '.git', 'info', 'exclude')
    const excludeBefore = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : null
    const headBefore = a.head()
    const cancelled = await a.sync()
    assert.equal(cancelled.result.success, false)
    assert.equal(cancelled.result.error, '同期を中止しました（「tools/外部ツール」は、このアプリとは別に管理されているフォルダです。共有せずにこのPCだけに置くこともできます。「サーバーと同期」を押すと選べます）')
    assert.equal(a.readText('.gitignore'), gitignoreBefore, 'nothing modified before consent')
    assert.equal(fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : null, excludeBefore)
    assert.equal(a.head(), headBefore)
    assert.equal(a.git(['diff', '--cached', '--name-only']).trim(), '')

    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['externalNestedRepo', 'exclude']])
    assert.match(out.dialogs[0].options.detail, /管理者に『外部リポジトリ』として登録してもらってください/)
    assert.deepEqual(out.result.excludedNestedRepos, ['tools/外部ツール'])
    assert.equal(a.readText('.gitignore'), gitignoreBefore, 'the name never reaches the shared .gitignore')
    assert.deepEqual(readNestedRepoExcludes(a.dir), ['tools/外部ツール'])
    assert.equal(a.isIgnored('tools/外部ツール/inner.md'), true)
    assert.equal(world.serverFile('memo.md')?.toString(), 'memo\n')
    assert.equal(world.serverFile('tools/外部ツール/inner.md'), null)
    assert.ok(![...world.serverTree().keys()].some(p => p.startsWith('tools/')), 'no gitlink on the server')
    assert.doesNotMatch(world.git(world.bare, ['log', '--all', '--format=%B']), /外部ツール/, 'no commit names it')
    ok(await b.sync(), 'b')
    await settleAndCheck(world)
  })

  test('a folder one member keeps local still syncs for a teammate at the same path; the member\'s own versions are backed up first', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.initNestedRepo('tools/外部ツール', { 'README.md': 'a\'s clone\n', 'only-a.md': 'a only\n' })
    ok(await a.sync(), 'a')
    // b has a folder of the same name (not a repository) and shares it.
    b.write('tools/外部ツール/README.md', 'b\'s notes\n').write('tools/外部ツール/手順.md', 'b steps\n')
    const bOut = ok(await b.sync(), 'b')
    assert.deepEqual(bOut.dialogs, [])
    assert.equal(world.serverFile('tools/外部ツール/README.md')?.toString(), 'b\'s notes\n', 'a\'s choice does not apply to b')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [], 'not asked again')
    assert.deepEqual(out.result.nestedRepoBackupFiles, ['tools/外部ツール/README.md'])
    assert.match(out.result.message ?? '', /共有していないフォルダ（tools\/外部ツール）に、ほかのメンバーが同じ名前のファイルを共有したため、このPCにあった版を \.backups に保存しました（1件）/)
    const [backup] = a.backups().filter(x => x.metadata.reason === 'nested_repo_overwrite')
    assert.ok(backup, 'backup with metadata')
    assert.equal(fs.readFileSync(path.join(a.dir, '.backups', backup.folder, 'tools/外部ツール/README.md'), 'utf-8'), 'a\'s clone\n')
    assert.equal(a.readText('tools/外部ツール/README.md'), 'b\'s notes\n')
    assert.equal(a.readText('tools/外部ツール/手順.md'), 'b steps\n')
    assert.equal(a.readText('tools/外部ツール/only-a.md'), 'a only\n')
    assert.ok(a.exists('tools/外部ツール/.git'))
    assert.equal(world.serverFile('tools/外部ツール/only-a.md'), null)
    // b's files stay shared: a's next syncs untrack nothing.
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('tools/外部ツール/手順.md')?.toString(), 'b steps\n')
    await settleAndCheck(world)
    assert.equal(world.serverFile('tools/外部ツール/README.md')?.toString(), 'b\'s notes\n')
  })

  test('a nested-repo line an older app wrote into the shared .gitignore is left alone and still honoured', async t => {
    const legacy = `${ESSENTIAL_GITIGNORE}\n# Auto-ignored: nested Git repositories (managed independently)\n/old-tool/\n`
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], gitignore: legacy })
    const [a, b] = world.members
    a.initNestedRepo('old-tool').initNestedRepo('new-tool')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['externalNestedRepo', 'exclude']], 'asked about the new one only')
    assert.deepEqual(out.result.excludedNestedRepos, ['new-tool'])
    assert.deepEqual(readNestedRepoExcludes(a.dir), ['new-tool'])
    assert.equal(world.serverFile('.gitignore')?.toString(), legacy, 'the legacy line stays, nothing is added')
    assert.equal(a.isIgnored('old-tool/inner.md'), true)
    assert.equal(world.serverFile('old-tool/inner.md'), null)
    ok(await b.sync(), 'b')
    await settleAndCheck(world)
    assert.equal(world.serverFile('.gitignore')?.toString(), legacy)
  })

  test('no window: a new nested repo is kept on this computer only, silently', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'shared/x.md': 'x\n' } })
    const [a] = world.members
    a.hasWindow = false
    a.initNestedRepo('ext').initNestedRepo('shared', { 'y.md': 'y\n' })
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [])
    assert.deepEqual(out.result.excludedNestedRepos, ['ext', 'shared'])
    assert.deepEqual(readNestedRepoExcludes(a.dir), ['ext', 'shared'])
    assert.equal(world.serverFile('shared/x.md')?.toString(), 'x\n', 'a shared folder is never removed for everyone')
    assert.equal(world.serverFile('shared/y.md'), null)
    assert.ok(a.exists('shared/.git'))
    a.hasWindow = true
    await settleAndCheck(world)
  })

  test('deleting the nested repository drops its local exclusion; a teammate\'s folder there then syncs normally', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.initNestedRepo('ext')
    ok(await a.sync(), 'a')
    assert.deepEqual(readNestedRepoExcludes(a.dir), ['ext'])
    a.remove('ext')
    ok(await a.sync(), 'a')
    assert.deepEqual(readNestedRepoExcludes(a.dir), [])
    a.write('ext/note.md', 'now a normal folder\n')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('ext/note.md')?.toString(), 'now a normal folder\n')
    ok(await b.sync(), 'b')
    await settleAndCheck(world)
  })

  // Guard (2026-11-22 incident): a nested repository inside a folder git
  // ignores is never asked about — nothing there is shared, and 自動で送る
  // stopped at the question.
  test('a nested repository inside an ignored folder → sync goes through without asking, nothing shared (also 自動で送る)', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      departments: ['コンテンツ'],
      legacySeed: { 'コンテンツ/.personal/.gitignore': '# Personal workspace — not synced\n*\n!.gitignore\n' },
    })
    const [a, b] = world.members
    const repo = 'コンテンツ/.personal/inbox/日付別/2026/20261121/署名の試作/work/pkgrepo'
    a.initNestedRepo(repo, { 'package.json': '{"name":"pkg"}\n' }).write('コンテンツ/共有メモ.md', 'shared\n')
    const answer = await a.autoSync('send')
    const result = answer.status === 'sent' ? answer.result : assert.fail(JSON.stringify(answer))
    assert.equal(result.success, true, JSON.stringify(result))
    assert.deepEqual(a.lastDialogs(), [], 'nothing asked')
    assert.deepEqual(result.excludedNestedRepos ?? [], [])
    assert.deepEqual(readNestedRepoExcludes(a.dir), [], 'no exclusion written: git already ignores it')
    assert.equal(world.serverFile('コンテンツ/共有メモ.md')?.toString(), 'shared\n')
    assert.ok(![...world.serverTree().keys()].some(p => p.includes('pkgrepo') || p.includes('/inbox/')), 'nothing of the folder reaches the server')
    assert.ok(a.exists(`${repo}/.git`), 'the member\'s repository is left as it is')

    // Negations are git's to decide: a re-included folder is still asked about.
    a.write('.gitignore', `${a.readText('.gitignore')}\nscratch/*\n!scratch/keep/\n`)
    a.initNestedRepo('scratch/other/repo').initNestedRepo('scratch/keep/repo')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['externalNestedRepo', 'exclude']], 'asked about the re-included one only')
    assert.match(out.dialogs[0].options.message, /scratch\/keep\/repo/)
    assert.deepEqual(out.result.excludedNestedRepos, ['scratch/keep/repo'])
    assert.ok(![...world.serverTree().keys()].some(p => p.startsWith('scratch/')))
    ok(await b.sync(), 'b')
    await settleAndCheck(world)
  })

  test('a nested repository in a folder ignored only on this computer is still asked about; a teammate sharing that path cannot overwrite it unseen', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    fs.mkdirSync(path.join(a.dir, '.git', 'info'), { recursive: true })
    fs.appendFileSync(path.join(a.dir, '.git', 'info', 'exclude'), '\nmine/\n')
    a.initNestedRepo('mine/tool', { 'README.md': 'a\'s clone\n' })
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['externalNestedRepo', 'exclude']], 'b has no such rule, so a is asked')
    b.write('mine/tool/README.md', 'b\'s notes\n')
    ok(await b.sync(), 'b')
    const again = ok(await a.sync(), 'a')
    assert.deepEqual(again.result.nestedRepoBackupFiles, ['mine/tool/README.md'])
    const [backup] = a.backups().filter(x => x.metadata.reason === 'nested_repo_overwrite')
    assert.equal(fs.readFileSync(path.join(a.dir, '.backups', backup.folder, 'mine/tool/README.md'), 'utf-8'), 'a\'s clone\n')
    await settleAndCheck(world)
  })

  test('an ignore line newer here than on the server: the clone is not asked about, and what a teammate already shared there does not overwrite it unseen', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    b.write('scratch/tool/README.md', 'b\'s notes\n')
    ok(await b.sync(), 'b')
    // a has not pulled yet: ignores scratch/ and clones a tool there.
    a.write('.gitignore', `${a.readText('.gitignore')}\nscratch/\n`)
    a.initNestedRepo('scratch/tool', { 'README.md': 'a\'s clone\n' })
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [], 'a tracked .gitignore ignores it: not asked')
    assert.deepEqual(out.result.nestedRepoBackupFiles, ['scratch/tool/README.md'])
    const [backup] = a.backups().filter(x => x.metadata.reason === 'nested_repo_overwrite')
    assert.equal(fs.readFileSync(path.join(a.dir, '.backups', backup.folder, 'scratch/tool/README.md'), 'utf-8'), 'a\'s clone\n')
    assert.equal(world.serverFile('scratch/tool/README.md')?.toString(), 'b\'s notes\n')
    await settleAndCheck(world)
  })

  test('the check before the pull fails: sync stops before the pull with one plain sentence (git\'s words only in the log), the work stays', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], gitignore: `${ESSENTIAL_GITIGNORE}\nscratch/\n` })
    const [a] = world.members
    a.write('scratch/notes.md', 'mine\n').write('memo.md', 'to share\n')
    a.failNextRaw(args => args.includes('ls-tree') && args.includes('--literal-pathspecs'), 'fatal: unable to read tree 0123abcd')
    const out = await a.sync()
    assert.equal(out.result.success, false)
    assert.equal(out.result.error, '共有していないフォルダのファイルを確認できなかったため、同期を中止しました。変更はこのPCに保存されています。もう一度同期しても直らないときは、管理者に連絡してください。')
    assert.ok(logged(out, 'Could not back up files of excluded nested repositories'))
    assert.equal(world.serverFile('memo.md'), null, 'nothing pushed before the check')
    assert.equal(a.readText('scratch/notes.md'), 'mine\n')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('memo.md')?.toString(), 'to share\n')
    await settleAndCheck(world)
  })

  test('a nested repository inside an ignored folder but holding shared files → still asked; cancelling changes nothing', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }, { name: 'b' }],
      gitignore: `${ESSENTIAL_GITIGNORE}\nscratch/\n`,
      legacySeed: { 'scratch/notes/a.md': 'shared despite the ignore line\n' },
    })
    const [a, b] = world.members
    a.initNestedRepo('scratch/notes', { 'clone.md': 'from a clone\n' }).willAnswer('sharedNestedRepo', 'cancel')
    const headBefore = a.head()
    const cancelled = await a.sync()
    assert.equal(cancelled.result.success, false)
    assert.deepEqual(cancelled.dialogs.map(d => d.kind), ['sharedNestedRepo'])
    assert.equal(cancelled.result.error, '同期を中止しました（共有中のフォルダ「scratch/notes」に、このアプリとは別に管理するための情報が入っています。このPCで増えたファイルだけ共有しないこともできます。「サーバーと同期」を押すと選べます）')
    assert.equal(a.head(), headBefore)
    assert.deepEqual(readNestedRepoExcludes(a.dir), [])
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['sharedNestedRepo', 'exclude']])
    assert.equal(world.serverFile('scratch/notes/a.md')?.toString(), 'shared despite the ignore line\n')
    assert.equal(world.serverFile('scratch/notes/clone.md'), null)
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

  // Codex's project layer (.codex/) is protected like .claude/settings.json:
  // current apps recover through the same dialog, nothing new on the client.
  test('PROTECTED_CONFIG for Codex project config (.codex/config.toml): member restored, admin passes', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'admin', role: 'admin' }] })
    const [a, admin] = world.members
    a.write('.codex/config.toml', 'sandbox_mode = "danger-full-access"\n').write('営業部/.codex/hooks.json', '{}\n').write('memo.md', 'memo\n')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['protectedConfig', 'restore']])
    assert.deepEqual([...(out.result.restoredProtectedFiles ?? [])].sort(), ['.codex/config.toml', '営業部/.codex/hooks.json'])
    assert.equal(a.exists('.codex/config.toml'), false)
    assert.equal(world.serverFile('.codex/config.toml'), null)
    assert.equal(world.serverFile('memo.md')?.toString(), 'memo\n')

    admin.write('.codex/config.toml', 'model = "gpt-5"\n')
    const adminOut = ok(await admin.sync(), 'admin')
    assert.deepEqual(adminOut.dialogs, [])
    assert.equal(world.serverFile('.codex/config.toml')?.toString(), 'model = "gpt-5"\n')
    await settleAndCheck(world)
  })

  test('skill with auto-run parts: someone on the list is rejected; removing the auto-run part keeps the skill (squash path)', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'admin', role: 'admin' }] })
    const [a, admin] = world.members
    world.setSkillEditing('a', { everywhere: true, folders: [] })
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

  // Failure handling: a push that throws after the server accepted it (the
  // watchdog killed it while the server was still checking, or the connection
  // died after the pack arrived) is a successful push, not PENDING_PUSH.
  test('push accepted by the server but the push call fails: reported as synced, no PENDING_PUSH', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.write('landed.md', 'reached the server\n').failNextPush('after-server')
    const out = ok(await a.sync(), 'a')
    assert.equal(out.result.message, '同期が完了しました')
    assert.equal(out.result.pushFailed, undefined)
    assert.doesNotMatch(String(out.result.message), /失敗/)
    assert.equal(a.hasPendingPush(), false)
    assert.ok(out.logs.some(l => l[0] === 'warn' && String(l[1]).includes('already has every local commit')))
    assert.equal(world.serverFile('landed.md')?.toString(), 'reached the server\n')
    assert.equal(a.head(), world.serverHead())
    ok(await b.sync(), 'b')
    assert.equal(b.readText('landed.md'), 'reached the server\n')
    await settleAndCheck(world)
  })

  test('push that never reached the server still writes PENDING_PUSH; the retry counts even if its call fails after landing', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    // Both the main push and the master fallback fail before the server.
    a.write('late.md', 'not on the server yet\n').failNextPush('before-server', { times: 2 })
    const failed = await a.sync()
    assert.equal(failed.result.success, false)
    assert.equal(failed.result.errorType, 'push_failed')
    assert.equal(a.hasPendingPush(), true)
    assert.equal(world.serverFile('late.md'), null)
    assert.deepEqual(world.serverBranches(), ['refs/heads/main'])

    // The PENDING_PUSH retry at the start of the next sync lands on the
    // server but its call fails: still a success, marker cleared.
    a.failNextPush('after-server')
    const out = ok(await a.sync(), 'a')
    assert.ok(logged(out, 'Pending push succeeded'))
    assert.doesNotMatch(String(out.result.message), /失敗/)
    assert.equal(a.hasPendingPush(), false)
    assert.equal(world.serverFile('late.md')?.toString(), 'not on the server yet\n')
    ok(await b.sync(), 'b')
    await settleAndCheck(world)
  })

  test('a re-push after a PROTECTED_CONFIG restore that lands but fails counts as pushed', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a] = world.members
    const mcp = '{"mcpServers":{"x":{"command":"evil"}}}\n'
    a.write('notes.md', 'notes\n').write('.mcp.json', mcp)
    // Push 1 is rejected (PROTECTED_CONFIG); the push after restoring lands
    // on the server, then its call fails.
    a.failNextPush('after-server', { skip: 1 })
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['protectedConfig', 'restore']])
    assert.deepEqual(out.result.restoredProtectedFiles, ['.mcp.json'])
    assert.equal(a.hasPendingPush(), false)
    assert.equal(world.serverFile('notes.md')?.toString(), 'notes\n')
    assert.equal(world.serverFile('.mcp.json'), null)
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

  // The server scans every commit of a push for secrets, not only the net
  // diff: a removed secret still blocks the push through the commit that
  // added it, so sync squashes the unpushed commits and pushes once more.
  const serverHasSecret = (world: World) => world.serverTexts().some(t => t.includes(FAKE_AWS_KEY))

  test('secret detected: rejected (no PENDING_PUSH), then removing it lets the next sync through — the secret never reaches the server', async t => {
    const world = World.create(t, { members: [{ name: 'a' }] })
    const [a] = world.members
    a.write('config/aws.md', `key: ${FAKE_AWS_KEY}\n`).write('notes.md', 'kept\n')
    const rejected = await a.sync()
    assert.equal(rejected.result.secretDetected, true)
    assert.match(rejected.result.error ?? '', /config\/aws\.md \(AWS Access Key ID\)/)
    assert.equal(a.hasPendingPush(), false, 'never PENDING_PUSH for a secret rejection')
    // Pressing sync again without removing it: the same clear failure, nothing pushed.
    const again = await a.sync()
    assert.equal(again.result.secretDetected, true)
    assert.equal(serverHasSecret(world), false)

    a.write('config/aws.md', 'key: (see the vault)\n')
    const out = ok(await a.sync(), 'a')
    assert.match(out.result.message ?? '', /シークレットは共有されていません/)
    assert.equal(world.serverFile('config/aws.md')?.toString(), 'key: (see the vault)\n')
    assert.equal(world.serverFile('notes.md')?.toString(), 'kept\n')
    assert.equal(serverHasSecret(world), false, 'the commit that added the secret was pushed')
    await settleAndCheck(world)
    assert.equal(serverHasSecret(world), false)
  })

  test('secret added and removed again before the push: the commits are squashed, the secret never reaches the server', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    // Committed while offline (PENDING_PUSH), removed before the next sync.
    a.offline().write('config/aws.md', `key: ${FAKE_AWS_KEY}\n`).write('x.md', 'a\n')
    assert.equal((await a.sync()).result.errorType, 'push_failed')
    a.write('config/aws.md', 'key: (see the vault)\n')
    b.write('b.md', 'b\n')
    ok(await b.sync(), 'b')
    a.online()
    ok(await a.sync(), 'a')
    assert.equal(a.hasPendingPush(), false)
    assert.equal(world.serverFile('config/aws.md')?.toString(), 'key: (see the vault)\n')
    assert.equal(world.serverFile('x.md')?.toString(), 'a\n')
    assert.equal(serverHasSecret(world), false)
    await settleAndCheck(world)
    assert.equal(serverHasSecret(world), false)
  })

  test('secret removed again, and a teammate pushes right before the squashed push: retried by the next sync', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    a.offline().write('config/aws.md', `key: ${FAKE_AWS_KEY}\n`)
    assert.equal((await a.sync()).result.errorType, 'push_failed')
    a.write('config/aws.md', 'key: (see the vault)\n').write('a.md', 'a\n')
    a.online()
    // Pushes of this sync: the PENDING_PUSH retry and the main push are
    // refused for the secret; the teammate lands right before the third,
    // the squashed push, which is then not a fast-forward.
    a.beforeNextPush(() => {}).beforeNextPush(() => {}).beforeNextPush(async () => {
      b.write('x.md', 'b\n')
      ok(await b.sync(), 'b')
    })
    const out = await a.sync()
    assert.equal(out.result.errorType, 'push_failed', JSON.stringify(out.result))
    assert.equal(a.hasPendingPush(), true)
    assert.equal(serverHasSecret(world), false)
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('a.md')?.toString(), 'a\n')
    assert.equal(world.serverFile('x.md')?.toString(), 'b\n')
    assert.equal(serverHasSecret(world), false)
    await settleAndCheck(world)
    assert.equal(serverHasSecret(world), false)
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

  // Guard: .gitignore files merge with the union driver (.git/info/attributes).
  test('concurrent .gitignore changes keep both sides\' lines, at any depth, without a conflict', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { '営業部/.gitignore': 'base.tmp\n' } })
    const [a, b] = world.members
    a.append('.gitignore', 'a-only/\n').append('営業部/.gitignore', 'a.tmp\n')
    b.append('.gitignore', 'b-only/\n').append('営業部/.gitignore', 'b.tmp\n')
    ok(await a.sync(), 'a')
    const out = ok(await b.sync(), 'b')
    assert.ok(!out.result.hadConflicts, JSON.stringify(out.result))
    const root = world.serverFile('.gitignore')?.toString() ?? ''
    assert.ok(root.includes('a-only/\n') && root.includes('b-only/\n'), root)
    assert.equal(world.serverFile('営業部/.gitignore')?.toString(), 'base.tmp\na.tmp\nb.tmp\n')
    await settleAndCheck(world)
    for (const m of world.members) {
      // Declared once, locally — nothing about it is committed.
      const attributes = fs.readFileSync(path.join(m.dir, '.git', 'info', 'attributes'), 'utf-8')
      assert.equal(attributes.split('\n').filter(l => l === '.gitignore merge=union').length, 1, attributes)
    }
    assert.equal(world.serverFile('.gitattributes'), null)
  })

  test('a line both members added is not duplicated by the union merge', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }] })
    const [a, b] = world.members
    a.append('.gitignore', 'x/\nshared/\n')
    b.append('.gitignore', 'shared/\nz/\n')
    ok(await a.sync(), 'a')
    const out = ok(await b.sync(), 'b')
    assert.ok(logged(out, 'Removed duplicate .gitignore lines'), 'the union merge did not duplicate a line (test premise)')
    const lines = (world.serverFile('.gitignore')?.toString() ?? '').split('\n')
    assert.equal(lines.filter(l => l === 'shared/').length, 1, lines.join('\n'))
    assert.ok(lines.includes('x/') && lines.includes('z/'), lines.join('\n'))
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
