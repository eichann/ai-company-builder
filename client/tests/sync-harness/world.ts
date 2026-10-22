// Multi-member test harness for git:sync.
//
// A World is one company: a bare "server" repository configured like
// server/src/routes/git.ts configureBareRepo (denyNonFastForwards,
// denyDeletes, the production pre-receive hook) and N member clones. Each
// member runs the REAL extracted sync (client/electron/sync/git-sync.ts) with
// the app's git configuration (sync/git-factory.ts), the production dialog
// and server-API adapters, and scripted dialog answers.
//
// Transport: local file transport. `git push` to a local path runs
// git-receive-pack — and with it the pre-receive hook — as a child of the
// member's git, so the hook sees the member's environment. The harness sets
// ACB_PUSHER_ROLE / ACB_PUSHER_ID / ACB_PUSHER_EMAIL / ACB_NODE there, the
// same variables server/src/routes/git-http.ts sets for git http-backend
// from the authenticated session, plus ACB_PUSH_POLICY: a permission snapshot
// file per member, in the format git-http writes per request (default: the
// seeded `everyone: read + write`; World.setScopes changes it). The hook is
// rendered by the server's own installer (lib/git-server/hook.ts), so pushes
// run the real TypeScript push checker. That exercises the real hook with the
// real role and write-permission logic without a database, auth server or
// HTTP stack, keeps a sync at a few hundred milliseconds, and needs nothing
// but git and node in CI. What it
// does not cover is the HTTP layer itself (askpass, postBuffer, http-backend
// streaming) — that belongs to the server's git-http tests.
//
// See "Testing Sync" in CLAUDE.md for how to run it and add scenarios.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SimpleGit } from 'simple-git'
import { createGitSync, type GitSync, type GitSyncResult } from '../../electron/sync/git-sync'
import type { SyncDeps } from '../../electron/sync/types'
import { createConfiguredGit } from '../../electron/sync/git-factory'
import { createMessageBoxSyncDialog, type MessageBoxHost, type SyncMessageBoxOptions } from '../../electron/sync/message-box-dialog'
import { createFetchSyncServerApi } from '../../electron/sync/server-api'
import { renderPreReceiveHook } from '../../../server/src/lib/git-server/hook'
import { BARE_REPO_CONFIG } from '../../../server/src/lib/git-server/repo-config'
import { checkoutSelectedDepartments } from '../../electron/sync/first-setup'
import { readSparseConfig, setSparseExclusions, type SparseExclusionsResult } from '../../electron/sync/sparse'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HOOK_PATH = path.resolve(HERE, '../../../server/src/templates/pre-receive-hook.sh')

/** A permission scope as the server's snapshot carries it (server/src/lib/permissions.ts ScopeWithRules). */
export interface HarnessScope {
  id: string
  path: string
  kind: 'company' | 'department' | 'folder'
  departmentId: string | null
  repoId: string | null
  rules: Array<{ id: string; subjectType: 'everyone' | 'role' | 'user'; subjectId: string | null; canRead: boolean; canWrite: boolean }>
}

/** What every company is seeded with: the company scope, everyone: read + write. */
export const DEFAULT_SCOPES: HarnessScope[] = [{
  id: 'scope-company', path: '', kind: 'company', departmentId: null, repoId: null,
  rules: [{ id: 'rule-default', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true }],
}]

/**
 * A string the server's secret scan flags as an AWS access key id. Built at
 * runtime so secret scanners on this repository do not flag the test itself.
 */
export const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')

/** Fixed commit dates make every run (and every commit hash) reproducible. */
export const FIXED_DATE = '2026-01-01T00:00:00+0000'
/** A sync that takes longer than this is reported as a hang. */
export const SYNC_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_TIMEOUT_MS) || 120_000
const VERBOSE = !!process.env.SYNC_HARNESS_VERBOSE
/**
 * For the harness's own reads in a member's clone: never download. In a
 * partial clone git would otherwise fetch a missing blob from the server to
 * answer, which changes what the member has (and fails while offline).
 * Never set for the git that sync itself runs.
 */
export const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: '1' } as const

export type Role = 'owner' | 'admin' | 'member'

/** The .gitignore sync maintains (its essential patterns), for seeding. */
export const ESSENTIAL_GITIGNORE = [
  '.backups/',
  '# AI-generated temp files',
  '.workspace/',
  '# Dependencies',
  'node_modules/',
  '# Secrets — never sync (local only)',
  '.env',
  '.env.*',
  '# Keep templates shared',
  '!.env.example',
  '!.env.sample',
  '# Personal workspaces — never sync (local only)',
  '**/.personal/*',
  '!**/.personal/.gitignore',
  '',
].join('\n')

