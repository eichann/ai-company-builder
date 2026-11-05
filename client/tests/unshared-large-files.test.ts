// The file tree's 「大きすぎて共有されていません」 mark lists what sync keeps on
// this computer because of its size (findUnsharedLargeFiles, sync.md step 4):
// untracked files over the limit, ignored or not yet — never a shared
// (tracked) large file, a small file, or anything inside a folder sync keeps
// local (.backups/, a private folder's clone).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { findUnsharedLargeFiles } from '../electron/sync/large-files'

/** simple-git 4 rejects an explicit env holding guarded keys (a developer's GIT_EDITOR); this test's env is its own. */
const GUARD_OFF = (env: object) => ({ allowEnvironment: Object.keys(env), unsafe: { allowUnsafeEditor: true, allowUnsafeConfigPaths: true, allowUnsafeTemplateDir: true } })

const LIMIT = 1024

test('untracked files over the limit are listed, ignored or not; shared, small and local-folder files are not', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-unshared-large-')))
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: path.join(root, 'tpl') }
    fs.mkdirSync(env.GIT_TEMPLATE_DIR)
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n')
    const repo = path.join(root, 'repo')
    const write = (rel: string, size: number) => {
      fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true })
      fs.writeFileSync(path.join(repo, rel), Buffer.alloc(size, 1))
    }
    fs.mkdirSync(repo)
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' })
    git(['init', '-q'])
    fs.writeFileSync(path.join(repo, '.gitignore'), '.backups/\n/ignored-by-line.mov\n')
    write('営業部/共有済み.mp4', LIMIT + 1) // tracked: shared, not marked
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'x'])
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '/人事/評価/\n/local-line.bin\n')

    write('ignored-by-line.mov', LIMIT + 1)
    write('local-line.bin', LIMIT + 1)
    write('営業部/動画/新しい.mp4', LIMIT + 1) // not ignored yet: the next sync will
    write('営業部/小さい.mp4', LIMIT)
    write('.backups/2026/大きい.mp4', LIMIT + 1)
    write('人事/評価/大きい.mp4', LIMIT + 1)
    write('node_modules/pkg/big.bin', LIMIT + 1)

    const files = await findUnsharedLargeFiles(simpleGit(repo, GUARD_OFF(env)).env(env), repo, LIMIT)
    assert.deepEqual(files.map(f => f.normalize('NFC')), ['ignored-by-line.mov', 'local-line.bin', '営業部/動画/新しい.mp4'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
