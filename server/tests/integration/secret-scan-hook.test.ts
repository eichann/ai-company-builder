/**
 * Integration Test: the pre-receive hook's secret scan.
 *
 * The scan used to spawn one `grep` per added line per pattern. A real push
 * of 23,217 added lines took ~7 minutes on the production server, so the
 * desktop client's 5-minute git watchdog killed `git push` and told the member
 * it failed — while the server went on to accept it. The scan now extracts
 * the added lines once and runs one grep per pattern over all of them, mapping
 * matching line numbers back to file names. These tests push to a bare repo
 * configured by configureBareRepo (the real hook) and pin both the speed and
 * the reported entries ("  - <file> (<pattern name>)").
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })

// Built from parts so this file itself never looks like it holds a credential.
const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const GITHUB_PAT = ['ghp_', 'a'.repeat(36)].join('')
const OPENAI_KEY = ['sk-', 'b'.repeat(24)].join('')

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string | Buffer) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(clone: string, message: string) {
  git(['add', '-A', '-f', '.'], clone)
  git(['commit', '-q', '--no-verify', '--allow-empty', '-m', message], clone)
}

function push(clone: string, ref = 'main'): { ok: boolean; output: string; ms: number } {
  const env = { ...process.env, ACB_PUSHER_ROLE: 'member' }
  const start = Date.now()
  const r = spawnSync('git', ['push', 'origin', ref], { cwd: clone, env, encoding: 'utf-8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`, ms: Date.now() - start }
}

/** The "- <file> (<pattern>)" entries of the SECRET_DETECTED section, in order. */
function secretEntries(output: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/^remote:\s*/, '').trim())
  const start = lines.findIndex(l => l.includes('[SECRET_DETECTED]'))
  if (start === -1) return []
  const entries: string[] = []
  let separators = 0
  for (const line of lines.slice(start + 1)) {
    if (/^=+$/.test(line)) {
      if (++separators === 2) break
      continue
    }
    if (line.startsWith('- ')) entries.push(line.slice(2))
  }
  return entries
}

let workDir: string
let counter = 0

