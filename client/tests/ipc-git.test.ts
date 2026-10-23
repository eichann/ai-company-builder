// IPC characterization: the git:* handlers the sync harness does not reach,
// and backup:*, through main.ts's real registrations (tests/ipc-harness).
//
// Logic one level down has its own tests: git-search.test.ts (grep, list,
// log), sync-preview.test.ts (preview, scratch index), folder-sizes.test.ts,
// company-folder.test.ts (setup decisions), the sync harness (sparse,
// first setup, sync). Pinned here is what main.ts adds: which handlers check
// the allowed roots and their failure envelopes, result shapes, the setup
// handler's flow, the private-folder rows in folder sizes, and the backup list.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadMain, commitRepo, git, writeFiles, SERVER_URL, type MainHarness } from './ipc-harness/main-harness.ts'

let h: MainHarness
let root: string
let outside: string
const DENIED = 'Access denied: path is outside allowed directories'

before(async () => {
  h = await loadMain()
  outside = h.companyDir('outside')
  commitRepo(h.base, outside, { 'secret.txt': 'outside' })
  root = h.companyDir('acme')
  await h.invoke('fs:registerAllowedRoot', root)
})
after(() => h.shutdown())

/** A bare "server" repository holding `files` on main, reachable as file://. */
function serverRepo(name: string, files: Record<string, string>): string {
  const bare = path.join(h.base, 'server', `${name}.git`)
  git(h.base, h.base, ['init', '-q', '--bare', '-b', 'main', bare])
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowReachableSHA1InWant', 'true']]) git(h.base, bare, ['config', k, v])
  if (Object.keys(files).length > 0) {
    const seed = path.join(h.base, 'seeds', name)
    commitRepo(h.base, seed, files)
    git(h.base, seed, ['push', '-q', bare, 'main'])
  }
  return `file://${bare}`
}

test('git handlers that check the allowed roots refuse outside paths with their own failure envelope', async () => {
  const err = { success: false, error: DENIED }
  const table: Array<[string, unknown[], unknown]> = [
    ['git:preview', [outside], { success: false, hasChanges: false, changes: { added: [], modified: [], deleted: [] }, totalCount: 0, error: DENIED }],
    ['git:revertFile', [outside, 'secret.txt', 'modified'], err],
    ['git:fileDiff', [outside, 'secret.txt', 'modified'], { ...err, diff: '' }],
    ['git:commitFileDiff', [outside, 'HEAD', 'secret.txt'], { ...err, diff: '' }],
    ['git:generateSummary', [outside], { success: false, summary: null }],
    ['git:listFiles', [outside, ''], { success: false, files: [], error: DENIED }],
    ['git:grep', [outside, 'outside', ''], { success: false, results: [], error: DENIED }],
    ['git:inspectCompanyFolder', [outside, 'co'], err],
    ['git:setupCompanyRemote', [outside, 'co'], err],
    ['git:sparseGetExclusions', [outside], { success: false, excluded: [], error: DENIED }],
    ['git:sparseSetExclusions', [outside, ['x']], err],
    ['git:sparseUncommittedChanges', [outside, ['x']], { success: false, files: [], error: DENIED }],
    ['git:folderSizes', [outside, '', '', []], err],
    ['backup:restore', [outside, 'b', 'secret.txt'], err],
  ]
  for (const [channel, args, expected] of table) assert.deepEqual(await h.invoke(channel, ...args), expected, channel)
  assert.equal(h.server.requests.length, 0)

  // A file path that climbs out of a registered repository is refused too.
  commitRepo(h.base, root, { 'in.txt': 'in' })
  // (git:revertFile 'added' runs `git rm --cached` first, which git refuses itself.)
  assert.equal((await h.invoke<{ success: boolean }>('git:revertFile', root, '../outside/secret.txt', 'added')).success, false)
  assert.deepEqual(await h.invoke('git:fileDiff', root, '../outside/secret.txt', 'added'), { ...err, diff: '' })
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8'), 'outside')
})

