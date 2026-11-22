// Nested-repository detection (electron/sync/nested-repos.ts) asks git which
// folders it ignores: a nested repository there is never shared, so it is
// neither reported nor walked (2026-11-22: a clone inside `.personal/` stopped
// sync, and every sync walked the ignored tree). Multi-member scenarios:
// tests/sync/scenarios.test.ts "a nested repository inside an ignored folder…".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { simpleGit } from 'simple-git'
import type { SimpleGit } from 'simple-git'
import { backUpBeforeServerOverwrite, findNestedGitRepos } from '../electron/sync/nested-repos'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
}

function write(root: string, rel: string, content = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), content)
}

function nestedRepo(root: string, rel: string): void {
  write(root, `${rel}/inner.md`)
  git(path.join(root, rel), 'init', '-q')
}

/** A company checkout with `.gitignore` (committed) and `tracked` files committed with -f. */
function checkout(t: { after: (fn: () => void) => void }, gitignore: string, tracked: string[] = []): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-nested-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q', '-b', 'main')
  write(root, '.gitignore', gitignore)
  for (const f of tracked) write(root, f)
  git(root, 'add', '-f', '.')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed')
  return root
}

test('a nested repository inside an ignored folder is not reported, and the ignored folder is never read', async t => {
  const root = checkout(t, 'big/\n')
  let deep = 'big'
  for (let i = 0; i < 30; i++) deep += `/d${i}`
  nestedRepo(root, `${deep}/repo`)
  nestedRepo(root, 'shared/tool')
  // Without git's answer the old walk finds both (so the check below means something).
  assert.deepEqual(await findNestedGitRepos(root), ['shared/tool', `${deep}/repo`])

  const read: string[] = []
  const readdir = fs.promises.readdir
  t.mock.method(fs.promises, 'readdir', (dir: string, ...rest: unknown[]) => {
    read.push(path.relative(root, dir))
    return (readdir as (...a: unknown[]) => unknown)(dir, ...rest)
  })
  assert.deepEqual(await findNestedGitRepos(root, { git: simpleGit(root) }), ['shared/tool'])
  assert.deepEqual(read.filter(d => d === 'big' || d.startsWith('big/')), [], 'the ignored tree is not walked')
})

test('an ignored folder that holds a tracked file is still searched (a stray .git in a shared folder is asked about)', async t => {
  const root = checkout(t, 'scratch/\n', ['scratch/notes/a.md'])
  nestedRepo(root, 'scratch/notes')
  nestedRepo(root, 'scratch/other')
  assert.deepEqual(await findNestedGitRepos(root, { git: simpleGit(root) }), ['scratch/notes'])
})

test('negations and a folder named in NFD on disk follow git', async t => {
  const nfc = 'デザイン'
  const root = checkout(t, `work/*\n!work/keep/\n/${nfc}/\n`)
  nestedRepo(root, 'work/keep/repo')
  nestedRepo(root, 'work/other/repo')
  nestedRepo(root, `${nfc.normalize('NFD')}/repo`)
  assert.deepEqual(await findNestedGitRepos(root, { git: simpleGit(root) }), ['work/keep/repo'])
})

test('a folder ignored only on this computer is still searched (a teammate may share there; the backup before the pull needs it)', async t => {
  const root = checkout(t, '')
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\nlocal-only/\n')
  nestedRepo(root, 'local-only/repo')
  // A .gitignore nobody else has yet (untracked) is not a shared rule either.
  write(root, 'drafts/.gitignore', '*\n')
  nestedRepo(root, 'drafts/repo')
  // The same kind of folder under a tracked .gitignore is skipped.
  write(root, 'shared-ignore/.gitignore', '*\n!.gitignore\n')
  git(root, 'add', 'shared-ignore/.gitignore')
  nestedRepo(root, 'shared-ignore/repo')
  assert.deepEqual((await findNestedGitRepos(root, { git: simpleGit(root) })).sort(), ['drafts/repo', 'local-only/repo'])
})

test('the member\'s own exclusions are still reported, also inside an ignored folder', async t => {
  const root = checkout(t, 'big/\n')
  nestedRepo(root, 'big/old-choice')
  nestedRepo(root, 'big/other')
  assert.deepEqual(await findNestedGitRepos(root, { git: simpleGit(root), known: ['big/old-choice'] }), ['big/old-choice'])
})