/** Fresh bare repo (real hook) + a clone whose first commit (the given files) is already pushed. */
function setup(files: Record<string, string> = { 'README.md': 'hi\n' }): { bare: string; clone: string } {
  const id = `r${++counter}`
  const bare = join(workDir, `${id}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const clone = join(workDir, id)
  git(['clone', '-q', bare, clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  git(['checkout', '-q', '-B', 'main'], clone)
  for (const [rel, content] of Object.entries(files)) writeFile(clone, rel, content)
  commitAll(clone, 'base')
  const r = push(clone)
  if (!r.ok) throw new Error(`base push failed:\n${r.output}`)
  return { bare, clone }
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-secret-scan-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('pre-receive hook: secret scan', () => {
  it('scans a push of 40,000 added lines in seconds and names the file holding a secret planted near the end', () => {
    const { clone } = setup()
    // 200 files × 200 lines, CSS/HTML/Markdown-like text.
    for (let f = 0; f < 200; f++) {
      const ext = ['css', 'html', 'md'][f % 3]
      const lines: string[] = []
      for (let i = 0; i < 200; i++) {
        lines.push(`.c${f}-${i} { margin: ${i}px; } <p>filler line ${i} of file ${f}, nothing secret here</p>`)
      }
      writeFile(clone, `site/part${f % 10}/page${f}.${ext}`, lines.join('\n') + '\n')
    }
    writeFile(clone, 'site/part9/page199.md', `${'x\n'.repeat(150)}const key = "${AWS_KEY}"\n`)
    commitAll(clone, 'big')

    const r = push(clone)
    expect(r.ok).toBe(false)
    expect(secretEntries(r.output)).toEqual(['site/part9/page199.md (AWS Access Key ID)'])
    // Was minutes (one grep per line per pattern); now a constant number of processes.
    expect(r.ms).toBeLessThan(20_000)
  })

  it('reports a secret in a Japanese-named file under its real name (existing branch and new branch)', () => {
    const { clone } = setup()
    writeFile(clone, 'a.txt', 'clean\n')
    writeFile(clone, '営業部/見積 2026.md', `token: ${AWS_KEY}\n`)
    writeFile(clone, 'z.txt', 'clean\n')
    commitAll(clone, 'jp')
    const r = push(clone)
    expect(r.ok).toBe(false)
    expect(secretEntries(r.output)).toEqual(['営業部/見積 2026.md (AWS Access Key ID)'])

    git(['checkout', '-q', '-b', 'feature'], clone)
    writeFile(clone, '開発部/設定.md', `${OPENAI_KEY}\n`)
    commitAll(clone, 'jp new branch')
    const nb = push(clone, 'feature')
    expect(nb.ok).toBe(false)
    // New branch: the whole content of the files the tip commit changed.
    expect(secretEntries(nb.output)).toEqual(['開発部/設定.md (OpenAI/Anthropic API Key)'])
  })

  it('does not report a pattern that appears only in a file or folder name', () => {
    const { clone } = setup()
    writeFile(clone, `${AWS_KEY}/notes.md`, 'nothing to see\n')
    writeFile(clone, `keys/${GITHUB_PAT}.txt`, 'also clean\n')
    commitAll(clone, 'names')
    const r = push(clone)
    expect(r.output).not.toContain('[SECRET_DETECTED]')
    expect(r.ok).toBe(true)

    git(['checkout', '-q', '-b', 'named'], clone)
    writeFile(clone, `more/${OPENAI_KEY}.md`, 'clean\n')
    commitAll(clone, 'names on a new branch')
    const nb = push(clone, 'named')
    expect(nb.output).not.toContain('[SECRET_DETECTED]')
    expect(nb.ok).toBe(true)
  })

  it('reports the first matching pattern of each line, once per file and pattern, in diff order', () => {
    const { clone } = setup({ 'README.md': 'hi\n', 'edit.txt': 'one\ntwo\n' })
    // Line 1 matches both AWS and GitHub: only the first pattern (AWS) counts for it.
    writeFile(clone, 'b.txt', `${AWS_KEY} ${GITHUB_PAT}\n${AWS_KEY}\n`)
    // Line 2 matches GitHub alone: GitHub is reported for this file too.
    writeFile(clone, 'c.txt', `${AWS_KEY} ${GITHUB_PAT}\n${GITHUB_PAT}\n`)
    writeFile(clone, 'edit.txt', `one\n${OPENAI_KEY}\ntwo\n`)
    commitAll(clone, 'mixed')
    const r = push(clone)
    expect(r.ok).toBe(false)
    expect(secretEntries(r.output)).toEqual([
      'b.txt (AWS Access Key ID)',
      'c.txt (AWS Access Key ID)',
      'c.txt (GitHub Personal Access Token)',
      'edit.txt (OpenAI/Anthropic API Key)',
    ])
  })

  it('rejects a secret added in one commit and removed in a later one (every new commit is scanned)', () => {
    const { bare, clone } = setup({ 'README.md': 'hi\n', 'notes.md': 'one\n' })
    writeFile(clone, 'notes.md', `one\n${AWS_KEY}\n`)
    commitAll(clone, 'add secret')
    writeFile(clone, 'notes.md', 'one\n(see the vault)\n')
    commitAll(clone, 'remove secret')
    const r = push(clone)
    // The net diff holds no secret, but the first commit would land in shared history.
    expect(r.ok).toBe(false)
    expect(secretEntries(r.output)).toEqual(['notes.md (AWS Access Key ID)'])
    expect(git(['rev-parse', 'main'], bare).trim()).not.toBe(git(['rev-parse', 'HEAD'], clone).trim())

    // Squashed into one commit with the final content, the same change goes through.
    git(['reset', '-q', '--soft', 'origin/main'], clone)
    commitAll(clone, 'squashed')
    const squashed = push(clone)
    expect(squashed.output).not.toContain('[SECRET_DETECTED]')
    expect(squashed.ok).toBe(true)
  })

  it('a merge counts only what it adds itself; merged commits are scanned on their own', () => {
    const { clone } = setup({ 'README.md': 'hi\n', 'm.md': 'a\nb\n' })
    git(['checkout', '-q', '-b', 'side'], clone)
    writeFile(clone, 'm.md', `a\nb\n${GITHUB_PAT}\n`)
    commitAll(clone, 'side adds a secret')
    writeFile(clone, 'm.md', 'a\nb\nside\n')
    commitAll(clone, 'side removes it')
    git(['checkout', '-q', 'main'], clone)
    writeFile(clone, 'm.md', 'top\na\nb\n')
    commitAll(clone, 'main edit')
    git(['merge', '-q', '--no-edit', 'side'], clone)
    const r = push(clone)
    expect(r.ok).toBe(false)
    expect(secretEntries(r.output)).toEqual(['m.md (GitHub Personal Access Token)'])
  })

  it('scans only added lines, and skips binary files', () => {
    const { clone } = setup({ 'README.md': 'hi\n', 'old.txt': `${AWS_KEY}\nkeep\n` })
    // The secret already on the server is not re-reported when the file changes elsewhere.
    writeFile(clone, 'old.txt', `${AWS_KEY}\nkeep\nmore\n`)
    writeFile(clone, 'image.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(AWS_KEY)]))
    commitAll(clone, 'binary')
    const r = push(clone)
    expect(r.output).not.toContain('[SECRET_DETECTED]')
    expect(r.ok).toBe(true)
  })
})