test('history, backup and sync handlers check the allowed roots too; commits are hex ids, never options', async () => {
  const before = h.server.requests.length
  writeFiles(outside, { '.backups/2026-01-01/x.md': 'x' })
  const table: Array<[string, unknown[], unknown]> = [
    ['git:log', [outside, '', 5], { success: false, commits: [], error: DENIED }],
    ['git:showCommit', [outside, 'abcdef0'], { success: false, files: [], error: DENIED }],
    ['backup:list', [outside], { success: false, error: DENIED, backups: [] }],
    ['backup:openFolder', [path.join(outside, '.backups', '2026-01-01')], { success: false, error: DENIED }],
    ['git:sync', [outside, 'co', 'msg'], { success: false, error: DENIED, errorType: 'unknown' }],
  ]
  for (const [channel, args, expected] of table) assert.deepEqual(await h.invoke(channel, ...args), expected, channel)
  assert.deepEqual(h.fake.openedPaths, [])
  assert.equal(h.server.requests.length, before)

  // backup:openFolder opens only a backup folder (openPath would launch an app or a script).
  const repo = path.join(root, 'open-backups')
  writeFiles(repo, { '.backups/2026-01-01/x.md': 'x', 'tool.command': '#!/bin/sh\n' })
  assert.deepEqual(await h.invoke('backup:openFolder', path.join(repo, '.backups', '2026-01-01')), { success: true })
  assert.deepEqual(h.fake.openedPaths, [path.join(repo, '.backups', '2026-01-01')])
  for (const p of [repo, path.join(repo, 'tool.command'), path.join(repo, '.backups', '2026-01-01', 'x.md')]) {
    assert.deepEqual(await h.invoke('backup:openFolder', p), { success: false, error: 'Not a backup folder' }, p)
  }
  assert.equal(h.fake.openedPaths.length, 1)

  // `git show <commit>`: `--output=<file>` before `--` made git write a file.
  const written = path.join(outside, 'written-by-show.txt')
  for (const commit of [`--output=${written}`, 'HEAD', 'main~1', '-p', '', 'abc', 'g123456', 42]) {
    assert.deepEqual(await h.invoke('git:commitFileDiff', root, commit, 'in.txt'), { success: false, error: 'Invalid commit id', diff: '' }, String(commit))
    assert.deepEqual(await h.invoke('git:showCommit', root, commit), { success: false, files: [], error: 'Invalid commit id' }, String(commit))
  }
  assert.equal(fs.existsSync(written), false)
  fs.rmSync(path.join(outside, '.backups'), { recursive: true })
})

