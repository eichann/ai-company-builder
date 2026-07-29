/**
 * Integration Test: bare repository configuration protects shared history.
 *
 * configureBareRepo must enable HTTP push, install the pre-receive hook, and
 * deny non-fast-forward pushes and branch deletions. The deny settings are
 * exercised for real: a force push against a configured repo must be rejected
 * and must leave the remote ref untouched. (During the 2026-07-29 incident,
 * only a client-side auth failure prevented a force push from erasing two
 * months of team history.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// git.ts transitively imports lib/auth, which requires AUTH_SECRET at import
// time — mock it like the other integration tests do (auth is unused here).
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { configureBareRepo } from '../../src/routes/git'

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

describe('configureBareRepo', () => {
  let workDir: string
  let bareRepo: string
  let clone: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'acb-bare-config-'))
    bareRepo = join(workDir, 'company.git')
    git(['init', '--bare', '--initial-branch=main', bareRepo])
    configureBareRepo(bareRepo)

    clone = join(workDir, 'clone')
    git(['clone', bareRepo, clone])
    git(['config', 'user.name', 'test'], clone)
    git(['config', 'user.email', 'test@example.com'], clone)
    writeFileSync(join(clone, 'a.txt'), 'one\n')
    git(['add', '.'], clone)
    git(['commit', '-m', 'first'], clone)
    writeFileSync(join(clone, 'a.txt'), 'two\n')
    git(['add', '.'], clone)
    git(['commit', '-m', 'second'], clone)
    git(['push', 'origin', 'main'], clone)
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('sets http.receivepack, denyNonFastForwards and denyDeletes', () => {
    expect(git(['-C', bareRepo, 'config', 'http.receivepack']).trim()).toBe('true')
    expect(git(['-C', bareRepo, 'config', 'receive.denyNonFastForwards']).trim()).toBe('true')
    expect(git(['-C', bareRepo, 'config', 'receive.denyDeletes']).trim()).toBe('true')
  })

  it('installs an executable pre-receive hook', () => {
    const hook = join(bareRepo, 'hooks', 'pre-receive')
    expect(existsSync(hook)).toBe(true)
    expect(statSync(hook).mode & 0o111).not.toBe(0)
  })

  it('rejects a force push that rewrites shared history', () => {
    const before = git(['-C', bareRepo, 'rev-parse', 'main']).trim()
    git(['reset', '--hard', 'HEAD~1'], clone)
    expect(() => git(['push', '--force', 'origin', 'main'], clone)).toThrow()
    expect(git(['-C', bareRepo, 'rev-parse', 'main']).trim()).toBe(before)
  })

  it('rejects branch deletion', () => {
    const before = git(['-C', bareRepo, 'rev-parse', 'main']).trim()
    expect(() => git(['push', 'origin', ':main'], clone)).toThrow()
    expect(git(['-C', bareRepo, 'rev-parse', 'main']).trim()).toBe(before)
  })

  it('still accepts a normal fast-forward push', () => {
    git(['reset', '--hard', 'origin/main'], clone)
    writeFileSync(join(clone, 'b.txt'), 'new\n')
    git(['add', '.'], clone)
    git(['commit', '-m', 'third'], clone)
    git(['push', 'origin', 'main'], clone)
    expect(git(['-C', bareRepo, 'rev-parse', 'main']).trim())
      .toBe(git(['rev-parse', 'HEAD'], clone).trim())
  })
})
