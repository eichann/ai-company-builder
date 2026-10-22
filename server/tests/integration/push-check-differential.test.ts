/**
 * Differential test: the TypeScript push checker (lib/push-check, run by the
 * thin pre-receive hook) against the shell hook it replaced
 * (tests/fixtures/pre-receive-hook.legacy.sh, a verbatim copy of the last
 * shell version).
 *
 * Every attempt of the corpus below is fed to both hooks exactly as git
 * receive-pack would: GIT_DIR = the bare repository, the pushed objects
 * present but no ref pointing at them yet, "<old> <new> <ref>" lines on stdin,
 * the pusher variables git-http sets. stdout, stderr and the exit status must
 * be identical byte for byte — the clients parse these messages. Attempts
 * the hooks accept are then applied (update-ref), so later attempts build on
 * them like real pushes.
 *
 * Commits are built with plumbing (hash-object / update-index --index-info /
 * commit-tree), so the corpus can hold paths no file system would accept:
 * control characters, quotes, invalid UTF-8, case pairs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { renderPreReceiveHook } from '../../src/lib/git-server'

vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 })

const ZERO = '0'.repeat(40)
const LEGACY_HOOK = join(__dirname, '..', 'fixtures', 'pre-receive-hook.legacy.sh')

// Built from parts so this file never looks like it holds a credential.
const AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const PAT = ['ghp_', 'a'.repeat(36)].join('')
const OAUTH = ['gho_', 'b'.repeat(36)].join('')
const FINE = ['github_pat_', 'c'.repeat(30)].join('')
const SK = ['sk-', 'd'.repeat(24)].join('')
const SLACK = ['xoxb-', '1234567890-abc'].join('')
const GOOGLE = ['AIza', 'e'.repeat(35)].join('')
const PEM = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')

type Content = string | Buffer
/** A tree entry: file content, or an explicit mode (symlink target / gitlink commit). */
type Entry = Content | { mode: '100755' | '120000'; content: Content } | { mode: '160000'; sha: string }
/** Paths are UTF-8 strings, or Buffers for arbitrary bytes. */
type Tree = Map<string, Entry>

let workDir: string
let newHook: string
let legacyHook: string

function gitIn(bare: string, args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    env: { ...process.env, GIT_DIR: bare, ...extraEnv },
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  }).toString('latin1')
}

/** Path keys may carry raw bytes: "\x00bytes:<hex>" encodes a Buffer path. */
const bytesPath = (b: Buffer) => `\x00bytes:${b.toString('hex')}`
const pathBuffer = (key: string) => (key.startsWith('\x00bytes:') ? Buffer.from(key.slice(7), 'hex') : Buffer.from(key, 'utf8'))

class Repo {
  readonly bare: string
  private n = 0
  constructor(name: string) {
    this.bare = join(workDir, `${name}.git`)
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', this.bare])
    gitIn(this.bare, ['config', 'receive.denyNonFastForwards', 'true'])
    gitIn(this.bare, ['config', 'receive.denyDeletes', 'true'])
  }

  private blobs = new Map<string, string>()

  /** Write every not-yet-written content as a blob, in one git process. */
  private writeBlobs(contents: Content[]): void {
    const todo = [...new Set(contents.map(c => Buffer.from(c).toString('latin1')))].filter(k => !this.blobs.has(k))
    if (todo.length === 0) return
    const dir = mkdtempSync(join(workDir, 'blobs-'))
    const files = todo.map((k, i) => {
      const f = join(dir, String(i))
      writeFileSync(f, Buffer.from(k, 'latin1'))
      return f
    })
    const shas = gitIn(this.bare, ['hash-object', '-w', '--stdin-paths'], files.join('\n') + '\n').trim().split('\n')
    todo.forEach((k, i) => this.blobs.set(k, shas[i]))
    rmSync(dir, { recursive: true, force: true })
  }

  private blob(content: Content): string {
    return this.blobs.get(Buffer.from(content).toString('latin1')) as string
  }