// ---------------------------------------------------------------------------
// Dialog scripting
// ---------------------------------------------------------------------------

/** Every question sync can ask, keyed by the message box title. */
export const QUESTIONS = {
  sharedNestedRepo: { title: '共有中のフォルダに別のGit情報を検出', buttons: { 'keep-sharing': 0, exclude: 1, cancel: 2 } },
  externalNestedRepo: { title: '外部Gitリポジトリを検出', buttons: { exclude: 0, cancel: 1 } },
  deletedFiles: { title: 'ファイルの削除を検出', buttons: { 'sync-deletions': 0, restore: 1, cancel: 2 } },
  protectedConfig: { title: '管理者だけが変更できるファイル', buttons: { restore: 0, cancel: 1 } },
  writeDenied: { title: '編集できないファイルがあります', buttons: { restore: 0, cancel: 1 } },
} as const

export type QuestionKind = keyof typeof QUESTIONS
export type Answer<K extends QuestionKind> = keyof (typeof QUESTIONS)[K]['buttons']

/** What a member answers when no answer was scripted: the documented default button. */
export const DEFAULT_ANSWERS: { [K in QuestionKind]: Answer<K> } = {
  sharedNestedRepo: 'keep-sharing',
  externalNestedRepo: 'exclude',
  deletedFiles: 'sync-deletions',
  protectedConfig: 'restore',
  writeDenied: 'restore',
}

/** How an injected push failure relates to the server (Member.failNextPush). */
export type PushFault = 'before-server' | 'after-server'
/** What simple-git throws when the block-timeout watchdog kills git. */
export const PUSH_FAULT_MESSAGE = 'block timeout reached'

