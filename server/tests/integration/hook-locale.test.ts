/**
 * Integration Test: the pre-receive hook behaves the same in every locale.
 *
 * The hook's "paths that differ only by case" check folds and compares path
 * names with tr / sort / uniq. Those follow the locale the hook inherits from
 * the server process: under LANG=en_US.UTF-8 on macOS, sort/uniq treat
 * distinct Japanese file names (no collation weights there) as equal, and an
 * ordinary push was rejected with WINPATH_DETECTED. Production happened to run
 * with no locale set (bytewise). The hook now pins LC_ALL=C itself, so these
 * tests push with a UTF-8 locale on purpose — LANG only, and LC_ALL — and
 * check that every text tool the hook runs sees the C locale no matter what.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// git.ts transitively imports lib/auth, which requires AUTH_SECRET at import
// time — mock it like the other integration tests do.
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { configureBareRepo } from '../../src/routes/git'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

/** The server's environment with the given locale variables and nothing else locale-related. */
function localeEnv(locale: Record<string, string>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('LC_') || key === 'LANG' || key === 'LANGUAGE' || key === 'ACB_PUSHER_ROLE') delete env[key]
  }
  return { ...env, ACB_PUSHER_ROLE: 'member', ...locale, ...extra }
}

function push(clone: string, env: NodeJS.ProcessEnv): { ok: boolean; output: string } {
  const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}

/** Paths listed in the WINPATH_DETECTED section of a rejected push. */
function winpathsIn(output: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/^remote:\s*/, '').trim())
  const start = lines.findIndex(l => l.includes('[WINPATH_DETECTED]'))
  if (start === -1) return []
  const paths: string[] = []
  let separators = 0
  for (const line of lines.slice(start + 1)) {
    if (/^=+$/.test(line)) {
      if (++separators === 2) break
      continue
    }
    if (line.startsWith('- ')) paths.push(line.slice(2))
  }
  return paths
}

let workDir: string
let counter = 0

/** Fresh bare repo (configureBareRepo → real hook) + a clone with the given files committed. */
function setup(files: Record<string, string>): { bare: string; clone: string } {
  const id = `r${++counter}`
  const bare = join(workDir, `${id}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const clone = join(workDir, id)
  git(['clone', '-q', bare, clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  git(['checkout', '-q', '-B', 'main'], clone)
  // Straight into the index: names that differ only by case would overwrite
  // each other on a case-insensitive filesystem (macOS, Windows).
  for (const [rel, content] of Object.entries(files)) {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: clone, input: content }).toString().trim()
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${rel}`], clone)
  }
  git(['commit', '-q', '--no-verify', '-m', 'files'], clone)
  return { bare, clone }
}

const UTF8_LOCALES: Array<[string, Record<string, string>]> = [
  ['LANG=en_US.UTF-8 (LC_ALL unset)', { LANG: 'en_US.UTF-8' }],
  ['LC_ALL=en_US.UTF-8', { LC_ALL: 'en_US.UTF-8' }],
  ['LC_COLLATE/LC_CTYPE=en_US.UTF-8', { LC_COLLATE: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' }],
]

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-hook-locale-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('pre-receive hook: locale independence', () => {
  for (const [label, locale] of UTF8_LOCALES) {
    it(`accepts distinct Japanese file names under ${label}`, () => {
      const { clone } = setup({
        'README.md': 'hi\n',
        '営業部/見積.md': '1\n',
        '営業部/提案書.md': '2\n',
        '営業部/顧客/一覧.md': '3\n',
        '開発部/設計.md': '4\n',
        '総務/規程 2026.md': '5\n',
      })
      const r = push(clone, localeEnv(locale))
      expect(r.output).not.toContain('[WINPATH_DETECTED]')
      expect(r.ok).toBe(true)
    })

    it(`still rejects an ASCII case collision under ${label}`, () => {
      const { bare, clone } = setup({
        'README.md': 'hi\n',
        '営業部/Report.md': 'a\n',
        '営業部/report.md': 'b\n',
      })
      const r = push(clone, localeEnv(locale))
      expect(r.ok).toBe(false)
      expect(winpathsIn(r.output)).toEqual(['営業部/report.md （大文字小文字のみ異なるパスが複数存在）'])
      expect(git(['-C', bare, 'rev-list', '--all']).trim()).toBe('')
    })
  }

  // Documents the scope of the check: only A-Z are folded. Full-width and
  // accented Latin letters do form case pairs on macOS/Windows filesystems,
  // but the hook does not fold them (it never did in production either).
  it('does not fold non-ASCII case pairs (full-width, accented Latin)', () => {
    const { clone } = setup({
      'README.md': 'hi\n',
      'docs/Ａ.md': 'full-width upper\n',
      'docs/ａ.md': 'full-width lower\n',
      'docs/É.md': 'accented upper\n',
      'docs/é.md': 'accented lower\n',
    })
    const r = push(clone, localeEnv({ LANG: 'en_US.UTF-8' }))
    expect(r.ok).toBe(true)
  })

  // The check above passes on glibc even without the pin (GNU uniq breaks
  // collation ties bytewise), so prove the pin itself: every text tool the
  // hook runs must see LC_ALL=C whatever locale the server was started with.
  it('runs every text tool in the C locale', () => {
    const shimDir = join(workDir, 'shims')
    const log = join(workDir, 'shim.log')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(log, '')
    const tools = ['tr', 'sort', 'uniq', 'grep', 'sed', 'awk']
    for (const tool of tools) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`]).toString().trim()
      const shim = join(shimDir, tool)
      writeFileSync(shim, `#!/bin/sh\necho "${tool} LC_ALL=\${LC_ALL-<unset>}" >> '${log}'\nexec '${real}' "$@"\n`)
      chmodSync(shim, 0o755)
    }
    const { clone } = setup({
      'README.md': 'hi\n',
      '営業部/見積.md': '1\n',
      '営業部/提案書.md': '2\n',
    })
    const env = localeEnv({ LANG: 'en_US.UTF-8' })
    env.PATH = `${shimDir}:${env.PATH}`
    const r = push(clone, env)
    expect(r.ok).toBe(true)
    const calls = readFileSync(log, 'utf-8').split('\n').filter(Boolean)
    // The case check alone runs tr, sort and uniq.
    for (const tool of ['tr', 'sort', 'uniq']) {
      expect(calls.some(c => c.startsWith(`${tool} `))).toBe(true)
    }
    expect(calls.filter(c => !c.endsWith('LC_ALL=C'))).toEqual([])
  })
})