  /** A commit whose tree is exactly `tree`. */
  commit(tree: Tree, parents: string[], message = `c${++this.n}`): string {
    const index = join(workDir, `index-${process.pid}-${this.n}-${Math.random().toString(36).slice(2)}`)
    const env = { GIT_INDEX_FILE: index }
    gitIn(this.bare, ['read-tree', '--empty'], undefined, env)
    this.writeBlobs([...tree.values()].flatMap(e => (typeof e === 'string' || Buffer.isBuffer(e) ? [e] : 'content' in e ? [e.content] : [])))
    const records: Buffer[] = []
    for (const [key, entry] of tree) {
      let mode = '100644'
      let sha: string
      if (typeof entry === 'string' || Buffer.isBuffer(entry)) sha = this.blob(entry)
      else if (entry.mode === '160000') { mode = '160000'; sha = entry.sha }
      else { mode = entry.mode; sha = this.blob(entry.content) }
      records.push(Buffer.concat([Buffer.from(`${mode} ${sha}\t`), pathBuffer(key), Buffer.from([0])]))
    }
    if (records.length > 0) gitIn(this.bare, ['update-index', '-z', '--index-info'], Buffer.concat(records), env)
    const treeSha = gitIn(this.bare, ['write-tree'], undefined, env).trim()
    rmSync(index, { force: true })
    const args = ['commit-tree', treeSha, ...parents.flatMap(p => ['-p', p]), '-m', message]
    return gitIn(this.bare, args, undefined, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    }).trim()
  }

  ref(name = 'refs/heads/main'): string {
    const r = spawnSync('git', ['rev-parse', '--verify', '-q', name], { env: { ...process.env, GIT_DIR: this.bare } })
    return r.status === 0 ? r.stdout.toString().trim() : ZERO
  }

  setRef(name: string, sha: string): void {
    if (sha === ZERO) gitIn(this.bare, ['update-ref', '-d', name])
    else gitIn(this.bare, ['update-ref', name, sha])
  }
}

interface HookRun { status: number | null; stdout: string; stderr: string; ms: number }

function runHook(hook: string, bare: string, stdin: string, env: Record<string, string | undefined>): HookRun {
  const full: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(full)) if (k.startsWith('ACB_')) delete full[k]
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k]
    else full[k] = v
  }
  full.GIT_DIR = bare
  const start = Date.now()
  const r = spawnSync(hook, [], { cwd: bare, env: full, input: stdin, maxBuffer: 1 << 28 })
  return { status: r.status, stdout: r.stdout.toString('latin1'), stderr: r.stderr.toString('latin1'), ms: Date.now() - start }
}