export interface DialogRecord {
  kind: QuestionKind
  answer: string
  options: SyncMessageBoxOptions
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Git's object id for a blob with these bytes. */
export function blobId(content: Buffer | string): string {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, base, out)
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms (hang)`)), ms)
    }),
  ])
}

/** The raw host pieces the deps are built from (for implementations that need them). */
export interface HarnessHost {
  messageBox: MessageBoxHost
  fetch: typeof fetch
  baseUrl: string
  cookies: string[]
}

export type SyncImplFactory = (deps: SyncDeps, host: HarnessHost) => GitSync

export interface WorldOptions {
  members: Array<{ name: string; role?: Role }>
  /** Files on the server before anyone clones (pushed by an admin, hook active). */
  seed?: Record<string, string | Buffer>
  /** Files pushed before the hook was installed (content that predates a rule). */
  legacySeed?: Record<string, string | Buffer>
  /** Department folders the server API reports (folder protection). Default: none. */
  departments?: string[]
  /** Sync implementation. Default: the real extracted sync. */
  impl?: SyncImplFactory
  /** Per-sync hang limit. Default SYNC_TIMEOUT_MS. */
  syncTimeoutMs?: number
  /** Locale for every git process and the hook. Default 'C' (the server container's). */
  locale?: string
  /** Seed .gitignore. Default: the essential patterns (no first-sync noise). */
  gitignore?: string | null
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export class World {
  readonly root: string
  readonly bare: string
  readonly members: Member[] = []
  readonly departments: string[]
  readonly impl: SyncImplFactory
  readonly syncTimeoutMs: number
  readonly locale: string
  private readonly gitconfig: string
  private scopes: HarnessScope[] = DEFAULT_SCOPES

  private constructor(root: string, options: WorldOptions) {
    this.root = root
    this.bare = path.join(root, 'server', 'company.git')
    this.departments = options.departments ?? []
    this.impl = options.impl ?? createGitSync
    this.syncTimeoutMs = options.syncTimeoutMs ?? SYNC_TIMEOUT_MS
    this.locale = options.locale ?? 'C'
    this.gitconfig = path.join(root, 'gitconfig')
  }

  /** Create a world; it is removed when the test ends (unless SYNC_HARNESS_KEEP is set). */
  static create(t: { after: (fn: () => void) => void } | null, options: WorldOptions): World {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-sync-world-')))
    const world = new World(root, options)
    if (t) {
      t.after(() => {
        if (process.env.SYNC_HARNESS_KEEP) console.log(`[sync-harness] kept world at ${root}`)
        else fs.rmSync(root, { recursive: true, force: true })
      })
    }
    world.init(options)
    return world
  }

  /** Environment for every git process: no user/system config leaks in. */
  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('ACB_') || key.startsWith('GIT_') || key.startsWith('LC_') || key === 'LANG' || key === 'NODE_TEST_CONTEXT') delete env[key]
    }
    return {
      ...env,
      // The pre-receive hook runs in this environment (local transport). The
      // production server runs it in a container with no locale set, i.e. the
      // POSIX locale; pin that so results do not depend on the machine.
      LC_ALL: this.locale,
      GIT_CONFIG_GLOBAL: this.gitconfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
      ...extra,
    }
  }

  /**
   * Append to the members' global git config (the world's stand-in for
   * ~/.gitconfig): e.g. an init.templateDir or core.hooksPath of the
   * member's own, which the app's git must ignore. Applies to the harness's
   * own git commands too, so set it after the members exist.
   */
  appendGlobalConfig(text: string): void {
    fs.appendFileSync(this.gitconfig, text.endsWith('\n') ? text : `${text}\n`)
  }

  /** The app's own git directory (git-factory appGitDirs): main.ts uses <userData>/git. */
  get appGitDir(): string {
    return path.join(this.root, 'app-git')
  }

  /** Run git synchronously with the world's environment. */
  git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
    return execFileSync('git', args, { cwd, env: this.env(extra), stdio: 'pipe', maxBuffer: 1 << 28 }).toString()
  }

  private init(options: WorldOptions): void {
    fs.writeFileSync(this.gitconfig, [
      '[init]', '\tdefaultBranch = main',
      '[core]', '\tautocrlf = false',
      '[commit]', '\tgpgsign = false',
      '[advice]', '\tdetachedHead = false',
      '',
    ].join('\n'))
    fs.mkdirSync(path.dirname(this.bare), { recursive: true })
    this.git(this.root, ['init', '-q', '--bare', '--initial-branch=main', this.bare])
    // configureBareRepo's settings (server/src/lib/git-server/repo-config.ts):
    // force-push / deletion protection, and partial clone for the members
    // created with addPartialMember (http.receivepack is set but unused).
    for (const [key, value] of BARE_REPO_CONFIG) this.git(this.bare, ['config', key, value])

    const seedDir = path.join(this.root, 'seed')
    this.git(this.root, ['clone', '-q', this.bare, seedDir])
    const id = ['-c', 'user.name=seed', '-c', 'user.email=seed@example.com']
    const writeAll = (files: Record<string, string | Buffer>) => {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(seedDir, rel)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, content)
      }
    }
    const gitignore = options.gitignore === undefined ? ESSENTIAL_GITIGNORE : options.gitignore
    writeAll({ 'README.md': 'company\n', ...(gitignore === null ? {} : { '.gitignore': gitignore }) })
    for (const dept of this.departments) writeAll({ [`${dept}/.gitkeep`]: '' })
    writeAll(options.legacySeed ?? {})
    this.git(seedDir, ['add', '-A', '-f', '.'])
    this.git(seedDir, [...id, 'commit', '-q', '-m', 'seed'])
    this.git(seedDir, ['push', '-q', 'origin', 'main'])

    // The hook is installed after the legacy seed, as the server does on
    // startup for repositories that predate it.
    // Rendered like the server installs it (thin caller of the push checker).
    const hookDest = path.join(this.bare, 'hooks', 'pre-receive')
    fs.writeFileSync(hookDest, renderPreReceiveHook({ node: process.execPath }))
    fs.chmodSync(hookDest, 0o755)

    if (options.seed && Object.keys(options.seed).length > 0) {
      writeAll(options.seed)
      this.git(seedDir, ['add', '-A', '.'])
      this.git(seedDir, [...id, 'commit', '-q', '-m', 'seed content'])
      this.git(seedDir, ['push', '-q', 'origin', 'main'], { ACB_PUSHER_ROLE: 'admin', ACB_NODE: process.execPath })
    }
    fs.rmSync(seedDir, { recursive: true, force: true })

    for (const spec of options.members) this.members.push(new Member(this, spec.name, spec.role ?? 'member'))
  }

  /** The permission snapshot git-http would write for this member's pushes. */
  policyFile(userId: string, role: Role): string {
    const dir = path.join(this.root, 'policies')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${userId}.json`)
    fs.writeFileSync(file, JSON.stringify({ version: 1, companyId: 'company', pusher: { id: userId, role }, scopes: this.scopes }))
    return file
  }

  /** Replace the company's permission scopes; takes effect at every member's next push. */
  setScopes(scopes: HarnessScope[]): void {
    this.scopes = scopes
    for (const m of this.members) this.policyFile(`user-${m.name}`, m.role)
  }

  member(name: string): Member {
    const m = this.members.find(x => x.name === name)
    if (!m) throw new Error(`no member ${name}`)
    return m
  }

  /**
   * Add a member who set the company up for the first time with departments
   * picked: a partial clone (blob:none) with the sparse cone set before the
   * first checkout, by the app's own first-setup code. `departments` are the
   * picked folders; the world's departments not picked are not downloaded.
   */
  async addPartialMember(name: string, options: { role?: Role; departments: string[] }): Promise<Member> {
    const m = new Member(this, name, options.role ?? 'member', { partial: true })
    await m.setupPartial(options.departments)
    this.members.push(m)
    return m
  }

  /** Server main tree: path → blob id. */
  serverTree(): Map<string, string> {
    const out = this.git(this.bare, ['ls-tree', '-r', '-z', 'main'])
    const map = new Map<string, string>()
    for (const entry of out.split('\0')) {
      if (!entry) continue
      const [meta, file] = entry.split('\t')
      map.set(file, meta.split(' ')[2])
    }
    return map
  }

  serverFile(rel: string): Buffer | null {
    try {
      return execFileSync('git', ['cat-file', '-p', `main:${rel}`], { cwd: this.bare, env: this.env(), stdio: 'pipe' })
    } catch {
      return null
    }
  }

  serverHead(): string {
    return this.git(this.bare, ['rev-parse', 'main']).trim()
  }

  /** Text of every blob reachable from any server ref (binary blobs skipped). */
  serverTexts(): string[] {
    return this.texts(this.bare, ['--all'])
  }

  /** Text of every blob reachable from `revs` in the repository at `cwd`. */
  texts(cwd: string, revs: string[]): string[] {
    // --missing: a partial member's clone lacks blobs it never needed; they
    // are not that member's work (its own versions are always local).
    const ids = this.git(cwd, ['rev-list', '--objects', '--missing=allow-promisor', ...revs], NO_LAZY_FETCH).split('\n').filter(Boolean).map(l => l.slice(0, 40))
    const types = execFileSync('git', ['cat-file', '--batch-check'], { cwd, env: this.env(NO_LAZY_FETCH), input: ids.join('\n') + '\n', maxBuffer: 1 << 28 })
      .toString().split('\n')
    const blobs = ids.filter((_, i) => types[i]?.split(' ')[1] === 'blob')
    if (blobs.length === 0) return []
    const out = execFileSync('git', ['cat-file', '--batch'], { cwd, env: this.env(NO_LAZY_FETCH), input: blobs.join('\n') + '\n', maxBuffer: 1 << 30 })
    const texts: string[] = []
    let pos = 0
    for (let i = 0; i < blobs.length; i++) {
      const nl = out.indexOf(10, pos)
      const size = Number(out.toString('utf-8', pos, nl).split(' ')[2])
      const body = out.subarray(nl + 1, nl + 1 + size)
      if (!body.includes(0)) texts.push(body.toString('utf-8'))
      pos = nl + 1 + size + 1
    }
    return texts
  }

  /** Every object reachable from any server ref. */
  serverObjects(): Set<string> {
    const out = this.git(this.bare, ['rev-list', '--objects', '--all'])
    return new Set(out.split('\n').filter(Boolean).map(l => l.slice(0, 40)))
  }

  serverBranches(): string[] {
    return this.git(this.bare, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean)
  }

  /** Every member syncs `rounds` times, in order, with default answers. All must succeed. */
  async settle(rounds = 2): Promise<void> {
    for (let r = 1; r <= rounds; r++) {
      for (const m of this.members) {
        m.online().clearAnswers()
        const { result } = await m.sync()
        if (!result.success) {
          throw new Error(`settle round ${r}: ${m.name}'s sync failed: ${JSON.stringify(result)}`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

type KeysOfUnion<T> = T extends unknown ? keyof T : never
/** Every field any sync result shape can carry, all optional except success. */
export type SyncResultView = { [K in KeysOfUnion<GitSyncResult>]?: GitSyncResult extends infer U ? U extends { [P in K]?: infer V } ? V : never : never } & { success: boolean }

export interface SyncOutcome {
  result: SyncResultView
  dialogs: DialogRecord[]
  logs: Array<[string, ...unknown[]]>
  durationMs: number
}

/**
 * Committed work the harness holds sync to. `added` is what the member's
 * change contributed relative to the version it started from (HEAD): the
 * lines it added, for text. A clean three-way merge with a teammate's change
 * never reproduces the member's exact file, so for text it is enough that
 * those lines reach the server together; binaries must survive byte for byte.
 */
export interface Obligation { blob: string; bytes: Buffer; added: string[] | null }

/** Lines of `text` not in `base` (multiset difference); null for binary content. */
export function addedLines(bytes: Buffer, base: Buffer | null): string[] | null {
  if (bytes.includes(0)) return null
  const text = bytes.toString('utf-8')
  if (Buffer.from(text, 'utf-8').compare(bytes) !== 0) return null
  const remaining = new Map<string, number>()
  for (const line of (base?.toString('utf-8') ?? '').split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of text.split('\n')) {
    const n = remaining.get(line) ?? 0
    if (n > 0) remaining.set(line, n - 1)
    else if (line !== '') added.push(line)
  }
  return added
}

export class Member {
  readonly dir: string
  readonly world: World
  readonly name: string
  readonly role: Role
  readonly email: string
  /** False simulates a sync with no window to ask in. */
  hasWindow = true
  /** Every dialog this member was shown, across syncs. */
  readonly dialogHistory: DialogRecord[] = []
  /** Every sync result, across syncs. */
  readonly results: SyncResultView[] = []

  private readonly answers = new Map<QuestionKind, string[]>()
  private readonly sync_: GitSync
  private readonly remoteUrl: string
  private currentDialogs: DialogRecord[] = []
  private currentLogs: Array<[string, ...unknown[]]> = []
  private inFlight = 0
  private pushHooks: Array<() => Promise<void> | void> = []
  private pushFaults: Array<PushFault | null> = []
  /** Paths written since they were last committed by a sync. */
  private readonly pending = new Set<string>()
  /** Latest committed content of every path this member wrote. */
  readonly obligations = new Map<string, Obligation>()

  /** A partial clone (World.addPartialMember): only the picked departments were downloaded. */
  readonly partial: boolean
  /** createGit as sync gets it (the app's git configuration). */
  readonly createGit: (repoPath: string) => SimpleGit

  constructor(world: World, name: string, role: Role, options: { partial?: boolean } = {}) {
    this.world = world
    this.name = name
    this.role = role
    this.partial = !!options.partial
    this.email = `${name}@example.com`
    this.dir = path.join(world.root, 'members', name)
    fs.mkdirSync(path.dirname(this.dir), { recursive: true })
    if (this.partial) {
      // The repository is created by setupPartial, with the app's git (as
      // git:setupCompanyRemote does). A file:// URL, because git ignores
      // --filter for a plain local path (it copies the object store instead).
      fs.mkdirSync(this.dir)
      this.remoteUrl = `file://${world.bare}`
    } else {
      world.git(world.root, ['clone', '-q', world.bare, this.dir])
      this.remoteUrl = world.bare
      this.git(['config', 'user.name', name])
      this.git(['config', 'user.email', this.email])
    }

    const askPass = path.join(world.root, 'askpass.sh')
    if (!fs.existsSync(askPass)) fs.writeFileSync(askPass, '#!/bin/sh\necho "$GIT_TOKEN"\n', { mode: 0o755 })

    const host: HarnessHost = {
      messageBox: {
        hasWindow: () => this.hasWindow,
        showMessageBox: async (options) => ({ response: this.answer(options) }),
      },
      fetch: this.fakeFetch as typeof fetch,
      baseUrl: 'http://acb.test',
      cookies: ['better-auth.session_token=harness.sig'],
    }
    this.createGit = (repoPath: string) => this.wrapGit(createConfiguredGit(repoPath, {
        binary: 'git',
        askPassPath: askPass,
        token: '',
        appGitDir: world.appGitDir,
        baseEnv: world.env(),
        envOverrides: {
          // What git-http.ts sets for the hook from the authenticated session.
          ACB_PUSHER_ROLE: role,
          ACB_PUSHER_ID: `user-${name}`,
          ACB_PUSHER_EMAIL: this.email,
          ACB_NODE: process.execPath,
          ACB_PUSH_POLICY: world.policyFile(`user-${name}`, role),
        },
      }))
    const deps: SyncDeps = {
      createGit: this.createGit,
      dialog: createMessageBoxSyncDialog(host.messageBox),
      api: createFetchSyncServerApi({
        baseUrl: () => host.baseUrl,
        cookies: () => host.cookies,
        fetch: host.fetch,
      }),
      generateCommitMessage: async () => null,
      now: () => new Date(),
      platform: process.platform,
      log: {
        log: (...args: unknown[]) => this.capture('log', args),
        warn: (...args: unknown[]) => this.capture('warn', args),
        error: (...args: unknown[]) => this.capture('error', args),
      },
    }
    this.sync_ = world.impl(deps, host)
  }

  // --- partial clone ---------------------------------------------------------

  /** The app's first setup with these departments picked (sync/first-setup.ts). */
  async setupPartial(selected: string[]): Promise<void> {
    // What git:setupCompanyRemote does before the first setup, with the
    // app's git: an empty repository with origin and the member's identity.
    const git = this.createGit(this.dir)
    await git.raw(['init', '-q', '-b', 'main'])
    await git.addRemote('origin', this.remoteUrl)
    await git.addConfig('user.name', this.name, false, 'local')
    await git.addConfig('user.email', this.email, false, 'local')
    await checkoutSelectedDepartments({
      git,
      repoPath: this.dir,
      branch: 'main',
      departments: this.world.departments,
      selected,
      log: {
        log: (...args: unknown[]) => this.capture('log', args),
        warn: (...args: unknown[]) => this.capture('warn', args),
        error: (...args: unknown[]) => this.capture('error', args),
      },
    })
  }

  /** Settings panel → 追加する: stop excluding a department (downloads it in a partial clone). */
  addDepartment(folder: string): Promise<SparseExclusionsResult> {
    const next = readSparseConfig(this.dir).excluded.filter(f => f !== folder)
    return setSparseExclusions(this.createGit(this.dir), this.dir, next)
  }

  /** Settings panel → 除外する. */
  removeDepartment(folder: string): Promise<SparseExclusionsResult> {
    const next = [...new Set([...readSparseConfig(this.dir).excluded, folder])]
    return setSparseExclusions(this.createGit(this.dir), this.dir, next)
  }

  /** Settings → ダウンロードするフォルダ: uncheck a folder at any depth and apply. */
  excludeFolder(folder: string): Promise<SparseExclusionsResult> {
    return this.removeDepartment(folder)
  }

  /** Settings → ダウンロードするフォルダ: check a folder again and apply (downloads it in a partial clone). */
  includeFolder(folder: string): Promise<SparseExclusionsResult> {
    return this.addDepartment(folder)
  }

  /** Objects reachable from any ref that this clone has never downloaded. */
  missingObjects(): Set<string> {
    const out = this.world.git(this.dir, ['rev-list', '--objects', '--missing=print', '--all'], NO_LAZY_FETCH)
    return new Set(out.split('\n').filter(l => l.startsWith('?')).map(l => l.slice(1).trim()))
  }

  // --- the fake server API ---------------------------------------------------

  private fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/api/me') {
      return json({ success: true, data: { id: `user-${this.name}`, name: this.name, email: this.email } })
    }
    if (/^\/api\/companies\/[^/]+\/departments$/.test(url.pathname)) {
      return json({ success: true, data: this.world.departments.map((folder, i) => ({ id: `d${i}`, folder })) })
    }
    // /api/git/repos/:id — no HTTPS URL to migrate to (local transport).
    return json({ success: false, error: 'not found' }, 404)
  }

  private capture(level: string, args: unknown[]): void {
    this.currentLogs.push([level, ...args])
    if (VERBOSE) console.log(`${new Date().toISOString().slice(17, 23)} [${this.name}] ${level}:`, ...args)
  }

  // --- dialogs ---------------------------------------------------------------

  /** Script the next answer(s) to a question; unscripted questions get the default button. */
  willAnswer<K extends QuestionKind>(kind: K, ...answers: Array<Answer<K>>): this {
    const queue = this.answers.get(kind) ?? []
    queue.push(...(answers as string[]))
    this.answers.set(kind, queue)
    return this
  }

  /** Drop answers scripted but never asked for (the documented defaults apply again). */
  clearAnswers(): this {
    this.answers.clear()
    return this
  }

  private answer(options: SyncMessageBoxOptions): number {
    const kind = (Object.keys(QUESTIONS) as QuestionKind[]).find(k => QUESTIONS[k].title === options.title)
    if (!kind) throw new Error(`unexpected dialog: ${options.title}`)
    const answer = this.answers.get(kind)?.shift() ?? (DEFAULT_ANSWERS[kind] as string)
    const buttons = QUESTIONS[kind].buttons as Record<string, number>
    if (!(answer in buttons)) throw new Error(`no button ${answer} for ${kind}`)
    const record = { kind, answer, options }
    this.currentDialogs.push(record)
    this.dialogHistory.push(record)
    return buttons[answer]
  }

  // --- fault injection -------------------------------------------------------

  /** Run `fn` right before this member's next `git push` (e.g. a teammate pushes first). */
  beforeNextPush(fn: () => Promise<void> | void): this {
    this.pushHooks.push(fn)
    return this
  }

  /**
   * Make this member's next `times` `git push` calls throw. 'after-server':
   * the push really runs and the server accepts it, then the call fails the
   * way the watchdog kills a push whose server-side check outlives it (or a
   * connection that dies after the pack was received). 'before-server': the
   * call fails without the server ever seeing it. `skip` pushes of the
   * same sync run normally first (e.g. to hit a re-push after a rejection).
   */
  failNextPush(fault: PushFault, options: { times?: number; skip?: number } = {}): this {
    for (let i = 0; i < (options.skip ?? 0); i++) this.pushFaults.push(null)
    for (let i = 0; i < (options.times ?? 1); i++) this.pushFaults.push(fault)
    return this
  }

  private wrapGit(git: SimpleGit): SimpleGit {
    return new Proxy(git, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver)
        if (prop === 'push' && typeof value === 'function') {
          return async (...args: unknown[]) => {
            const hook = this.pushHooks.shift()
            if (hook) await hook()
            const fault = this.pushFaults.shift()
            if (fault === 'before-server') throw new Error(PUSH_FAULT_MESSAGE)
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
            if (fault === 'after-server') throw new Error(PUSH_FAULT_MESSAGE)
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  /** Lose the connection to the server (fetch/pull/push fail). */
  offline(): this {
    this.git(['remote', 'set-url', 'origin', path.join(this.world.root, 'unreachable.git')])
    return this
  }

  online(): this {
    this.git(['remote', 'set-url', 'origin', this.remoteUrl])
    return this
  }

  // --- file operations (what a member does in the app) -----------------------

  /** git in this member's clone, for the harness's own reads and setup (never downloads). */
  git(args: string[]): string {
    return this.world.git(this.dir, args, NO_LAZY_FETCH)
  }

  path(rel: string): string {
    return path.join(this.dir, rel)
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.path(rel))
  }

  read(rel: string): Buffer {
    return fs.readFileSync(this.path(rel))
  }

  readText(rel: string): string {
    return fs.readFileSync(this.path(rel), 'utf-8')
  }

  write(rel: string, content: string | Buffer): this {
    const full = this.path(rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    this.pending.add(rel)
    return this
  }

  append(rel: string, text: string): this {
    const before = this.exists(rel) ? this.read(rel) : Buffer.alloc(0)
    return this.write(rel, Buffer.concat([before, Buffer.from(text)]))
  }

  /** Delete a file or folder. The member's own deletion releases what it had written there. */
  remove(rel: string): this {
    fs.rmSync(this.path(rel), { recursive: true, force: true })
    this.forget(rel)
    return this
  }

  rename(from: string, to: string): this {
    const src = this.path(from)
    const dest = this.path(to)
    const files = fs.statSync(src).isDirectory() ? walkFiles(src).map(f => `${to}/${f}`) : [to]
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(src, dest)
    this.forget(from)
    for (const f of files) this.pending.add(f)
    return this
  }

  /** `git init` a folder and commit a file inside it (a nested repository). */
  initNestedRepo(rel: string, files: Record<string, string> = { 'inner.md': `inner of ${rel}\n` }): this {
    for (const [f, c] of Object.entries(files)) this.write(`${rel}/${f}`, c)
    const dir = this.path(rel)
    this.world.git(dir, ['init', '-q'])
    this.world.git(dir, ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'add', '-A'])
    this.world.git(dir, ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'inner'])
    return this
  }

  private forget(rel: string): void {
    const under = (p: string) => p === rel || p.startsWith(`${rel}/`)
    for (const p of [...this.pending]) if (under(p)) this.pending.delete(p)
    for (const p of [...this.obligations.keys()]) if (under(p)) this.obligations.delete(p)
  }

  // --- sync ------------------------------------------------------------------

  /**
   * Press the sync button. Asserts the sync terminates and leaves no
   * rebase / merge / cherry-pick in progress, and records which written
   * content was committed (the "no lost work" obligations).
   */
  async sync(commitMessage = 'Sync from AI Company Builder'): Promise<SyncOutcome> {
    const before = this.snapshotPending()
    // Overlapping clicks share one transcript (the logger is per member).
    if (this.inFlight++ === 0) {
      this.currentDialogs = []
      this.currentLogs = []
    }
    const dialogs = this.currentDialogs
    const logs = this.currentLogs
    const started = Date.now()
    let result: SyncResultView
    try {
      result = await withTimeout(this.sync_(this.dir, 'company', commitMessage), this.world.syncTimeoutMs, `${this.name}'s sync`)
    } finally {
      this.inFlight--
      // A push hook applies to the sync it was set up for; one whose sync
      // never pushed must not fire inside some later, unrelated sync.
      if (this.inFlight === 0) {
        this.pushHooks = []
        this.pushFaults = []
      }
    }
    const durationMs = Date.now() - started
    this.results.push(result)
    if (this.inFlight === 0) this.assertNoOperationInProgress()
    this.recordCommitted(before)
    return { result, dialogs, logs, durationMs }
  }

  assertNoOperationInProgress(): void {
    const gitDir = path.join(this.dir, '.git')
    for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'index.lock']) {
      if (fs.existsSync(path.join(gitDir, marker))) {
        throw new Error(`${this.name}: sync left .git/${marker} behind`)
      }
    }
  }

  private snapshotPending(): Map<string, Obligation> {
    const snap = new Map<string, Obligation>()
    for (const rel of this.pending) {
      try {
        const st = fs.lstatSync(this.path(rel))
        if (!st.isFile()) continue
        const bytes = this.read(rel)
        let base: Buffer | null = null
        try {
          base = execFileSync('git', ['cat-file', '-p', `HEAD:${rel}`], { cwd: this.dir, env: this.world.env(NO_LAZY_FETCH), stdio: 'pipe' })
        } catch { /* new file */ }
        snap.set(rel, { blob: blobId(bytes), bytes, added: addedLines(bytes, base) })
      } catch { /* deleted since */ }
    }
    return snap
  }

  /** Content sync staged ends up in the member's object database. */
  private recordCommitted(snap: Map<string, Obligation>): void {
    if (snap.size === 0) return
    const blobs = [...snap.values()].map(o => o.blob)
    const out = execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: this.dir, env: this.world.env(NO_LAZY_FETCH), input: blobs.join('\n') + '\n',
    }).toString().split('\n')
    let i = 0
    for (const [rel, ob] of snap) {
      const line = out[i++] ?? ''
      if (line.endsWith('missing')) continue
      this.obligations.set(rel, ob)
      // Still pending only if it changed again after this snapshot.
      try {
        if (blobId(this.read(rel)) === ob.blob) this.pending.delete(rel)
      } catch {
        this.pending.delete(rel)
      }
    }
  }

  /** Blob ids under every .backups/<folder>/ that has its _metadata.json. */
  backupBlobs(): Set<string> {
    const set = new Set<string>()
    const root = this.path('.backups')
    if (!fs.existsSync(root)) return set
    for (const folder of fs.readdirSync(root)) {
      const dir = path.join(root, folder)
      if (!fs.existsSync(path.join(dir, '_metadata.json'))) continue
      for (const f of walkFiles(dir)) {
        if (f === '_metadata.json') continue
        set.add(blobId(fs.readFileSync(path.join(dir, f))))
      }
    }
    return set
  }

  /** Parsed _metadata.json of every backup folder, oldest first. */
  backups(): Array<{ folder: string; metadata: Record<string, unknown>; files: string[] }> {
    const root = this.path('.backups')
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root).sort().map(folder => {
      const dir = path.join(root, folder)
      const metaPath = path.join(dir, '_metadata.json')
      return {
        folder,
        metadata: fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {},
        files: walkFiles(dir).filter(f => f !== '_metadata.json').sort(),
      }
    })
  }

  isIgnored(rel: string): boolean {
    try {
      this.git(['check-ignore', '-q', '--', rel])
      return true
    } catch {
      return false
    }
  }

  head(): string {
    return this.git(['rev-parse', 'HEAD']).trim()
  }

  hasPendingPush(): boolean {
    return fs.existsSync(path.join(this.dir, '.git', 'PENDING_PUSH'))
  }
}
