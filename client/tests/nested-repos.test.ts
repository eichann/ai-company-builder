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
import { findNestedGitRepos } from '../electron/sync/nested-repos'

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