const ROLE_ENVS: Array<{ label: string; env: Record<string, string | undefined> }> = [
  { label: 'member', env: { ACB_PUSHER_ROLE: 'member', ACB_NODE: process.execPath } },
  { label: 'owner', env: { ACB_PUSHER_ROLE: 'owner', ACB_NODE: process.execPath } },
  { label: 'no role', env: {} },
  { label: 'member, no runnable ACB_NODE', env: { ACB_PUSHER_ROLE: 'member', ACB_NODE: '/nonexistent/node' } },
  { label: 'admin, UTF-8 locale', env: { ACB_PUSHER_ROLE: 'admin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } },
]

interface Attempt {
  label: string
  /** ref → new sha (ZERO = delete); old = the repo's current value. */
  updates: Array<[string, string]>
  /** Raw stdin instead of `updates` (malformed input). */
  stdin?: string
}

let compared = 0
/** Markers the legacy hook printed across the corpus (the corpus must exercise every rule). */
const seen = new Set<string>()
const timings: { legacy: number[]; next: number[] } = { legacy: [], next: [] }

/** Feed one attempt to both hooks under every role env; apply it when the owner run accepts it. */
function attempt(repo: Repo, a: Attempt, envs = ROLE_ENVS): void {
  const stdin = a.stdin ?? a.updates.map(([ref, sha]) => `${repo.ref(ref)} ${sha} ${ref}\n`).join('')
  for (const { label, env } of envs) {
    const legacy = runHook(legacyHook, repo.bare, stdin, env)
    const next = runHook(newHook, repo.bare, stdin, env)
    timings.legacy.push(legacy.ms)
    timings.next.push(next.ms)
    const what = `${a.label} [${label}]`
    expect({ what, status: next.status, stdout: next.stdout, stderr: next.stderr })
      .toEqual({ what, status: legacy.status, stdout: legacy.stdout, stderr: legacy.stderr })
    compared++
    for (const m of legacy.stderr.matchAll(/\[([A-Z_]+)\]/g)) seen.add(m[1])
    if (legacy.stderr.includes(Buffer.from('確認できませんでした').toString('latin1'))) seen.add('UNABLE_TO_CHECK')
  }
  if (a.stdin === undefined) {
    const owner = runHook(legacyHook, repo.bare, stdin, { ACB_PUSHER_ROLE: 'owner' })
    if (owner.status === 0) for (const [ref, sha] of a.updates) repo.setRef(ref, sha)
  }
}

/**
 * The one intended difference from the legacy hook: the secret scan also
 * reads every commit new to the server, not only the net <old>..<new> diff.
 * A secret added in one commit and removed in a later one passed the legacy
 * hook (and the intermediate commit landed in shared history); the push
 * checker rejects it, naming the file. Everything else about the attempt —
 * other sections, other refs — must still match, so the expected output is
 * the legacy output with that SECRET_DETECTED section added. Never applied.
 */
function attemptSecretOnlyInIntermediateCommit(repo: Repo, a: Attempt, expectedEntries: string[]): void {
  const stdin = a.updates.map(([ref, sha]) => `${repo.ref(ref)} ${sha} ${ref}\n`).join('')
  for (const { label, env } of ROLE_ENVS) {
    const legacy = runHook(legacyHook, repo.bare, stdin, env)
    const next = runHook(newHook, repo.bare, stdin, env)
    const what = `${a.label} [${label}]`
    expect({ what, status: legacy.status, secret: legacy.stderr.includes('[SECRET_DETECTED]') }).toEqual({ what, status: 0, secret: false })
    expect({ what, status: next.status }).toEqual({ what, status: 1 })
    expect(next.stdout).toBe(legacy.stdout)
    const entries = next.stderr.split('\n').filter(l => l.startsWith('  - ')).map(l => l.slice(4).trimEnd())
    expect({ what, entries }).toEqual({ what, entries: expectedEntries })
    expect(next.stderr).toContain('[SECRET_DETECTED]')
    compared++
  }
}

function tree(base: Tree, changes: Record<string, Entry | null>): Tree {
  const t = new Map(base)
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) t.delete(k)
    else t.set(k, v)
  }
  return t
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-push-diff-'))
  newHook = join(workDir, 'pre-receive.new')
  writeFileSync(newHook, renderPreReceiveHook())
  chmodSync(newHook, 0o755)
  legacyHook = join(workDir, 'pre-receive.legacy')
  copyFileSync(LEGACY_HOOK, legacyHook)
  chmodSync(legacyHook, 0o755)
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
  const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length))
  console.log(`[push-check differential] ${compared} runs compared; avg hook time legacy ${avg(timings.legacy)} ms, new ${avg(timings.next)} ms`)
})