test('when git cannot answer, every folder is searched (asking is the safe side)', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-nested-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // Not a repository: git fails, nothing counts as ignored.
  write(root, '.gitignore', 'big/\n')
  nestedRepo(root, 'big/repo')
  assert.deepEqual(await findNestedGitRepos(root, { git: simpleGit(root) }), ['big/repo'])
})

test('folder names that look like pathspec magic or hold `:12:` are read as names', async t => {
  const root = checkout(t, ':foo/\n')
  nestedRepo(root, ':foo/repo')
  write(root, 'p:1:q/.gitignore', '*\n!.gitignore\n')
  git(root, 'add', 'p:1:q/.gitignore')
  nestedRepo(root, 'p:1:q/repo')
  nestedRepo(root, 'shared/tool')
  assert.deepEqual(await findNestedGitRepos(root, { git: simpleGit(root) }), ['shared/tool'])
})

/** A checkout whose origin/main has `serverFiles` that HEAD lacks; this computer has its own versions there. */
function behindServer(t: { after: (fn: () => void) => void }, serverFiles: string[]): string {
  const root = checkout(t, '')
  for (const f of serverFiles) write(root, f, 'server\n')
  git(root, 'add', '-f', '.')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'teammate')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'reset', '-q', '--hard', 'HEAD~1')
  for (const f of serverFiles) write(root, f, 'mine\n')
  return root
}

const quiet = { log: () => {}, warn: () => {} }

test('the backup before the pull asks git a few times however many ignored folders there are', async t => {
  const root = behindServer(t, ['f3/a.md', 'f7/b.md'])
  const folders = Array.from({ length: 50 }, (_, i) => `f${i}`)
  for (const f of folders) fs.mkdirSync(path.join(root, f), { recursive: true })
  const real = simpleGit(root)
  let calls = 0
  const counting = { raw: (args: string[]) => { calls++; return real.raw(args) } } as unknown as SimpleGit
  const result = await backUpBeforeServerOverwrite({
    git: counting, repoPath: root, repos: folders, backupPath: path.join(root, '.backups', 'x_nested_repo'), now: new Date(), log: quiet,
  })
  assert.deepEqual(result?.files, ['f3/a.md', 'f7/b.md'])
  assert.ok(calls <= 3, `git was called ${calls} times for 50 folders`)
})

test('a guarded folder named like pathspec magic does not switch off the backup for its neighbours', async t => {
  const root = behindServer(t, ['other/a.md'])
  fs.mkdirSync(path.join(root, ':(glob)cache'), { recursive: true })
  const result = await backUpBeforeServerOverwrite({
    git: simpleGit(root), repoPath: root, repos: [':(glob)cache', 'other'], backupPath: path.join(root, '.backups', 'x_nested_repo'), now: new Date(), log: quiet,
  })
  assert.deepEqual(result?.files, ['other/a.md'])
})

test('when the server\'s files cannot be listed, the check fails (sync stops) rather than reading as "nothing arrives"', async t => {
  const root = behindServer(t, ['other/a.md'])
  const real = simpleGit(root)
  const failing = { raw: (args: string[]) => (args.includes('ls-tree') ? Promise.reject(new Error('ls-tree failed')) : real.raw(args)) } as unknown as SimpleGit
  await assert.rejects(backUpBeforeServerOverwrite({
    git: failing, repoPath: root, repos: ['other'], backupPath: path.join(root, '.backups', 'x_nested_repo'), now: new Date(), log: quiet,
  }), /ls-tree failed/)
})

test('without a server branch yet (first push) nothing can arrive: no backup, no stop', async t => {
  const root = checkout(t, '')
  write(root, 'big/a.md', 'mine\n')
  const result = await backUpBeforeServerOverwrite({
    git: simpleGit(root), repoPath: root, repos: ['big'], backupPath: path.join(root, '.backups', 'x_nested_repo'), now: new Date(), log: quiet,
  })
  assert.equal(result, null)
})

test('a guarded folder inside another is counted once (no doubled files or count)', async t => {
  const root = behindServer(t, ['big/old-choice/a.md'])
  // Far apart in the list (git is asked in batches): the inner one first.
  const fillers = Array.from({ length: 250 }, (_, i) => `empty${i}`)
  const result = await backUpBeforeServerOverwrite({
    git: simpleGit(root), repoPath: root, repos: ['big/old-choice', ...fillers, 'big'], backupPath: path.join(root, '.backups', 'x_nested_repo'), now: new Date(), log: quiet,
  })
  assert.deepEqual(result?.files, ['big/old-choice/a.md'])
  assert.deepEqual(result?.repos, ['big'])
})
