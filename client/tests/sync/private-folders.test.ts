// Private folders (permission plan stage 3b): one sync button syncs the
// company repository and then every private folder the member may read — its
// own scope repository, cloned at its path inside the company folder.
// See .claude/rules/private-folders-client.md.
//
// The worlds run the real push checker for both repositories: the company's
// snapshot reserves every private folder's path ([RESERVED_PATH]), a scope
// repository's snapshot carries scopePath (write checked as <path>/<file>).
// /me/scopes is answered from World.myScopes with real salted hashes.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, DEFAULT_SCOPES, FAKE_AWS_KEY, privateMarker, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck, assertPrivacy } from '../sync-harness/invariants'
import { readPrivateExcludes } from '../../electron/sync/private-folders'
import { checkWritePath, decideReservedWrite } from '../../electron/write-guard'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
// CI runs this file (the longest of the harness) on two runners:
// SYNC_HARNESS_PART=k/n registers only every n-th scenario, starting with the
// k-th. Unset = every scenario.
const [PART, PARTS] = (process.env.SYNC_HARNESS_PART ?? '1/1').split('/').map(Number)
let scenarioCount = 0
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) => {
  if (scenarioCount++ % PARTS !== PART - 1) return
  test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)
}

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const HR = '人事/評価'

/** reader (member who may read 人事/評価), other (may not), boss (owner). */
function create(t: TestContext, extra: Partial<Parameters<typeof World.create>[1]> = {}) {
  const world = World.create(t, {
    members: [{ name: 'reader' }, { name: 'other' }, { name: 'boss', role: 'owner' }],
    departments: ['人事', '営業部'],
    seed: { '人事/規程.md': '規程 v1\n', '営業部/提案.md': '提案 v1\n' },
    ...extra,
  })
  const folder = world.createPrivateFolder(HR, { viewers: ['reader'], files: { '評価表.md': `${privateMarker('scope-private-1')}\n評価 v1\n` } })
  return { world, folder, reader: world.member('reader'), other: world.member('other'), boss: world.member('boss') }
}

function backupsWith(m: Member, reason: string) {
  return m.backups().filter(b => b.metadata.reason === reason)
}