test('working-tree handlers on a repository: preview, diffs, revert, log, show, list, grep', async () => {
  const repo = path.join(root, 'work')
  commitRepo(h.base, repo, { 'a.md': 'a\n', 'b.md': 'b\n', 'dir/c.md': 'needle\n' })
  const first = git(h.base, repo, ['rev-parse', 'HEAD']).trim()
  commitRepo(h.base, repo, { 'dir/d.md': 'd\n' }, 'second\n\nbody line')
  fs.writeFileSync(path.join(repo, 'a.md'), 'a2\n')
  fs.rmSync(path.join(repo, 'b.md'))
  fs.writeFileSync(path.join(repo, 'new.md'), 'new\n')

  assert.deepEqual(await h.invoke('git:preview', repo), {
    success: true, hasChanges: true, totalCount: 3,
    changes: { added: ['new.md'], modified: ['a.md'], deleted: ['b.md'] },
  })
  assert.deepEqual(await h.invoke('git:fileDiff', repo, 'new.md', 'added'), { success: true, diff: 'new\n', isNewFile: true })
  assert.deepEqual(await h.invoke('git:fileDiff', repo, 'b.md', 'deleted'), { success: true, diff: 'b\n', isDeletedFile: true })
  const modified = await h.invoke<{ success: boolean; diff: string }>('git:fileDiff', repo, 'a.md', 'modified')
  assert.equal(modified.success, true)
  assert.match(modified.diff, /-a\n\+a2\n/)

  for (const [file, status] of [['new.md', 'added'], ['a.md', 'modified'], ['b.md', 'deleted']]) {
    assert.deepEqual(await h.invoke('git:revertFile', repo, file, status), { success: true }, file)
  }
  assert.equal(fs.existsSync(path.join(repo, 'new.md')), false)
  assert.equal(fs.readFileSync(path.join(repo, 'a.md'), 'utf-8'), 'a\n')
  assert.equal(fs.readFileSync(path.join(repo, 'b.md'), 'utf-8'), 'b\n')
  assert.equal((await h.invoke<{ hasChanges: boolean }>('git:preview', repo)).hasChanges, false)

  const log = await h.invoke<{ success: boolean; commits: Array<Record<string, string>> }>('git:log', repo, 'dir', 50)
  assert.equal(log.success, true)
  assert.deepEqual(log.commits.map(c => [c.message, Object.keys(c).sort().join()]), [
    ['second\nbody line', 'author,date,hash,hashShort,message'],
    ['initial', 'author,date,hash,hashShort,message'],
  ])
  assert.deepEqual(await h.invoke('git:showCommit', repo, first), {
    success: true, files: [{ status: 'A', path: 'a.md' }, { status: 'A', path: 'b.md' }, { status: 'A', path: 'dir/c.md' }],
  })
  assert.deepEqual(await h.invoke('git:showCommit', repo, first, 'dir'), { success: true, files: [{ status: 'A', path: 'dir/c.md' }] })
  assert.deepEqual(await h.invoke('git:showCommit', repo, first.slice(0, 7).toUpperCase(), 'dir'), { success: true, files: [{ status: 'A', path: 'dir/c.md' }] }) // abbreviated
  const commitDiff = await h.invoke<{ success: boolean; diff: string }>('git:commitFileDiff', repo, first, 'a.md')
  assert.equal(commitDiff.success, true)
  assert.match(commitDiff.diff, /\+a\n/)
  const badShow = await h.invoke<{ success: boolean; files: unknown[]; error: string }>('git:showCommit', repo, 'no-such-commit')
  assert.deepEqual([badShow.success, badShow.files, typeof badShow.error], [false, [], 'string'])

  const listed = await h.invoke<{ success: boolean; files: string[]; truncated: boolean }>('git:listFiles', repo, 'dir')
  assert.deepEqual({ ...listed, files: [...listed.files].sort() }, { success: true, files: ['dir/c.md', 'dir/d.md'], truncated: false })
  const found = await h.invoke('git:grep', repo, 'NEEDLE', '')
  assert.deepEqual(found, { success: true, results: [{ file: 'dir/c.md', line: 1, text: 'needle', column: 0 }], truncated: false, timedOut: false, cancelled: false })
})

test('sparse handlers: exclusions round-trip through the worktree; uncommitted changes are reported first', async () => {
  const repo = path.join(root, 'sparse')
  commitRepo(h.base, repo, { '営業/a.md': 'a', '開発/b.md': 'b', 'top.md': 't' })
  assert.deepEqual(await h.invoke('git:sparseGetExclusions', repo), { success: true, excluded: [] })
  fs.writeFileSync(path.join(repo, '営業', 'a.md'), 'edited')
  assert.deepEqual(await h.invoke('git:sparseUncommittedChanges', repo, ['営業', '開発']), { success: true, files: ['営業/a.md'] })
  git(h.base, repo, ['checkout', '--', '.'])

  assert.deepEqual(await h.invoke('git:sparseSetExclusions', repo, ['営業']), { success: true, enabled: true, excluded: ['営業'] })
  assert.equal(fs.existsSync(path.join(repo, '営業')), false)
  assert.equal(git(h.base, repo, ['config', '--get', 'core.sparseCheckout']).trim(), 'true')
  assert.deepEqual(await h.invoke('git:sparseGetExclusions', repo), { success: true, excluded: ['営業'] })
  // A non-array is treated as "nothing excluded".
  assert.deepEqual(await h.invoke('git:sparseSetExclusions', repo, 'not-a-list'), { success: true, enabled: false, excluded: [] })
  assert.equal(fs.readFileSync(path.join(repo, '営業', 'a.md'), 'utf-8'), 'a')
})

