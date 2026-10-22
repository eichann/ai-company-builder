/**
 * Integration Test: the push checker stays fast on big pushes.
 *
 * The client's git watchdog kills a push that shows no progress for 5
 * minutes, and a hook that took minutes once made members think an accepted
 * push had failed (#113). A push of 50,000 added lines in 5,000 files — as a
 * member, with a restrictive permission snapshot so every path goes through
 * the write check too — must stay around a second on a developer machine.
 * The assertion leaves headroom for slow CI runners; the measured time is
 * printed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { configureBareRepo } from '../../src/routes/git'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 })

const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', maxBuffer: 1 << 28, ...(cwd ? { cwd } : {}) }).toString()
}

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-push-perf-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('push checker performance', () => {
  it('checks a 50,000-line / 5,000-file push (every rule + write check) in about a second', () => {
    const bare = join(workDir, 'perf.git')
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    configureBareRepo(bare)
    const clone = join(workDir, 'perf')
    git(['clone', '-q', bare, clone])
    git(['config', 'user.name', 'test'], clone)
    git(['config', 'user.email', 'test@example.com'], clone)
    git(['checkout', '-q', '-B', 'main'], clone)
    writeFileSync(join(clone, 'README.md'), 'hi\n')
    git(['add', '-A'], clone)
    git(['commit', '-q', '--no-verify', '-m', 'base'], clone)
    expect(spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: clone, env: { ...process.env, ACB_PUSHER_ROLE: 'owner' } }).status).toBe(0)

    for (let f = 0; f < 5000; f++) {
      const lines: string[] = []
      for (let i = 0; i < 10; i++) lines.push(`.c${f}-${i} { margin: ${i}px; } <p>filler line ${i} of file ${f}</p>`)
      if (f === 4998) lines[9] = `key = "${AWS_KEY}"`
      const rel = `${f % 2 ? 'sales' : 'site'}/part${f % 50}/page${f}.md`
      mkdirSync(dirname(join(clone, rel)), { recursive: true })
      writeFileSync(join(clone, rel), lines.join('\n') + '\n')
    }
    git(['add', '-A'], clone)
    git(['commit', '-q', '--no-verify', '-m', 'big'], clone)

    const policy = join(workDir, 'policy.json')
    writeFileSync(policy, JSON.stringify({
      version: 1,
      companyId: 'perf',
      pusher: { id: 'u-member', role: 'member' },
      scopes: [
        { id: 's0', path: '', kind: 'company', departmentId: null, repoId: null, rules: [{ id: 'r0', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true }] },
        { id: 's1', path: 'sales', kind: 'department', departmentId: null, repoId: null, rules: [{ id: 'r1', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false }] },
      ],
    }))
    const env = { ...process.env, ACB_PUSHER_ROLE: 'member', ACB_NODE: process.execPath, ACB_PUSH_POLICY: policy }
    const start = Date.now()
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8', maxBuffer: 1 << 28 })
    const ms = Date.now() - start
    console.log(`[push-check performance] 50,000 lines / 5,000 files: ${ms} ms`)
    const output = `${r.stdout}${r.stderr}`
    expect(r.status).not.toBe(0)
    expect(output).toContain('[SECRET_DETECTED]')
    expect(output).toContain('site/part48/page4998.md (AWS Access Key ID)')
    expect(output).toContain('[WRITE_DENIED]')
    expect(output.match(/^remote: {3}- sales\//gm)).toHaveLength(2500)
    expect(ms).toBeLessThan(30_000)
  })

  it('checks a 200-commit push (every commit secret-scanned) in about a second', () => {
    const bare = join(workDir, 'commits.git')
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    configureBareRepo(bare)
    const clone = join(workDir, 'commits')
    git(['clone', '-q', bare, clone])
    git(['config', 'user.name', 'test'], clone)
    git(['config', 'user.email', 'test@example.com'], clone)
    git(['checkout', '-q', '-B', 'main'], clone)
    writeFileSync(join(clone, 'README.md'), 'hi\n')
    git(['add', '-A'], clone)
    git(['commit', '-q', '--no-verify', '-m', 'base'], clone)
    expect(spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: clone, env: { ...process.env, ACB_PUSHER_ROLE: 'owner' } }).status).toBe(0)

    // 200 commits of 250 added lines each (50,000 lines), built in one
    // fast-import. Commit 100 adds a secret, commit 150 removes it again:
    // the net diff is clean, only the per-commit scan can see it.
    const base = git(['rev-parse', 'HEAD'], clone).trim()
    const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`
    let stream = ''
    for (let c = 1; c <= 200; c++) {
      const lines: string[] = []
      for (let i = 0; i < 250; i++) lines.push(`commit ${c} line ${i}: <p class="c${i}">filler text</p>`)
      stream += `commit refs/heads/main\ncommitter t <t@e> ${1_700_000_000 + c} +0000\n${data(`c${c}`)}`
      if (c === 1) stream += `from ${base}\n`
      stream += `M 100644 inline notes/c${c}.md\n${data(lines.join('\n') + '\n')}`
      if (c === 100) stream += `M 100644 inline notes/key.md\n${data(`key = "${AWS_KEY}"\n`)}`
      if (c === 150) stream += `M 100644 inline notes/key.md\n${data('key = (see the vault)\n')}`
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: clone, input: stream, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(git(['rev-list', '--count', 'origin/main..main'], clone).trim()).toBe('200')

    const env = { ...process.env, ACB_PUSHER_ROLE: 'member', ACB_NODE: process.execPath }
    const start = Date.now()
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8', maxBuffer: 1 << 28 })
    const ms = Date.now() - start
    console.log(`[push-check performance] 200 commits / 50,000 lines: ${ms} ms`)
    const output = `${r.stdout}${r.stderr}`
    expect(r.status).not.toBe(0)
    expect(output).toContain('[SECRET_DETECTED]')
    expect(output.match(/^remote: {3}- notes\/key\.md \(AWS Access Key ID\) *$/gm)).toHaveLength(1)
    expect(ms).toBeLessThan(30_000)
  })
})
