/**
 * Integration Test: the server's own changes to a company repository —
 * seeding, department folder create / rename / delete — are commits built in
 * the bare repository, with no working tree, published through the
 * pre-receive checker.
 *
 * They used to run in a full working clone (`data/workdirs/<companyId>`):
 * `git pull`, `git mv`, `git add -A`, commit, push. A production rename of a
 * 1 MB department took 119 s (the pull checked out another member's 4,211
 * new files, `add -A` walked 10,775). These tests pin:
 *
 * (a) the trees and commits are what the working clone produced (files and
 *     their bytes, author "AI Company Builder", message, parent);
 * (b) no working clone, no index, no temp file is left behind;
 * (c) an existing target is refused (NFC, A–Z folded), the delete counts
 *     match the old on-disk count;
 * (d) the push goes through receive-pack and the pre-receive hook, marked as
 *     the server's own (ACB_INTERNAL_PUSH=1), and a content rule still
 *     refuses it;
 * (e) a member's push landing in between is not lost: the edit is redone on
 *     the new tip;
 * (f) a rename in a repository with thousands of files checks nothing out
 *     and takes about as long as in an empty one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { localRepoStore } from '../../src/adapters/git-repo-store'
import { companyRepoPath } from '../../src/lib/config'

// Every push runs the real pre-receive hook, which is slow on some hosts.
const SLOW = 300_000

const DATA_DIR = process.env.DATA_DIR as string
const store = localRepoStore()
const DEFAULTS = ['営業部', '経理部']

let scratch: string
let counter = 0

function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
}

const bareGit = (companyId: string, args: string[]) => git(['-C', companyRepoPath(companyId), ...args])
const tip = (companyId: string) => bareGit(companyId, ['rev-parse', 'refs/heads/main']).trim()
const files = (companyId: string, ref = 'main') =>
  bareGit(companyId, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0').filter(Boolean).sort()

const MEMBER = { GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'm@example.com', GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'm@example.com' }

/**
 * Commit a set of files on top of main straight into the bare repository
 * (test setup, no hook): a member's push without the transport.
 */
function memberCommit(companyId: string, content: Record<string, string>, opts: { update?: boolean } = {}): string {
  const bare = companyRepoPath(companyId)
  const work = join(scratch, `work-${++counter}`)
  mkdirSync(work, { recursive: true })
  for (const [rel, body] of Object.entries(content)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true })
    writeFileSync(join(work, rel), body)
  }
  const env = { ...MEMBER, GIT_INDEX_FILE: join(scratch, `index-${counter}`) }
  let parent: string | null = null
  try { parent = tip(companyId) } catch { /* empty repository */ }
  if (parent) git(['--git-dir', bare, 'read-tree', parent], { env })
  git(['--git-dir', bare, '--work-tree', work, 'add', '--ignore-removal', '.'], { env })
  const tree = git(['--git-dir', bare, 'write-tree'], { env }).trim()
  const commit = git(['--git-dir', bare, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'member change'], { env }).trim()
  rmSync(work, { recursive: true, force: true })
  rmSync(env.GIT_INDEX_FILE, { force: true })
  if (opts.update !== false) git(['--git-dir', bare, 'update-ref', 'refs/heads/main', commit])
  return commit
}

async function newCompany(seed = true): Promise<string> {
  const id = `dc-${++counter}`
  const bare = await store.createCompanyRepo(id)
  if (seed) await store.seedCompanyRepo(id, bare, DEFAULTS)
  return id
}

/** Everything in the bare repository except its object store and refs. */
function repoLayout(companyId: string): string[] {
  const root = companyRepoPath(companyId)
  return readdirSync(root).filter(name => !['objects', 'refs', 'logs', 'packed-refs', 'FETCH_HEAD', 'ORIG_HEAD'].includes(name)).sort()
}

/** The old on-disk count: a checkout, hidden entries (and what is below them) skipped. */
function checkoutCount(companyId: string, folder: string): { files: number; folders: number } {
  const checkout = join(scratch, `checkout-${++counter}`)
  git(['clone', '-q', companyRepoPath(companyId), checkout])
  let filesCount = 0
  let folders = 0
  const walk = (p: string) => {
    for (const item of readdirSync(p)) {
      if (item.startsWith('.')) continue
      if (statSync(join(p, item)).isDirectory()) { folders++; walk(join(p, item)) } else filesCount++
    }
  }
  walk(join(checkout, folder))
  return { files: filesCount, folders }
}