describe('push checker vs legacy shell hook: identical output and status', () => {
  it('protected config, auto-run skills and .personal (adds, edits, deletes, renames, merges)', () => {
    const repo = new Repo('rules')
    const base: Tree = new Map<string, Entry>([
      ['README.md', 'hi\n'],
      ['.mcp.json', '{"v":1}\n'],
      ['営業部/.personal/.gitignore', '*\n!.gitignore\n'],
      ['.claude/skills/old/SKILL.md', '---\nname: old\n---\nplain\n'],
      ['.claude/skills/hooked/SKILL.md', '---\nhooks: {}\n---\n'],
      ['docs/a.md', 'a\n'],
    ])
    const c0 = repo.commit(base, [])
    attempt(repo, { label: 'seed (new branch, root commit)', updates: [['refs/heads/main', c0]] })

    const t1 = tree(base, {
      '.Claude/Settings.json': '{}\n',
      'x/.claude/hooks/run.sh': { mode: '100755', content: 'echo hi\n' },
      'sub/.claude/settings.local.json': '{}\n',
      '.claude': { mode: '120000', content: 'elsewhere' },
      'notes.md': 'n\n',
    })
    attempt(repo, { label: 'protected adds at any depth/case, .claude symlink', updates: [['refs/heads/main', repo.commit(t1, [c0])]] })

    const t2 = tree(base, { '.mcp.json': null, 'moved/.mcp.json': '{"v":1}\n' })
    attempt(repo, { label: 'protected delete + rename', updates: [['refs/heads/main', repo.commit(t2, [c0])]] })

    const t3 = tree(base, {
      '.claude/skills/a/SKILL.md': '---\nname: a\nhooks:\n  Stop: []\n---\n',
      '.claude/agents/b.md': '---\n"mcpServers": {x: 1}\n---\n',
      '.claude/commands/c.MD': 'run !`date` now\n',
      '.claude/skills/d/SKILL.md': 'intro\n```!\nls\n```\n',
      '.claude/skills/e/SKILL.md': '﻿---\n{lspServers: 1, monitors: 2}\n---\n',
      '.claude/skills/f/SKILL.md': '---\nname: f\ndescription: mentions hooks and !important\n---\nif ! grep x; then :; fi\n`!` ok\n',
      '.claude/skills/g/link': { mode: '120000', content: '../../elsewhere' },
      '.claude/skills/h/script.sh': '!`date`\n',
      '.claude/skills/hooked/SKILL.md': null,
      [bytesPath(Buffer.from('.claude/skills/caf\xe9/SKILL.md', 'latin1'))]: '---\nhooks: 1\n---\n',
      '.claude/skills/tab\there/SKILL.md': '!`x`\n',
    })
    attempt(repo, { label: 'auto-run parts in skills/agents/commands, symlink, deletion, odd names', updates: [['refs/heads/main', repo.commit(t3, [c0])]] })

    // Intermediate commit has hooks, the tip removed them again: still rejected (every commit counts).
    const t4a = tree(base, { '.claude/skills/i/SKILL.md': '---\nhooks: []\n---\n' })
    const c4a = repo.commit(t4a, [c0])
    const t4b = tree(base, { '.claude/skills/i/SKILL.md': '---\nname: i\n---\n' })
    attempt(repo, { label: 'auto-run part only in an intermediate commit', updates: [['refs/heads/main', repo.commit(t4b, [c4a])]] })

    const t5 = tree(base, {
      '.personal/a.txt': 'p\n',
      'X/.Personal/b.txt': 'p\n',
      '営業部/.personal/.gitignore': '*\n',
      '営業部/.personal/memo.md': 'm\n',
      'y/.personal/.GITIGNORE': 'x\n',
      'docs/a.md': null,
      '.personal-not/a.md': 'fine\n',
    })
    attempt(repo, { label: '.personal adds (allowed .gitignore, case, deletion elsewhere)', updates: [['refs/heads/main', repo.commit(t5, [c0])]] })

    // Owner seeds a file into .personal; later a member moves it out (rename = delete + add).
    const t6 = tree(base, { 'z/.personal/keep.md': 'k\n' })
    const c6 = repo.commit(t6, [c0])
    repo.setRef('refs/heads/main', c6)
    const t7 = tree(t6, { 'z/.personal/keep.md': null, 'z/keep.md': 'k\n' })
    attempt(repo, { label: 'rename out of .personal', updates: [['refs/heads/main', repo.commit(t7, [c6])]] })
    const t8 = tree(base, { 'z/.personal/keep.md': null, 'docs/a.md': null, 'docs/.personal/a.md': 'a\n' })
    attempt(repo, { label: 'rename into .personal + delete', updates: [['refs/heads/main', repo.commit(t8, [repo.ref()])]] })

    // Merges: a side branch already on the server merged in (combined diff),
    // and a merge that reverts .mcp.json to an old version (net diff).
    const head = repo.ref()
    const headTree = new Map<string, Entry>()
    for (const line of gitIn(repo.bare, ['ls-tree', '-r', '-z', '--full-tree', head]).split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t')
      const [mode, , sha] = line.slice(0, tab).split(' ')
      const raw = Buffer.from(line.slice(tab + 1), 'latin1')
      const key = Buffer.from(raw.toString('utf8'), 'utf8').equals(raw) ? raw.toString('utf8') : bytesPath(raw)
      const content = mode === '160000' ? Buffer.alloc(0) : Buffer.from(gitIn(repo.bare, ['cat-file', 'blob', sha]), 'latin1')
      headTree.set(key,mode === '100644' ? content : mode === '160000' ? { mode: '160000', sha } : { mode: mode as '100755' | '120000', content })
    }
    const sideTree = tree(headTree, { 'side.md': 's\n', '.mcp.json': '{"v":2}\n' })
    const side = repo.commit(sideTree, [head])
    repo.setRef('refs/heads/side', side)
    const mine = repo.commit(tree(headTree, { 'mine.md': 'm\n' }), [head])
    const merged = repo.commit(tree(sideTree, { 'mine.md': 'm\n' }), [mine, side])
    attempt(repo, { label: 'merge of a branch already on the server', updates: [['refs/heads/main', merged]] })
    const revert = repo.commit(tree(sideTree, { 'mine.md': 'm\n', '.mcp.json': '{"v":1}\n' }), [repo.ref(), side])
    attempt(repo, { label: 'merge that reverts .mcp.json', updates: [['refs/heads/main', revert]] })
  })

  it('Windows paths, case collisions, gitlinks', () => {
    const repo = new Repo('paths')
    const base: Tree = new Map<string, Entry>([['README.md', 'hi\n'], ['資料/見積.md', 'x\n'], ['資料/見積2.md', 'y\n']])
    const c0 = repo.commit(base, [])
    attempt(repo, { label: 'seed with Japanese names', updates: [['refs/heads/main', c0]] })

    const t1 = tree(base, {
      'a:b.txt': '1', 'q"uote.txt': '1', 'back\\slash.txt': '1', 'what?.md': '1', 'star*.md': '1', 'pipe|x': '1', '<lt>': '1',
      'trail./x.md': '1', 'space /x.md': '1', 'end.': '1', 'end ': '1',
      'CON': '1', 'con.txt': '1', 'aux/x.md': '1', 'Com1.log': '1', 'lpt9': '1', 'console.md': '1', 'xnul': '1',
      'tab\tname.md': '1', 'new\nline.md': '1', 'ctrl\x01.md': '1',
      'README.MD': 'dup\n', 'Docs/A.md': '1', 'docs/a.md': '1', 'docs/A.md': '1',
      'Ａ.md': '1', 'ａ.md': '1', 'É.md': '1', 'é.md': '1',
      [bytesPath(Buffer.from('lat\xe9n.md', 'latin1'))]: '1',
      [bytesPath(Buffer.from('LAT\xe9N.md', 'latin1'))]: '1',
    })
    attempt(repo, { label: 'every Windows path rule', updates: [['refs/heads/main', repo.commit(t1, [c0])]] })

    const t2 = tree(base, { 'vendor/lib': { mode: '160000', sha: 'a'.repeat(40) }, 'sp ace/mod': { mode: '160000', sha: 'b'.repeat(40) } })
    const c2 = repo.commit(t2, [c0])
    attempt(repo, { label: 'gitlinks added', updates: [['refs/heads/main', c2]] })
    // An existing gitlink (pushed before the rule) stays acceptable; changing it is not.
    repo.setRef('refs/heads/main', c2)
    attempt(repo, { label: 'existing gitlink untouched', updates: [['refs/heads/main', repo.commit(tree(t2, { 'other.md': 'o\n' }), [c2])]] })
    attempt(repo, { label: 'gitlink moved to a new commit', updates: [['refs/heads/main', repo.commit(tree(t2, { 'vendor/lib': { mode: '160000', sha: 'c'.repeat(40) } }), [c2])]] })
    attempt(repo, { label: 'new branch carrying gitlinks', updates: [['refs/heads/feature', repo.commit(tree(t2, { 'f.md': 'f\n' }), [c2])]] })
  })

  it('secrets: patterns, ordering, names, new branches, binaries, renames', () => {
    const repo = new Repo('secrets')
    const base: Tree = new Map<string, Entry>([['README.md', 'hi\n'], ['old.txt', `${AWS}\nkeep\n`], ['edit.txt', 'one\ntwo\n'], ['big.txt', 'line\n'.repeat(50)]])
    const c0 = repo.commit(base, [])
    attempt(repo, { label: 'seed holding a secret (new branch, root commit: not scanned)', updates: [['refs/heads/main', c0]] })
    repo.setRef('refs/heads/main', c0)

    const t1 = tree(base, {
      'b.txt': `${AWS} ${PAT}\n${AWS}\n`,
      'c.txt': `${AWS} ${PAT}\n${PAT}\n`,
      'edit.txt': `one\n${SK}\ntwo\n`,
      'all.txt': [PEM, OAUTH, FINE, SLACK, GOOGLE, SK, PAT, AWS].join('\n') + '\n',
      'with space.md': `${GOOGLE}\n`,
      'tab\there.md': `${SLACK}\n`,
      'q"uote.md': `${FINE}\n`,
      '営業部/見積 2026.md': `token: ${AWS}\n`,
      [bytesPath(Buffer.from('lat\xe9n.md', 'latin1'))]: `${OAUTH}\n`,
      'image.bin': Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(AWS)]),
      'old.txt': `${AWS}\nkeep\nmore\n`,
      [`${AWS}/notes.md`]: 'nothing\n',
      'crlf.txt': `a\r\n${PAT}\r\n`,
      'diff.txt': `+++ b/fake\ndiff --git a/x b/x\n+${SK}\n`,
    })
    attempt(repo, { label: 'existing branch: added lines, first pattern per line, per file × pattern', updates: [['refs/heads/main', repo.commit(t1, [c0])]] })

    const t2 = tree(base, { 'big.txt': null, 'renamed.txt': 'line\n'.repeat(50) + `${SK}\n` })
    attempt(repo, { label: 'rename with an added secret line', updates: [['refs/heads/main', repo.commit(t2, [c0])]] })

    const nb1 = repo.commit(tree(base, { 'n1.md': `${PAT}\n` }), [c0])
    const nb2 = repo.commit(tree(base, { 'n1.md': `${PAT}\n`, 'n2.md': `x\n${AWS}\n${PEM}\n`, 'n3.md': `${SK}\n${AWS}\n`, '開発部/設定.md': `${SK}\n`, 'old.txt': `${AWS}\nkeep\n!\n` }), [nb1])
    attempt(repo, { label: 'new branch: whole content of the tip commit files', updates: [['refs/heads/feature', nb2]] })

    // Intended difference (see attemptSecretOnlyInIntermediateCommit):
    // added in one commit, removed in the next — the net diff is clean.
    const added = repo.commit(tree(base, { 'edit.txt': `one\n${PAT}\ntwo\n`, 'tmp.md': `${AWS}\n` }), [c0])
    const removed = repo.commit(tree(base, { 'edit.txt': 'one\nthree\ntwo\n' }), [added])
    attemptSecretOnlyInIntermediateCommit(repo, { label: 'secret added then removed in a later commit', updates: [['refs/heads/main', removed]] },
      ['edit.txt (GitHub Personal Access Token)', 'tmp.md (AWS Access Key ID)'])

    const merge = repo.commit(tree(base, { 'm.md': `${AWS}\n` }), [c0, nb1])
    attempt(repo, { label: 'new branch whose tip is a merge (not scanned, as before)', updates: [['refs/heads/merged', merge]] })

    // Many files on a new branch: several xargs batches in the legacy hook.
    const many: Record<string, string> = {}
    for (let i = 0; i < 3000; i++) many[`many/dir${i % 30}/file-with-a-longish-name-${i}.md`] = i === 2500 ? `${GOOGLE}\n` : `f${i}\n`
    const mb = repo.commit(tree(base, many), [c0])
    attempt(repo, { label: 'new branch with 3000 files', updates: [['refs/heads/many', mb]] }, ROLE_ENVS.slice(0, 1))
  })

  it('several refs in one push, deletions, malformed input', () => {
    const repo = new Repo('refs')
    const base: Tree = new Map<string, Entry>([['README.md', 'hi\n']])
    const c0 = repo.commit(base, [])
    repo.setRef('refs/heads/main', c0)
    repo.setRef('refs/heads/gone', c0)
    const a = repo.commit(tree(base, { '.mcp.json': '{}\n', 'k.md': `${AWS}\n` }), [c0])
    const b = repo.commit(tree(base, { '.mcp.json': '{}\n', 'x/.personal/p.md': 'p\n', 'CON': '1', 'k.md': `${AWS}\n` }), [a])
    attempt(repo, {
      label: 'two refs sharing commits + a branch deletion',
      updates: [['refs/heads/main', a], ['refs/heads/feature', b], ['refs/heads/gone', ZERO]],
    })
    attempt(repo, { label: 'unknown object', stdin: `${c0} ${'f'.repeat(40)} refs/heads/main\n`, updates: [] })
    attempt(repo, { label: 'unknown old object', stdin: `${'e'.repeat(40)} ${a} refs/heads/main\n`, updates: [] })
    attempt(repo, { label: 'unterminated last line + extra spaces', stdin: `  ${c0}  ${a}   refs/heads/main  \n${c0} ${b} refs/heads/x`, updates: [] })
    attempt(repo, { label: 'empty input', stdin: '', updates: [] })
  })

  it('the corpus exercised every rejection the legacy hook knows', () => {
    expect([...seen].sort()).toEqual([
      'GITLINK_DETECTED', 'PERSONAL_PATH', 'PROTECTED_CONFIG', 'SECRET_DETECTED', 'UNABLE_TO_CHECK', 'WINPATH_DETECTED',
    ])
  })
})
