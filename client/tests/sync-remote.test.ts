// origin of a company repository (electron/sync/remote.ts): changing its URL
// must never drop a partial clone's promisor config, and a clone that lost it
// (`remote remove` + `remote add` in older app versions, 2026-10-22) repairs
// itself. Multi-member scenarios: tests/sync/partial-clone.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import simpleGit from 'simple-git'
import { configureOrigin, ensurePromisorConfig, hasPromisorPacks, setRemoteUrl } from '../electron/sync/remote'

const quiet = { log: () => {}, warn: () => {}, error: () => {} }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
}

function config(cwd: string, key: string): string {
  try { return git(cwd, 'config', '--get', key).trim() } catch { return '' }
}

/** A server with two departments and a partial clone that checked out only 営業部. */
function partialClone(): { root: string; url: string; clone: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-remote-'))
  const bare = path.join(root, 'server.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  git(bare, 'config', 'uploadpack.allowFilter', 'true')
  const seed = path.join(root, 'seed')
  git(root, 'init', '-q', '-b', 'main', seed)
  for (const [f, c] of [['営業部/a.md', 'sales\n'], ['開発部/b.md', 'dev\n']]) {
    fs.mkdirSync(path.join(seed, path.dirname(f)), { recursive: true })
    fs.writeFileSync(path.join(seed, f), c)
  }
  git(seed, 'add', '.')
  git(seed, '-c', 'user.name=s', '-c', 'user.email=s@example.com', 'commit', '-qm', 'seed')
  git(seed, 'push', '-q', bare, 'main')
  const url = `file://${bare}` // git ignores --filter for a plain local path
  const clone = path.join(root, 'clone')
  git(root, 'init', '-q', '-b', 'main', clone)
  git(clone, 'remote', 'add', 'origin', url)
  git(clone, 'fetch', '-q', '--filter=blob:none', 'origin')
  git(clone, 'sparse-checkout', 'set', '--no-cone', '/*', '!/開発部/')
  git(clone, 'checkout', '-q', '-b', 'main', 'origin/main')
  return { root, url, clone }
}

test('fetch --filter=blob:none writes promisor + partialclonefilter (what self-heal restores)', () => {
  const { root, clone } = partialClone()
  try {
    assert.equal(config(clone, 'remote.origin.promisor'), 'true')
    assert.equal(config(clone, 'remote.origin.partialclonefilter'), 'blob:none')
    assert.equal(config(clone, 'core.repositoryformatversion'), '1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('setRemoteUrl / configureOrigin change only the URL, never the promisor config', async () => {
  const { root, url, clone } = partialClone()
  try {
    const g = simpleGit(clone)
    assert.equal(await configureOrigin(g, url, quiet), 'unchanged')
    assert.equal(await setRemoteUrl(g, `${url}/`), 'updated')
    assert.equal(config(clone, 'remote.origin.url'), `${url}/`)
    assert.equal(await configureOrigin(g, url, quiet), 'updated')
    assert.equal(config(clone, 'remote.origin.url'), url)
    assert.equal(config(clone, 'remote.origin.promisor'), 'true')
    assert.equal(config(clone, 'remote.origin.partialclonefilter'), 'blob:none')
    assert.equal(config(clone, 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*')
    assert.ok(git(clone, 'rev-parse', 'origin/main').trim(), 'remote-tracking refs are kept')
    // The excluded department still downloads lazily.
    git(clone, 'sparse-checkout', 'disable')
    assert.equal(fs.readFileSync(path.join(clone, '開発部/b.md'), 'utf-8'), 'dev\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('setRemoteUrl adds origin when missing, and fills in a section that has no URL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-remote-'))
  try {
    git(root, 'init', '-q')
    const g = simpleGit(root)
    assert.equal(await setRemoteUrl(g, 'https://example.com/a.git'), 'added')
    assert.equal(config(root, 'remote.origin.url'), 'https://example.com/a.git')

    const other = path.join(root, 'other')
    git(root, 'init', '-q', other)
    git(other, 'config', 'remote.origin.promisor', 'true')
    assert.equal(await setRemoteUrl(simpleGit(other), 'https://example.com/b.git'), 'added')
    assert.equal(config(other, 'remote.origin.url'), 'https://example.com/b.git')
    assert.equal(config(other, 'remote.origin.promisor'), 'true')
    assert.equal(config(other, 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensurePromisorConfig restores a partial clone whose origin was removed and re-added; downloading works again', async () => {
  const { root, url, clone } = partialClone()
  try {
    // What git:setupCompanyRemote did before the fix.
    git(clone, 'remote', 'remove', 'origin')
    git(clone, 'remote', 'add', 'origin', url)
    assert.equal(config(clone, 'remote.origin.promisor'), '')
    assert.throws(() => git(clone, 'sparse-checkout', 'disable'), /unable to read|invalid object|missing/i,
      'the bug: the missing blobs can no longer be fetched')

    const g = simpleGit(clone)
    assert.equal(await hasPromisorPacks(g), true)
    const warnings: unknown[][] = []
    assert.equal(await ensurePromisorConfig(g, { ...quiet, warn: (...a: unknown[]) => { warnings.push(a) } }), true)
    assert.equal(warnings.length, 1)
    assert.equal(config(clone, 'remote.origin.promisor'), 'true')
    assert.equal(config(clone, 'remote.origin.partialclonefilter'), 'blob:none')
    assert.equal(await ensurePromisorConfig(g, quiet), false, 'nothing to do the second time')

    git(clone, 'sparse-checkout', 'disable')
    assert.equal(fs.readFileSync(path.join(clone, '開発部/b.md'), 'utf-8'), 'dev\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensurePromisorConfig leaves a full clone alone', async () => {
  const { root, url } = partialClone()
  try {
    const full = path.join(root, 'full')
    git(root, 'clone', '-q', url, full)
    assert.equal(await hasPromisorPacks(simpleGit(full)), false)
    assert.equal(await ensurePromisorConfig(simpleGit(full), quiet), false)
    assert.equal(config(full, 'remote.origin.promisor'), '')
    assert.equal(config(full, 'remote.origin.partialclonefilter'), '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