/** Replace the repository's pre-receive hook (restored by the caller). */
function withHook(companyId: string, script: string): () => void {
  const hook = join(companyRepoPath(companyId), 'hooks', 'pre-receive')
  const original = readFileSync(hook, 'utf8')
  writeFileSync(hook, `#!/bin/sh\n${script}\n`)
  chmodSync(hook, 0o755)
  return () => writeFileSync(hook, original)
}

let savedTemplateDir: string | undefined

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'acb-dept-commits-'))
  // A developer's global init.templateDir would install client-side hooks
  savedTemplateDir = process.env.GIT_TEMPLATE_DIR
  process.env.GIT_TEMPLATE_DIR = mkdtempSync(join(scratch, 'templates-'))
})

afterAll(() => {
  if (savedTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR
  else process.env.GIT_TEMPLATE_DIR = savedTemplateDir
  rmSync(scratch, { recursive: true, force: true })
})

describe('seeding', () => {
  it('writes the same files as the working clone did, as a root commit on main', { timeout: SLOW }, async () => {
    const id = await newCompany()
    expect(files(id)).toEqual(['.gitattributes', ...DEFAULTS.flatMap(f => [`${f}/.gitkeep`, `${f}/.personal/.gitignore`])].sort())
    expect(bareGit(id, ['show', 'main:.gitattributes']))
      .toBe('# AI Company Builder: テキストファイルの改行コードを全OSでLFに統一\n* text=auto eol=lf\n')
    expect(bareGit(id, ['show', 'main:経理部/.personal/.gitignore'])).toBe('# Personal workspace — not synced\n*\n!.gitignore\n')
    expect(bareGit(id, ['show', 'main:経理部/.gitkeep'])).toBe('')
    expect(bareGit(id, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%P|%s', 'main']).trim())
      .toBe('AI Company Builder <system@ai-company-builder.local>|AI Company Builder <system@ai-company-builder.local>||Initialize default department folders')
    expect(bareGit(id, ['rev-list', '--count', 'main']).trim()).toBe('1')
    expect(bareGit(id, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main')
  })
})

describe('department folders', () => {
  let id: string

  beforeAll(async () => {
    id = await newCompany()
  }, SLOW)

  it('create adds the folder on top of main, as "AI Company Builder"', { timeout: SLOW }, async () => {
    const before = tip(id)
    expect(await store.createDepartmentFolder(id, 'sales', 'Add department: Sales')).toBe(true)
    expect(files(id)).toEqual(expect.arrayContaining(['sales/.gitkeep', 'sales/.personal/.gitignore']))
    expect(bareGit(id, ['show', 'main:sales/.personal/.gitignore'])).toBe('# Personal workspace — not synced\n*\n!.gitignore\n')
    expect(bareGit(id, ['log', '-1', '--format=%an <%ae>|%cn|%P|%s', 'main']).trim())
      .toBe(`AI Company Builder <system@ai-company-builder>|AI Company Builder|${before}|Add department: Sales`)
    // Only the new folder changed
    expect(bareGit(id, ['diff', '--name-status', before, 'main']).trim().split('\n'))
      .toEqual(['A\tsales/.gitkeep', 'A\tsales/.personal/.gitignore'])
  })

  it('create refuses a folder that exists, also by another case or a file of that name', { timeout: SLOW }, async () => {
    memberCommit(id, { 'README.md': 'r\n' })
    const before = tip(id)
    expect(await store.createDepartmentFolder(id, 'sales', 'x')).toBe(false)
    expect(await store.createDepartmentFolder(id, 'Sales', 'x')).toBe(false)
    expect(await store.createDepartmentFolder(id, 'readme.md', 'x')).toBe(false)
    expect(tip(id)).toBe(before)
  })

  it('rename moves every entry under the folder, reusing its tree', { timeout: SLOW }, async () => {
    memberCommit(id, { 'sales/proposal.md': 'p\n', 'sales/2026/q3/plan.md': 'q\n', 'sales/.hidden/x.md': 'h\n' })
    const before = tip(id)
    const tree = bareGit(id, ['rev-parse', 'main:sales']).trim()
    const others = files(id).filter(f => !f.startsWith('sales/'))

    expect(await store.renameDepartmentFolder(id, 'sales', '営業企画', 'Rename department: sales -> 営業企画')).toBe(true)
    expect(bareGit(id, ['rev-parse', 'main:営業企画']).trim()).toBe(tree)
    expect(files(id).filter(f => f.startsWith('sales/'))).toEqual([])
    expect(files(id).filter(f => !f.startsWith('営業企画/'))).toEqual(others)
    expect(bareGit(id, ['log', '-1', '--format=%an|%P|%s', 'main']).trim())
      .toBe(`AI Company Builder|${before}|Rename department: sales -> 営業企画`)
    // Seen by git as renames, as `git mv` was
    const status = bareGit(id, ['diff', '-M', '--name-status', before, 'main']).trim().split('\n')
    expect(status.every(line => line.startsWith('R100\tsales/'))).toBe(true)
    expect(status).toHaveLength(5)
  })

  it('rename refuses an existing target (any case) and leaves main alone', { timeout: SLOW }, async () => {
    await store.createDepartmentFolder(id, 'Docs', 'Add department: Docs')
    const before = tip(id)
    expect(await store.renameDepartmentFolder(id, '営業企画', 'Docs', 'x')).toBe(false)
    expect(await store.renameDepartmentFolder(id, '営業企画', 'docs', 'x')).toBe(false)
    expect(await store.renameDepartmentFolder(id, '営業企画', '経理部', 'x')).toBe(false)
    expect(tip(id)).toBe(before)
  })

  it('rename changes only the case when asked to, and a missing source changes nothing', { timeout: SLOW }, async () => {
    expect(await store.renameDepartmentFolder(id, 'Docs', 'docs', 'Rename department: Docs -> docs')).toBe(true)
    expect(files(id)).toEqual(expect.arrayContaining(['docs/.gitkeep']))
    expect(files(id).some(f => f.startsWith('Docs/'))).toBe(false)

    const before = tip(id)
    expect(await store.renameDepartmentFolder(id, 'ghost', 'phantom', 'x')).toBe(true)
    expect(tip(id)).toBe(before)
  })

  it('rename finds a folder a Mac committed in NFD', { timeout: SLOW }, async () => {
    const nfd = 'プロジェクト'.normalize('NFD')
    expect(nfd).not.toBe(nfd.normalize('NFC'))
    memberCommit(id, { [`${nfd}/a.md`]: 'a\n' })
    expect(await store.renameDepartmentFolder(id, nfd.normalize('NFC'), 'dev', 'Rename department')).toBe(true)
    expect(files(id)).toEqual(expect.arrayContaining(['dev/a.md']))
    expect(files(id).some(f => f.startsWith(`${nfd}/`))).toBe(false)
  })

  it('delete removes the folder and reports the old on-disk counts', { timeout: SLOW }, async () => {
    memberCommit(id, { 'old/a.md': '1', 'old/b/c.md': '2', 'old/b/d/e.md': '3', 'old/.secret/x': '4', 'old/b/.hidden': '5' })
    const expected = checkoutCount(id, 'old')
    expect(expected).toEqual({ files: 3, folders: 2 })
    const before = tip(id)
    expect(await store.deleteDepartmentFolder(id, 'old', 'Delete department: Old (old)'))
      .toEqual({ deletedFiles: expected.files, deletedFolders: expected.folders })
    expect(files(id).some(f => f.startsWith('old/'))).toBe(false)
    expect(bareGit(id, ['log', '-1', '--format=%an|%P|%s', 'main']).trim())
      .toBe(`AI Company Builder|${before}|Delete department: Old (old)`)
  })

  it('delete of a missing folder changes nothing', { timeout: SLOW }, async () => {
    const before = tip(id)
    expect(await store.deleteDepartmentFolder(id, 'nowhere', 'x')).toEqual({ deletedFiles: 0, deletedFolders: 0 })
    expect(tip(id)).toBe(before)
  })

  it('leaves no working clone, index or temp file behind', { timeout: SLOW }, async () => {
    expect(existsSync(join(DATA_DIR, 'workdirs'))).toBe(false)
    expect(existsSync(join(companyRepoPath(id), 'index'))).toBe(false)
    // Laid out as a repository nothing was done in
    const fresh = await newCompany(false)
    expect(repoLayout(id)).toEqual(repoLayout(fresh))
  })

  it('throws without a repository', async () => {
    await expect(store.createDepartmentFolder('dc-none', 'x', 'x')).rejects.toThrow('Repository not found')
  })
})

describe('publishing goes through the pre-receive checker', () => {
  it('runs the hook on the update, marked as the server\'s own push', { timeout: SLOW }, async () => {
    const id = await newCompany()
    const log = join(scratch, `hook-${id}.log`)
    const restore = withHook(id, `echo "internal=$ACB_INTERNAL_PUSH" >> '${log}'\ncat >> '${log}'\nexit 0`)
    try {
      const before = tip(id)
      await store.createDepartmentFolder(id, 'hooked', 'Add department: hooked')
      expect(readFileSync(log, 'utf8')).toBe(`internal=1\n${before} ${tip(id)} refs/heads/main\n`)
    } finally {
      restore()
    }
  })

  it('a hook refusal fails the change and leaves main as it was', { timeout: SLOW }, async () => {
    const id = await newCompany()
    const restore = withHook(id, 'echo "[TEST_DENIED] no" >&2\nexit 1')
    try {
      const before = tip(id)
      await expect(store.renameDepartmentFolder(id, '営業部', 'sales', 'x')).rejects.toThrow(/TEST_DENIED|pre-receive/)
      expect(tip(id)).toBe(before)
    } finally {
      restore()
    }
  })

  it('the real checker still applies its content rules (a Windows reserved name)', { timeout: SLOW }, async () => {
    const id = await newCompany()
    const before = tip(id)
    await expect(store.createDepartmentFolder(id, 'con', 'Add department: con')).rejects.toThrow(/WINPATH_DETECTED/)
    expect(tip(id)).toBe(before)
  })
})

describe('a member pushing at the same time', () => {
  it('is kept: the change is redone on the new tip', { timeout: SLOW }, async () => {
    const id = await newCompany()
    const bare = companyRepoPath(id)
    // The member's commit, ready but not on main yet
    const member = memberCommit(id, { '経理部/月次.md': 'x\n' }, { update: false })
    const flag = join(scratch, `raced-${id}`)
    const log = join(scratch, `race-${id}.log`)
    // On the first push only, the member's commit lands on main while our
    // update waits in the hook: our ref update then loses the race.
    const restore = withHook(id, [
      `cat >> '${log}'`,
      `if [ ! -f '${flag}' ]; then`,
      `  touch '${flag}'`,
      `  env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git --git-dir='${bare}' update-ref refs/heads/main ${member}`,
      'fi',
      'exit 0',
    ].join('\n'))
    try {
      expect(await store.renameDepartmentFolder(id, '経理部', 'accounting', 'Rename department: 経理部 -> accounting')).toBe(true)
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
      expect(bareGit(id, ['log', '-1', '--format=%P|%s', 'main']).trim()).toBe(`${member}|Rename department: 経理部 -> accounting`)
      // The member's file moved with the folder
      expect(bareGit(id, ['show', 'main:accounting/月次.md'])).toBe('x\n')
      expect(files(id).some(f => f.startsWith('経理部/'))).toBe(false)
    } finally {
      restore()
    }
  })

  it('a create whose name the member took meanwhile is refused', { timeout: SLOW }, async () => {
    const id = await newCompany()
    const bare = companyRepoPath(id)
    const member = memberCommit(id, { 'new/x.md': 'x\n' }, { update: false })
    const flag = join(scratch, `raced-${id}`)
    const restore = withHook(id, [
      `if [ ! -f '${flag}' ]; then touch '${flag}'; env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git --git-dir='${bare}' update-ref refs/heads/main ${member}; fi`,
      'exit 0',
    ].join('\n'))
    try {
      expect(await store.createDepartmentFolder(id, 'new', 'Add department: new')).toBe(false)
      expect(tip(id)).toBe(member)
    } finally {
      restore()
    }
  })
})

describe('cost does not depend on the company size', () => {
  it('renames a department of a 3,000-file company without checking anything out', { timeout: SLOW }, async () => {
    const id = await newCompany()
    const content: Record<string, string> = {}
    for (let d = 0; d < 30; d++) {
      for (let f = 0; f < 100; f++) content[`dept${d}/sub${f % 10}/file${f}.md`] = `${d}-${f}\n`.repeat(20)
    }
    memberCommit(id, content)
    expect(files(id).length).toBeGreaterThan(3000)

    // Baseline: the same rename in a tiny company (mostly the checker's start-up)
    const small = await newCompany()
    let started = Date.now()
    await store.renameDepartmentFolder(small, '営業部', 'sales', 'Rename')
    const smallMs = Date.now() - started

    started = Date.now()
    expect(await store.renameDepartmentFolder(id, 'dept7', 'renamed', 'Rename department: dept7 -> renamed')).toBe(true)
    const bigMs = Date.now() - started

    expect(files(id).filter(f => f.startsWith('renamed/'))).toHaveLength(100)
    expect(existsSync(join(DATA_DIR, 'workdirs'))).toBe(false)
    expect(existsSync(join(companyRepoPath(id), 'index'))).toBe(false)
    // Generous bounds for loaded CI runners; locally both take about a second
    expect(bigMs).toBeLessThan(Math.max(4 * smallMs, smallMs + 10_000))
    console.log(`rename: ${smallMs} ms in a 2-folder company, ${bigMs} ms in a ${files(id).length}-file company`)
  })
})