describe('git:sync private folders', { concurrency: CONCURRENCY }, () => {
  scenario('reader gets the folder as its own clone; an edit reaches only the scope repository; the non-reader never sees it', async t => {
    const { world, folder, reader, other, boss } = create(t)
    const first = ok(await reader.sync(), 'reader')
    assert.deepEqual(first.result.newPrivateFolders, [HR])
    assert.match(first.result.message ?? '', /非公開フォルダ『人事\/評価』をダウンロードしました/)
    assert.ok(reader.exists(`${HR}/.git`), 'cloned at its path')
    assert.match(reader.readText(`${HR}/評価表.md`), /評価 v1/)
    assert.deepEqual(readPrivateExcludes(reader.dir), [HR], 'the company repository excludes it locally')
    assert.equal(reader.git(['status', '--porcelain', '--untracked-files=all']).trim(), '', 'the clone does not show up in the company repository')

    reader.write(`${HR}/評価表.md`, `${privateMarker(folder)}\n評価 v2\n`).write('営業部/提案.md', '提案 v2\n')
    ok(await reader.sync(), 'reader')
    assert.match(world.scopeFile(HR, '評価表.md')?.toString() ?? '', /評価 v2/)
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 v2\n')
    assert.equal(world.serverFile(`${HR}/評価表.md`), null, 'never in the company repository')

    const o = ok(await other.sync(), 'other')
    assert.equal(o.result.privateFolders, undefined)
    assert.equal(other.exists(HR), false)
    ok(await boss.sync(), 'boss')
    assert.match(boss.readText(`${HR}/評価表.md`), /評価 v2/, 'owners always read')
    await settleAndCheck(world)
  })

  scenario('created with the app dialog (3c): the sync that follows downloads it for the creator, also into an empty folder already there', async t => {
    const world = World.create(t, { members: [{ name: 'manager' }, { name: 'staff' }], departments: ['営業部'] })
    const [manager, staff] = world.members
    ok(await manager.sync(), 'manager')
    // POST /private-folders, then the dialog's sync. An empty folder at the
    // path (e.g. made a moment earlier) does not get in the way.
    world.createPrivateFolder('営業部/査定', { viewers: ['manager'] })
    fs.mkdirSync(manager.path('営業部/査定'), { recursive: true })
    fs.writeFileSync(manager.path('営業部/査定/.DS_Store'), '')
    const out = ok(await manager.sync(), 'manager')
    assert.deepEqual(out.result.newPrivateFolders, ['営業部/査定'])
    assert.ok(manager.exists('営業部/査定/.git'))
    assert.equal(manager.backups().length, 0, 'nothing to move aside')
    manager.write('営業部/査定/a.md', 'x\n')
    ok(await manager.sync(), 'manager')
    ok(await staff.sync(), 'staff')
    assert.equal(staff.exists('営業部/査定'), false)
    await settleAndCheck(world)
  })

  scenario('nested-repository detection leaves the private clone alone; the shared .gitignore never names it', async t => {
    const { world, reader } = create(t)
    ok(await reader.sync(), 'reader')
    const out = ok(await reader.sync(), 'reader')
    assert.deepEqual(out.dialogs, [], 'no "external repository" question')
    assert.doesNotMatch(world.serverFile('.gitignore')?.toString() ?? '', /評価/)
    await settleAndCheck(world)
  })

  scenario('a non-reader\'s own repository at a private folder name is moved to .backups whole, never offered for exclusion', async t => {
    const { world, other } = create(t)
    ok(await other.sync(), 'other')
    other.initNestedRepo(HR, { 'inner.md': 'inner\n' })
    const out = ok(await other.sync(), 'other')
    assert.deepEqual(out.dialogs, [], 'no "external repository" question (it would write the name into the shared .gitignore)')
    assert.deepEqual(out.result.reservedPathFiles, [HR])
    assert.equal(other.exists(HR), false)
    const [backup] = backupsWith(other, 'reserved_path')
    assert.ok(backup.files.includes(`${HR}/inner.md`))
    assert.doesNotMatch(world.serverFile('.gitignore')?.toString() ?? '', /評価/)
    await settleAndCheck(world)
  })

  scenario('a large file inside the private folder is not named in the company .gitignore', async t => {
    const { world, reader } = create(t)
    ok(await reader.sync(), 'reader')
    // Sparse file: > 100 MB on disk listing, no real bytes.
    const big = reader.path(`${HR}/big.bin`)
    const fd = fs.openSync(big, 'w')
    fs.ftruncateSync(fd, 101 * 1024 * 1024)
    fs.closeSync(fd)
    ok(await reader.sync(), 'reader')
    assert.doesNotMatch(world.serverFile('.gitignore')?.toString() ?? '', /big\.bin|評価/)
    assert.match(world.scopeFile(HR, '.gitignore')?.toString() ?? '', /big\.bin/, 'ignored inside the scope repository instead')
    await settleAndCheck(world)
  })

  scenario('non-reader creates the same folder name: held back before staging (hash pre-check), server reason wording, never shared', async t => {
    const { world, other } = create(t)
    ok(await other.sync(), 'other') // learns the hashes
    other.write(`${HR}/メモ.md`, 'my own notes\n').write('営業部/提案.md', '提案 v2\n')
    const out = ok(await other.sync(), 'other')
    assert.deepEqual(out.result.reservedPathFiles, [`${HR}/メモ.md`])
    assert.match(out.result.message ?? '', /『人事\/評価』というフォルダ名は使えません。別の名前にしてください。/)
    assert.equal(other.exists(`${HR}/メモ.md`), false, 'not left in place (the next sync would try again)')
    const [backup] = backupsWith(other, 'reserved_path')
    assert.ok(backup)
    assert.deepEqual(backup.files, [`${HR}/メモ.md`])
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 v2\n', 'the rest is shared')
    assert.equal(world.serverFile(`${HR}/メモ.md`), null)
    // The app's file operations and the chat guard refuse the name too
    // (POST /paths/check through sync's shared, cached checker).
    assert.equal(await other.reservedFolderOf(`${HR}/x.md`), HR)
    assert.equal(await other.reservedFolderOf('人事/x.md'), null)
    const guard = { root: other.dir, getAccess: () => undefined, getPrivateFolderView: () => ({ reservedFolderOf: (rel: string) => other.reservedFolderOf(rel), readOnlyFolderOf: () => null }) }
    assert.equal(checkWritePath(guard, `${HR}/new.md`).deny, false, 'the synchronous half knows nothing about it')
    const decision = await decideReservedWrite(guard, 'Write', { file_path: other.path(`${HR}/new.md`) })
    assert.equal(decision.deny, true)
    assert.equal(decision.deny && decision.message, '『人事/評価』というフォルダ名は使えません。別の名前にしてください。')
    const bash = await decideReservedWrite(guard, 'Bash', { command: `echo hi > ${HR}/x.md` }, other.dir)
    assert.equal(bash.deny, true)
    // The names are never on disk: the cache holds readable folders only.
    assert.doesNotMatch(fs.readFileSync(path.join(other.dir, '.git', 'acb-private-scopes.json'), 'utf-8'), /評価|salt|hash/)
    await settleAndCheck(world)
  })

  scenario('a file at the name staged by an older app\'s preview (`git add --sparse .`) is held back before staging all the same', async t => {
    const { world, other } = create(t)
    ok(await other.sync(), 'other')
    other.write(`${HR}/メモ.md`, 'my own notes\n').write('営業部/提案.md', '提案 v2\n')
    other.git(['add', '--sparse', '.'])
    const out = ok(await other.sync(), 'other')
    assert.deepEqual(out.result.reservedPathFiles, [`${HR}/メモ.md`])
    assert.equal(other.exists(`${HR}/メモ.md`), false)
    const backups = backupsWith(other, 'reserved_path')
    assert.deepEqual(backups.map(b => b.files), [[`${HR}/メモ.md`]])
    assert.equal(backups[0].metadata.reasons, undefined, 'held back before staging, not recovered after a [RESERVED_PATH] rejection')
    assert.equal(world.serverFile(`${HR}/メモ.md`), null)
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 v2\n')
    await settleAndCheck(world)
  })

  scenario('case and NFD variants of the name are held back too', async t => {
    const world = World.create(t, { members: [{ name: 'reader' }, { name: 'other' }], departments: ['hr'] })
    world.createPrivateFolder('hr/Secret', { viewers: ['reader'] })
    world.createPrivateFolder('人事/評価', { viewers: ['reader'] })
    const other = world.member('other')
    ok(await other.sync(), 'other')
    other.write('HR/secret/a.md', 'a\n').write('人事/評価/b.md'.normalize('NFD'), 'b\n').write('hr/Secretary/c.md', 'not reserved\n')
    const out = ok(await other.sync(), 'other')
    const held = (out.result.reservedPathFiles ?? []).map(f => f.normalize('NFC').toLowerCase()).sort()
    assert.deepEqual(held, ['hr/secret/a.md', '人事/評価/b.md'])
    assert.equal(world.serverFile('hr/Secretary/c.md')?.toString(), 'not reserved\n')
    await settleAndCheck(world)
  })

  scenario('path check unavailable: [RESERVED_PATH] rejection is recovered once — files backed up and removed, an exact move put back', async t => {
    const { world, other } = create(t)
    other.pathCheckDown = true // the server could not be asked (rate limit, error)
    other.write(`${HR}/メモ.md`, 'notes\n').write('営業部/別件.md', 'other work\n')
    other.rename('人事/規程.md', `${HR}/規程.md`)
    const out = ok(await other.sync(), 'other')
    assert.deepEqual([...(out.result.reservedPathFiles ?? [])].sort(), [`${HR}/メモ.md`, `${HR}/規程.md`].sort())
    assert.match(out.result.message ?? '', /（『人事\/評価』というフォルダ名は使えません。別の名前にしてください。）/, 'the server reason, verbatim')
    assert.equal(other.readText('人事/規程.md'), '規程 v1\n', 'the moved file is back where it was')
    assert.equal(world.serverFile('人事/規程.md')?.toString(), '規程 v1\n')
    assert.equal(world.serverFile('営業部/別件.md')?.toString(), 'other work\n')
    assert.equal(other.exists(`${HR}/メモ.md`), false)
    const [backup] = backupsWith(other, 'reserved_path')
    assert.deepEqual([...backup.files].sort(), [`${HR}/メモ.md`, `${HR}/規程.md`].sort())
    assert.equal(other.hasPendingPush(), false)
    // Nothing left to reject: the next sync is plain.
    const again = ok(await other.sync(), 'other')
    assert.equal(again.result.reservedPathFiles, undefined)
    other.pathCheckDown = false
    await settleAndCheck(world)
  })

  scenario('access gained: the next sync downloads the folder; a folder already at that path is moved to .backups first', async t => {
    const { world, other } = create(t)
    ok(await other.sync(), 'other')
    world.grantPrivate(HR, 'other')
    // A file already sitting at the path (e.g. created by hand in the meantime; ignored as reserved before).
    fs.mkdirSync(other.path(HR), { recursive: true })
    fs.writeFileSync(other.path(`${HR}/手元.md`), 'local\n')
    const out = ok(await other.sync(), 'other')
    assert.deepEqual(out.result.newPrivateFolders, [HR])
    assert.match(other.readText(`${HR}/評価表.md`), /評価 v1/)
    assert.equal(other.exists(`${HR}/手元.md`), false)
    const moved = [...backupsWith(other, 'private_folder_existing'), ...backupsWith(other, 'reserved_path')]
    assert.ok(moved.some(b => b.files.includes(`${HR}/手元.md`)), JSON.stringify(other.backups()))
    await settleAndCheck(world)
  })

  scenario('access lost: the folder is deleted without a backup, with the notice; unsynced edits are gone by design', async t => {
    const { world, reader, folder } = create(t)
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/下書き.md`, `${privateMarker(folder)}\nnot synced\n`)
    world.revokePrivate(HR, 'reader')
    const out = ok(await reader.sync(), 'reader')
    assert.deepEqual(out.result.lostPrivateFolders, [HR])
    assert.match(out.result.message ?? '', /このフォルダを見る権限がなくなったため、手元から削除しました（『人事\/評価』）。同期していなかった変更も削除されています。/)
    assert.equal(reader.exists(HR), false)
    assert.deepEqual(readPrivateExcludes(reader.dir), [])
    // From now on the name is reserved for them like for anyone else.
    reader.write(`${HR}/again.md`, 'x\n')
    const again = ok(await reader.sync(), 'reader')
    assert.deepEqual(again.result.reservedPathFiles, [`${HR}/again.md`])
    await settleAndCheck(world)
  })

  scenario('removed from the company: every private folder is deleted (Q1) — but only while the session is good', async t => {
    const { world, reader } = create(t)
    ok(await reader.sync(), 'reader')
    reader.removedFromCompany = true
    reader.offline() // nothing at all is known: nothing is deleted
    await reader.sync()
    assert.ok(reader.exists(`${HR}/.git`))
    reader.online()
    const out = await reader.sync()
    assert.deepEqual(out.result.lostPrivateFolders, [HR])
    assert.equal(reader.exists(HR), false)
    void world
  })

  scenario('make-public: the folder becomes part of the company folder; unsynced edits are backed up; everyone gets it', async t => {
    const { world, reader, other, folder } = create(t)
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/評価表.md`, `${privateMarker(folder)}\n評価 v2\n`)
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/評価表.md`, `${privateMarker(folder)}\n評価 v3 (not synced)\n`).write(`${HR}/新規.md`, 'new, not synced\n')
    world.makePublic(HR)
    const out = ok(await reader.sync(), 'reader')
    assert.deepEqual(out.result.madePublicFolders, [HR])
    assert.match(out.result.message ?? '', /『人事\/評価』は全員に公開されたため、会社のフォルダとして同期しました。同期していなかった変更（2件）は非公開フォルダのバックアップに保存しました/)
    assert.equal(reader.exists(`${HR}/.git`), false)
    assert.match(reader.readText(`${HR}/評価表.md`), /評価 v2/, 'the server version (the public one)')
    assert.equal(reader.git(['-c', 'core.quotePath=false', 'ls-files', `${HR}/評価表.md`]).trim(), `${HR}/評価表.md`, 'tracked by the company repository now')
    const [backup] = backupsWith(reader, 'made_public')
    assert.deepEqual([...backup.files].sort(), [`${HR}/新規.md`, `${HR}/評価表.md`])
    ok(await other.sync(), 'other')
    assert.match(other.readText(`${HR}/評価表.md`), /評価 v2/)
    await settleAndCheck(world)
  })

  scenario('concurrent edits in the scope repository: server wins, the member version is in the company .backups/ under the folder path', async t => {
    const { world, boss, reader, folder } = create(t)
    ok(await reader.sync(), 'reader')
    ok(await boss.sync(), 'boss')
    boss.write(`${HR}/評価表.md`, `${privateMarker(folder)}\nboss version\n`)
    ok(await boss.sync(), 'boss')
    reader.write(`${HR}/評価表.md`, `${privateMarker(folder)}\nreader version\n`)
    const out = ok(await reader.sync(), 'reader')
    assert.match(out.result.message ?? '', /『人事\/評価』: 同期完了。1ファイルが競合しました/)
    assert.match(reader.readText(`${HR}/評価表.md`), /boss version/)
    const conflict = reader.backups().find(b => b.metadata.reason === 'conflict')
    assert.ok(conflict)
    assert.deepEqual(conflict.files, [`${HR}/評価表.md`])
    assert.deepEqual(conflict.metadata.conflictFiles, [`${HR}/評価表.md`])
    await settleAndCheck(world)
  })

  scenario('a failure in the private folder does not block the company sync (and vice versa)', async t => {
    const { world, reader, folder } = create(t)
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/鍵.md`, `${privateMarker(folder)}\nkey: ${FAKE_AWS_KEY}\n`).write('営業部/提案.md', '提案 v2\n')
    const out = await reader.sync()
    assert.equal(out.result.success, false)
    assert.match(out.result.error ?? '', /非公開フォルダ『人事\/評価』を同期できませんでした。\nシークレット/)
    assert.match(out.result.error ?? '', /その他のフォルダは同期しました/)
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), '提案 v2\n', 'the company sync went through')
    assert.equal(world.serverTexts().some(x => x.includes(FAKE_AWS_KEY)), false)
    reader.write(`${HR}/鍵.md`, `${privateMarker(folder)}\nkey: (vault)\n`)
    ok(await reader.sync(), 'reader')
    await settleAndCheck(world)
  })

  scenario('PERSONAL_PATH inside the scope repository is untracked like in the company repository', async t => {
    const { world, reader } = create(t)
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/.personal/memo.md`, 'mine\n')
    reader.world.git(reader.path(HR), ['add', '-f', '.personal/memo.md'])
    const out = ok(await reader.sync(), 'reader')
    assert.match(out.result.message ?? '', /個人用フォルダ（.personal）のファイル1件は共有できないため/)
    assert.equal(world.scopeFile(HR, '.personal/memo.md'), null)
    assert.equal(reader.readText(`${HR}/.personal/memo.md`), 'mine\n')
    await settleAndCheck(world)
  })

  scenario('WRITE_DENIED inside the scope repository: a read-only sub-folder is restored with the usual dialog', async t => {
    const { world, reader, folder } = create(t)
    world.setScopes([...DEFAULT_SCOPES, {
      id: 'scope-locked', path: `${HR}/確定`, kind: 'folder', departmentId: null, repoId: null,
      rules: [{ id: 'r-locked', subjectType: 'user', subjectId: 'user-reader', canRead: true, canWrite: false }],
    }])
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/確定/結果.md`, `${privateMarker(folder)}\nfinal\n`).write(`${HR}/作業.md`, `${privateMarker(folder)}\nwork\n`)
    const out = ok(await reader.sync(), 'reader')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['writeDenied', 'restore']])
    assert.match(out.dialogs[0].options.detail, /人事\/評価\/確定\/結果\.md/, 'company-relative path in the dialog')
    assert.equal(world.scopeFile(HR, '確定/結果.md'), null)
    assert.match(world.scopeFile(HR, '作業.md')?.toString() ?? '', /work/)
    const [backup] = backupsWith(reader, 'write_denied')
    assert.deepEqual(backup.files, [`${HR}/確定/結果.md`])
    await settleAndCheck(world)
  })

  scenario('read-only viewer (canWrite false): local edits are offered back, never pushed', async t => {
    const world = World.create(t, { members: [{ name: 'viewer' }, { name: 'editor' }] })
    const folder = world.createPrivateFolder('役員', { viewers: ['viewer', 'editor'], editors: ['editor'], files: { 'a.md': 'v1\n' } })
    const [viewer, editor] = world.members
    ok(await viewer.sync(), 'viewer')
    ok(await editor.sync(), 'editor')
    viewer.write('役員/a.md', `${privateMarker(folder)}\nviewer edit\n`)
    const out = ok(await viewer.sync(), 'viewer')
    assert.deepEqual(out.dialogs.map(d => d.kind), ['writeDenied'])
    assert.equal(viewer.readText('役員/a.md'), 'v1\n')
    assert.equal(world.scopeFile('役員', 'a.md')?.toString(), 'v1\n')
    assert.deepEqual(backupsWith(viewer, 'write_denied')[0].files, ['役員/a.md'])
    editor.write('役員/a.md', 'v2\n')
    ok(await editor.sync(), 'editor')
    ok(await viewer.sync(), 'viewer')
    assert.equal(viewer.readText('役員/a.md'), 'v2\n')
    await settleAndCheck(world)
  })

  scenario('partial-clone member: a private folder inside a department it did not pick stays out; downloading the department brings it', async t => {
    const { world } = create(t)
    const p = await world.addPartialMember('partial', { departments: ['営業部'] })
    world.grantPrivate(HR, 'partial')
    const first = ok(await p.sync(), 'partial')
    assert.equal(first.result.newPrivateFolders, undefined)
    assert.equal(p.exists(HR), false, 'inside 人事, which is not downloaded')
    assert.equal(p.exists('人事/規程.md'), false)
    assert.equal((await p.addDepartment('人事')).success, true)
    const reports = await p.applyPrivateFolderChoices()
    assert.deepEqual(reports.map(r => [r.path, r.success, r.cloned]), [[HR, true, true]])
    assert.match(p.readText(`${HR}/評価表.md`), /評価 v1/)
    p.write(`${HR}/x.md`, 'from partial\n')
    ok(await p.sync(), 'partial')
    assert.equal(world.scopeFile(HR, 'x.md')?.toString(), 'from partial\n')
    await settleAndCheck(world)
  })

  scenario('leaving the private folder out in settings: its edits are pushed, then the clone is removed; downloading it again clones it', async t => {
    const { world, reader, folder } = create(t)
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/最後.md`, `${privateMarker(folder)}\nlast edit\n`)
    assert.equal((await reader.excludeFolder(HR)).success, true)
    const reports = await reader.applyPrivateFolderChoices()
    assert.deepEqual(reports.map(r => [r.path, r.success, r.removed]), [[HR, true, true]])
    assert.equal(reader.exists(HR), false)
    assert.match(world.scopeFile(HR, '最後.md')?.toString() ?? '', /last edit/)
    // A sync keeps it out (and the exclusion is not dropped as stale).
    ok(await reader.sync(), 'reader')
    assert.equal(reader.exists(HR), false)
    assert.deepEqual(readPrivateExcludes(reader.dir), [HR])
    assertPrivacy(world)
    assert.equal((await reader.includeFolder(HR)).success, true)
    await reader.applyPrivateFolderChoices()
    assert.match(reader.readText(`${HR}/最後.md`), /last edit/)
    await settleAndCheck(world)
  })

  scenario('security: a shared `!.backups/` cannot publish a private folder\'s backups (they are kept inside .git)', async t => {
    const { world, reader, other, boss, folder } = create(t)
    ok(await reader.sync(), 'reader'); ok(await boss.sync(), 'boss'); ok(await other.sync(), 'other')
    boss.write(`${HR}/評価表.md`, `${privateMarker(folder)}\nBOSS-SALARY\n`)
    ok(await boss.sync(), 'boss')
    reader.write(`${HR}/評価表.md`, `${privateMarker(folder)}\nREADER-SALARY\n`)
    ok(await reader.sync(), 'reader') // conflict: reader's version saved
    assert.ok(reader.backups().some(b => b.folder.startsWith('private:') && b.files.includes(`${HR}/評価表.md`)))
    assert.equal(reader.exists('.backups'), false, 'nothing private in the working tree')
    other.append('.gitignore', '\n!.backups/\n!.backups/**\n')
    ok(await other.sync(), 'other')
    reader.write('.backups/note.md', 'a local note\n') // even a real .backups/ is never staged
    ok(await reader.sync(), 'reader')
    ok(await reader.sync(), 'reader')
    assert.deepEqual([...world.serverTree().keys()].filter(k => k.startsWith('.backups')), [])
    assert.equal(world.companyTexts().some(x => x.includes('READER-SALARY')), false)
    reader.remove('.backups/note.md')
    await settleAndCheck(world)
  })

  scenario('security: a shared negation of the private path (`!評価/`) never stages the clone; unsynced private work is kept', async t => {
    const { world, reader, other } = create(t)
    ok(await reader.sync(), 'reader'); ok(await other.sync(), 'other')
    other.append('.gitignore', '\n!評価/\n!*\n')
    ok(await other.sync(), 'other')
    ok(await reader.sync(), 'reader')
    reader.write(`${HR}/unsynced.md`, 'READER-WORK\n')
    ok(await reader.sync(), 'reader')
    assert.equal(world.scopeFile(HR, 'unsynced.md')?.toString(), 'READER-WORK\n')
    assert.ok(reader.exists(`${HR}/.git`))
    assert.equal([...world.serverTree().keys()].some(k => k.startsWith('人事/評価')), false, 'no gitlink in the company repository')
    reader.write('営業部/提案.md', 'reader public edit\n')
    ok(await reader.sync(), 'reader')
    assert.equal(world.serverFile('営業部/提案.md')?.toString(), 'reader public edit\n')
    await settleAndCheck(world)
  })

  scenario('security: an ancestor of the private folder replaced by a symlink — the company sync stops before the pull, the clone and its unsynced work stay, nothing goes outside', async t => {
    const world = World.create(t, { members: [{ name: 'reader' }, { name: 'other' }], departments: ['営業部'], seed: { '営業部/顧客/a.md': 'a\n' } })
    const P = '営業部/顧客/秘密'
    world.createPrivateFolder(P, { viewers: ['reader'], files: { 's.md': 'PRIVATE\n' } })
    const [reader, other] = world.members
    const outside = fs.mkdtempSync(path.join(world.root, 'outside-'))
    ok(await reader.sync(), 'reader'); ok(await other.sync(), 'other')
    other.git(['rm', '-rq', '営業部/顧客'])
    fs.rmSync(other.path('営業部/顧客'), { recursive: true, force: true })
    fs.symlinkSync(outside, other.path('営業部/顧客'))
    await other.sync() // the server may refuse it; here the harness's checker lets it through
    if (!world.serverTree().has('営業部/顧客')) return // refused: nothing to test
    reader.write(`${P}/unsynced.md`, 'READER-WORK\n')
    const out = await reader.sync()
    assert.equal(out.result.success, false)
    assert.match(out.result.error ?? '', /フォルダ以外に置き換えられているため、同期を止めました/)
    assert.ok(reader.exists(`${P}/.git`), 'clone kept')
    assert.equal(world.scopeFile(P, 'unsynced.md')?.toString(), 'READER-WORK\n', 'the private folder still syncs')
    assert.ok(fs.lstatSync(reader.path('営業部/顧客')).isDirectory(), 'no pull happened')
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the company folder')
  })

  scenario('[LOCAL_ONLY_PATH]: .backups / .workspace content committed by hand is untracked (kept on disk), the rest shared, no loop', async t => {
    const { world, other } = create(t)
    ok(await other.sync(), 'other')
    other.write('営業部/.workspace/tmp.md', 'scratch\n').write('営業部/メモ.md', 'memo\n')
    other.world.git(other.dir, ['add', '-f', '営業部/.workspace/tmp.md', '営業部/メモ.md'])
    other.world.git(other.dir, ['-c', 'user.name=o', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', 'by hand'])
    const out = ok(await other.sync(), 'other')
    assert.match(out.result.message ?? '', /バックアップ・作業用フォルダ（.backups \/ .workspace）のファイル1件は共有できないため/)
    assert.equal(world.serverFile('営業部/.workspace/tmp.md'), null)
    assert.equal(world.serverFile('営業部/メモ.md')?.toString(), 'memo\n')
    assert.equal(other.readText('営業部/.workspace/tmp.md'), 'scratch\n', 'kept on disk')
    other.remove('営業部/.workspace')
    await settleAndCheck(world)
  })

  scenario('the AI may not write into a private folder the member may only read', async t => {
    const world = World.create(t, { members: [{ name: 'viewer' }] })
    world.createPrivateFolder('役員', { viewers: ['viewer'], editors: [] })
    const [viewer] = world.members
    ok(await viewer.sync(), 'viewer')
    const { readPrivateScopesCache, readableScopeOf } = await import('../../electron/sync/private-folders')
    const cache = readPrivateScopesCache(viewer.dir)
    const guard = {
      root: viewer.dir,
      getAccess: () => undefined,
      getPrivateFolderView: () => ({
        reservedFolderOf: () => null,
        readOnlyFolderOf: (rel: string) => { const s = readableScopeOf(cache?.scopes ?? [], rel); return s && !s.canWrite ? s.path : null },
      }),
    }
    const d = checkWritePath(guard, path.join(viewer.dir, '役員', 'x.md'))
    assert.equal(d.deny, true)
    assert.match(d.deny ? d.message : '', /閲覧のみ/)
  })
})
