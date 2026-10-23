// git:preview (electron/sync/preview.ts) never stages. It used to run
// `git add --sparse .`, which put a file created inside a not-downloaded
// folder into the index — and sync's outside-checkout hold-back, comparing
// the disk with the index, then let the next sync share it. Multi-member
// scenarios for an index an older app already staged:
// tests/sync/outside-checkout.test.ts, tests/sync/private-folders.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import simpleGit from 'simple-git'
import { parsePorcelainStatus, previewChanges, withScratchIndex } from '../electron/sync/preview'

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV })
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), content)
}

/** A checkout with 営業部 left out (non-cone sparse, as the app sets it). */
function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-preview-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 't')
  for (const [f, c] of [['営業部/提案書.md', 'sales\n'], ['開発部/設計.md', 'dev\n'], ['開発部/古い.md', 'old\n'], ['root.md', 'root\n']]) write(root, f, c)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'seed')
  git(root, 'sparse-checkout', 'set', '--no-cone', '/*', '!/営業部/')
  return root
}

const indexBytes = (root: string) => fs.readFileSync(path.join(root, '.git', 'index'))

test('preview lists added / modified / deleted without changing the index', async () => {
  const root = repo()
  assert.equal(fs.existsSync(path.join(root, '営業部')), false, 'precondition: 営業部 not checked out')
  write(root, '営業部/提案書.md', 'AI draft\n') // over a file this checkout does not have
  write(root, '営業部/新フォルダ/メモ.md', 'memo\n')
  write(root, '開発部/設計.md', 'dev v2\n')
  write(root, '開発部/新規/a.md', 'a\n')
  fs.rmSync(path.join(root, '開発部/古い.md'))
  const before = indexBytes(root)

  const changes = await previewChanges(simpleGit(root).env(ENV))

  assert.deepEqual([...changes.added].sort(), ['営業部/新フォルダ/メモ.md', '開発部/新規/a.md'].sort())
  // Over a path this checkout does not have: git reports a modification.
  assert.deepEqual([...changes.modified].sort(), ['営業部/提案書.md', '開発部/設計.md'].sort())
  assert.deepEqual(changes.deleted, ['開発部/古い.md'])
  assert.ok(indexBytes(root).equals(before), 'the index changed')
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '', 'something was staged')
  // The new file in the not-downloaded folder is still untracked: sync's hold-back sees it.
  assert.match(git(root, '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'), /営業部\/新フォルダ\/メモ\.md/)
})

test('the summary stages into a throwaway index copy; the real index is untouched and the copy removed', async () => {
  const root = repo()
  write(root, '営業部/新規.md', 'new\n')
  write(root, '開発部/設計.md', 'dev v2\n')
  const before = indexBytes(root)
  const staged = await withScratchIndex({
    git: simpleGit(root).env(ENV),
    repoPath: root,
    makeGit: env => simpleGit(root).env({ ...ENV, ...env }),
    fn: async scratch => {
      await scratch.raw(['add', '--sparse', '.'])
      return scratch.raw(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only'])
    },
  })
  assert.deepEqual(staged.trim().split('\n').sort(), ['営業部/新規.md', '開発部/設計.md'].sort())
  assert.ok(indexBytes(root).equals(before), 'the real index changed')
  assert.deepEqual(fs.readdirSync(path.join(root, '.git')).filter(f => f.startsWith('acb-preview-index')), [])
})

test('parsePorcelainStatus maps every status code', () => {
  const raw = ['?? new.md', 'A  staged.md', 'AM staged-edited.md', 'AD gone-again.md', ' M edited.md', 'M  staged-edit.md',
    ' D removed.md', 'D  staged-removal.md', 'MD edited-then-removed.md', ' T type.md', 'UU conflict.md', '!! ignored.md', ''].join('\0')
  assert.deepEqual(parsePorcelainStatus(raw), {
    added: ['new.md', 'staged.md', 'staged-edited.md'],
    modified: ['edited.md', 'staged-edit.md', 'type.md', 'conflict.md'],
    deleted: ['removed.md', 'staged-removal.md', 'edited-then-removed.md'],
  })
})