test('git:folderSizes: the server view (or local trees offline) plus readable private folders without sizes', async () => {
  const repo = path.join(root, 'sizes')
  commitRepo(h.base, repo, { '人事/x.md': 'x', '営業/y.md': 'y' })
  git(h.base, repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']) // offline, the local trees are read from origin/main
  writeFiles(repo, {
    '.git/acb-private-scopes.json': JSON.stringify({
      companyId: 'co-s', version: '1', fetchedAt: '',
      scopes: [
        { scopeId: 's1', path: '人事/評価', cloneUrl: 'x', clonePath: 'x', canWrite: true },
        { scopeId: 's2', path: '役員', cloneUrl: 'x', clonePath: 'x', canWrite: false },
      ],
    }),
  })
  h.server.on('GET', '/api/companies/co-s/folder-sizes', () => ({
    json: { success: true, data: { path: '', size: 30, folders: [{ name: '人事', path: '人事', size: 10, files: 1, hasChildren: true }, { name: '営業', path: '営業', size: 20, files: 1, hasChildren: false }], measured: {} } },
  }))
  const online = await h.invoke<{ success: boolean; offline: boolean; folders: Array<Record<string, unknown>> }>('git:folderSizes', repo, 'co-s', '', [])
  assert.equal(online.success, true)
  assert.equal(online.offline, false)
  assert.deepEqual(online.folders.map(f => [f.path, f.size, f.private ?? false]), [['人事', 10, false], ['営業', 20, false], ['役員', null, true]])
  assert.deepEqual(online.folders.at(-1), { name: '役員', path: '役員', size: null, files: null, hasChildren: false, private: true })

  const nested = await h.invoke<{ folders: Array<Record<string, unknown>> }>('git:folderSizes', repo, '', '人事', [])
  assert.deepEqual(nested.folders.map(f => [f.path, f.private ?? false]), [['人事/評価', true]])
  h.server.offline = true
  const offline = await h.invoke<{ success: boolean; offline: boolean; folders: Array<Record<string, unknown>> }>('git:folderSizes', repo, 'co-s', '', [])
  h.server.offline = false
  assert.deepEqual([offline.success, offline.offline], [true, true])
  assert.deepEqual(offline.folders.map(f => [f.path, f.size]).sort(), [['人事', null], ['営業', null], ['役員', null]])
})

test('git:inspectCompanyFolder: online decision; offline only a clone of this company opens', async () => {
  const url = serverRepo('inspect', { '営業/a.md': 'a' })
  h.server.on('GET', '/api/git/repos/co-i', { json: { success: true, data: { companyId: 'co-i', httpsUrl: url } } })
  const empty = h.companyDir('inspect-empty')
  await h.invoke('fs:registerAllowedRoot', empty)
  assert.deepEqual(await h.invoke('git:inspectCompanyFolder', empty, 'co-i'), { success: true, decision: { action: 'firstSetup' } })
  const busy = h.companyDir('inspect-busy')
  writeFiles(busy, { 'mine.txt': 'mine' })
  await h.invoke('fs:registerAllowedRoot', busy)
  const refused = await h.invoke<{ success: boolean; decision: { action: string; reason: string } }>('git:inspectCompanyFolder', busy, 'co-i')
  assert.deepEqual([refused.success, refused.decision.action, refused.decision.reason], [true, 'refuse', 'notEmpty'])

  // Offline: recognised by the origin's path /api/git-http/<companyId>.git.
  h.server.offline = true
  const clone = h.companyDir('inspect-clone')
  commitRepo(h.base, clone, { 'a.md': 'a' })
  git(h.base, clone, ['remote', 'add', 'origin', `${SERVER_URL}/api/git-http/co-i.git`])
  await h.invoke('fs:registerAllowedRoot', clone)
  assert.deepEqual(await h.invoke('git:inspectCompanyFolder', clone, 'co-i'), { success: true, offline: true, decision: { action: 'existingClone' } })
  const offlineMessage = 'サーバーに接続できませんでした。インターネット接続を確認して、もう一度お試しください。'
  assert.deepEqual(await h.invoke('git:inspectCompanyFolder', clone, 'co-other'), { success: false, error: offlineMessage })
  assert.deepEqual(await h.invoke('git:inspectCompanyFolder', empty, 'co-i'), { success: false, error: offlineMessage })
  h.server.offline = false
})

test('git:setupCompanyRemote: join (full or picked departments), owner first push, refusals', async () => {
  const url = serverRepo('setup', { '営業/a.md': 'a', '開発/b.md': 'b', 'README.md': 'r' })
  h.server.on('GET', '/api/git/repos/co-x', { json: { success: true, data: { companyId: 'co-x', httpsUrl: url } } })
  h.server.on('GET', '/api/me', { json: { success: true, data: { email: 'me@example.com', name: 'Me' } } })
  h.server.on('GET', '/api/companies/co-x/departments', { json: { success: true, data: [{ folder: '営業' }, { folder: '開発' }, { folder: 'a/b' }] } })
  const setup = async (name: string, companyId: string, selected?: string[]) => {
    const dir = h.companyDir(name)
    await h.invoke('fs:registerAllowedRoot', dir)
    return { dir, result: await h.invoke<Record<string, unknown>>('git:setupCompanyRemote', dir, companyId, selected) }
  }

  const full = await setup('join-full', 'co-x')
  assert.deepEqual(full.result, { success: true, remoteUrl: url, cloned: true, message: `Cloned from server: ${url}` })
  assert.equal(fs.readFileSync(path.join(full.dir, '開発', 'b.md'), 'utf-8'), 'b')
  assert.equal(git(h.base, full.dir, ['config', 'user.email']).trim(), 'me@example.com')
  assert.equal(git(h.base, full.dir, ['remote', 'get-url', 'origin']).trim(), url)

  const picked = await setup('join-picked', 'co-x', ['営業'])
  assert.deepEqual(picked.result, {
    success: true, remoteUrl: url, cloned: true, partial: true,
    downloadedDepartments: ['営業'], excludedDepartments: ['開発'],
    message: `Cloned from server (selected departments only): ${url}`,
  })
  assert.equal(fs.existsSync(path.join(picked.dir, '開発')), false)
  assert.equal(fs.readFileSync(path.join(picked.dir, '営業', 'a.md'), 'utf-8'), 'a')

  // Reopening a clone keeps it as it is (no conversion), same result shape.
  assert.deepEqual(await h.invoke('git:setupCompanyRemote', full.dir, 'co-x'), full.result)

  const ownerUrl = serverRepo('owner', {})
  h.server.on('GET', '/api/git/repos/co-o', { json: { success: true, data: { companyId: 'co-o', httpsUrl: ownerUrl } } })
  const owner = h.companyDir('owner')
  writeFiles(owner, { '営業/plan.md': 'p' })
  await h.invoke('fs:registerAllowedRoot', owner)
  assert.deepEqual(await h.invoke('git:setupCompanyRemote', owner, 'co-o'), { success: true, remoteUrl: ownerUrl, cloned: false, message: `Git remote configured: ${ownerUrl}` })
  assert.equal(fs.readFileSync(path.join(owner, '.gitignore'), 'utf-8'), '.DS_Store\n*.log\nnode_modules/\n.backups/\n.workspace/\n# Secrets — never sync (local only)\n.env\n.env.*\n!.env.example\n!.env.sample\n')
  assert.equal(git(h.base, h.base, ['--git-dir', ownerUrl.slice('file://'.length), 'log', '--format=%s', '--all']).trim(), 'Initial commit')

  // Refusals change nothing in the folder.
  const busy = h.companyDir('setup-busy')
  writeFiles(busy, { 'mine.txt': 'mine' })
  await h.invoke('fs:registerAllowedRoot', busy)
  const refused = await h.invoke<{ success: boolean; refused: boolean; error: string }>('git:setupCompanyRemote', busy, 'co-x')
  assert.deepEqual([refused.success, refused.refused, typeof refused.error], [false, true, 'string'])
  assert.deepEqual(fs.readdirSync(busy), ['mine.txt'])
  assert.deepEqual(await h.invoke('git:setupCompanyRemote', busy, 'co-unknown'), { success: false, error: 'Failed to get repository info from server' })
  h.server.offline = true
  // Offline: the same plain sentence as git:inspectCompanyFolder.
  assert.deepEqual((await setup('setup-offline', 'co-x')).result, {
    success: false, error: 'サーバーに接続できませんでした。インターネット接続を確認して、もう一度お試しください。',
  })
  h.server.offline = false
})

test('backup:list / backup:restore: both backup places, newest first, private ids, no way out of either', async () => {
  const repo = path.join(root, 'backups')
  writeFiles(repo, {
    '.backups/2026-02-21_14-30-00.000/営業/提案.md': 'local version',
    '.backups/2026-02-21_14-30-00.000/_metadata.json': JSON.stringify({ timestamp: '2026-02-21T14:30:00.000Z', reason: 'conflict', conflictFiles: ['営業/提案.md', 'gone.md'] }),
    '.backups/2026-03-01T00-00-00-000_editor_overwrite/a.md': 'a',
    '.backups/2026-03-01T00-00-00-000_editor_overwrite/_metadata.json': '{not json',
    '.backups/.hidden/x.md': 'x',
    '.backups/stray.md': 'not a backup folder',
    '.git/acb-private-backups/2026-02-22T00-00-00-000_private/人事/評価/表.md': 'private',
    '.git/acb-private-backups/2026-02-22T00-00-00-000_private/_metadata.json': JSON.stringify({ timestamp: '2026-02-22T00:00:00.000Z', reason: 'conflict' }),
  })
  const list = await h.invoke<{ success: boolean; backups: Array<Record<string, unknown>> }>('backup:list', repo)
  assert.equal(list.success, true)
  assert.deepEqual(list.backups.map(b => ({ ...b, path: path.relative(repo, b.path as string).split(path.sep).join('/') })), [
    { id: '2026-03-01T00-00-00-000_editor_overwrite', timestamp: '2026-03-01T00-00-00-000_editor_overwrite', reason: 'unknown', files: ['a.md'], path: '.backups/2026-03-01T00-00-00-000_editor_overwrite' },
    { id: 'private:2026-02-22T00-00-00-000_private', timestamp: '2026-02-22T00:00:00.000Z', reason: 'conflict', files: ['人事/評価/表.md'], path: '.git/acb-private-backups/2026-02-22T00-00-00-000_private' },
    { id: '2026-02-21_14-30-00.000', timestamp: '2026-02-21T14:30:00.000Z', reason: 'conflict', files: ['営業/提案.md', 'gone.md'], path: '.backups/2026-02-21_14-30-00.000' },
  ])
  assert.deepEqual(await h.invoke('backup:list', path.join(root, 'no-backups')), { success: true, backups: [] })

  assert.deepEqual(await h.invoke('backup:restore', repo, '2026-02-21_14-30-00.000', '営業/提案.md'), { success: true, message: 'Restored: 営業/提案.md' })
  assert.equal(fs.readFileSync(path.join(repo, '営業', '提案.md'), 'utf-8'), 'local version')
  assert.deepEqual(await h.invoke('backup:restore', repo, 'private:2026-02-22T00-00-00-000_private', '人事/評価/表.md'), { success: true, message: 'Restored: 人事/評価/表.md' })
  assert.equal(fs.readFileSync(path.join(repo, '人事', '評価', '表.md'), 'utf-8'), 'private')

  const refusals: Array<[string, string, string]> = [
    ['../../..', 'x.md', 'Invalid backup path'],
    ['private:../..', 'x.md', 'Invalid backup path'],
    ['2026-02-21_14-30-00.000', '../../.git/config', 'Invalid backup path'],
    ['2026-02-21_14-30-00.000', '/etc/passwd', 'Invalid backup path'],
    ['2026-02-21_14-30-00.000', 'missing.md', 'Backup file not found'],
  ]
  for (const [id, file, error] of refusals) assert.deepEqual(await h.invoke('backup:restore', repo, id, file), { success: false, error }, `${id} ${file}`)
})
