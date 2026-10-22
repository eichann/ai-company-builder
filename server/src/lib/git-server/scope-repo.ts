/**
 * Scope repositories: one bare repository per private folder.
 *
 * Layout (under REPOS_DIR, next to the company repository):
 *
 *   <companyId>.git                         the company (parent) repository
 *   <companyId>.scopes/<repoId>.git         one per private folder
 *
 * The `.scopes` directory is not `*.git`, so the company route of git-http
 * (`/:repo` = `<companyId>.git`, sanitised to [A-Za-z0-9_-]) can never reach a
 * scope repository; scope repositories are served only by the scope routes,
 * which authorise by READ / WRITE permission on the private folder.
 *
 * A scope repository carries exactly the company repository's configuration
 * (BARE_REPO_CONFIG: deny non-fast-forwards and deletes, partial clone) and
 * the same pre-receive hook. It is created with one root commit holding a
 * `.gitignore` with the essentials sync keeps in every repository.
 *
 * Everything here is asynchronous: it runs inside request handlers of the
 * process that serves all git-http traffic.
 */
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { installPreReceiveHook } from './hook'
import { BARE_REPO_CONFIG } from './repo-config'

const execFileAsync = promisify(execFile)

export const SCOPE_REPOS_SUFFIX = '.scopes'

/** Identity of the commits the server makes itself. */
export const SERVER_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'AI Company Builder',
  GIT_AUTHOR_EMAIL: 'system@ai-company-builder.local',
  GIT_COMMITTER_NAME: 'AI Company Builder',
  GIT_COMMITTER_EMAIL: 'system@ai-company-builder.local',
}

/**
 * The scope repository's first commit: the patterns sync keeps in every
 * repository's root .gitignore (client/electron/sync/git-sync.ts, the
 * "essential patterns"), so a reader's first sync has nothing to add.
 */
export const SCOPE_REPO_GITIGNORE = [
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

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function scopeReposDir(reposDir: string, companyId: string): string {
  if (!ID_RE.test(companyId)) throw new Error('invalid company id')
  return join(reposDir, `${companyId}${SCOPE_REPOS_SUFFIX}`)
}

export function scopeRepoPath(reposDir: string, companyId: string, repoId: string): string {
  if (!ID_RE.test(repoId)) throw new Error('invalid repository id')
  return join(scopeReposDir(reposDir, companyId), `${repoId}.git`)
}

export async function gitAsync(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
  const child = execFileAsync('git', args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) },
  })
  if (opts.input !== undefined) {
    child.child.stdin?.end(opts.input)
  }
  const { stdout } = await child
  return stdout
}

/** Standard configuration (as configureBareRepo), asynchronously. */
export async function configureBareRepoAsync(repoPath: string): Promise<void> {
  for (const [key, value] of BARE_REPO_CONFIG) {
    await gitAsync(['-C', repoPath, 'config', key, value])
  }
  if (!installPreReceiveHook(repoPath)) throw new Error('cannot install the pre-receive hook')
}

/**
 * Create the bare repository for a private folder with its first commit.
 * Fails if the directory already exists. On failure nothing is left behind.
 */
export async function createScopeRepo(repoPath: string, message: string): Promise<string> {
  if (existsSync(repoPath)) throw new Error('scope repository already exists')
  mkdirSync(repoPath, { recursive: true })
  try {
    await gitAsync(['init', '--bare', '--initial-branch=main', repoPath])
    await configureBareRepoAsync(repoPath)
    const blob = (await gitAsync(['-C', repoPath, 'hash-object', '-w', '--stdin'], { input: SCOPE_REPO_GITIGNORE })).trim()
    const tree = (await gitAsync(['-C', repoPath, 'mktree'], { input: `100644 blob ${blob}\t.gitignore\n` })).trim()
    const commit = (await gitAsync(['-C', repoPath, 'commit-tree', tree, '-m', message], { env: SERVER_GIT_IDENTITY })).trim()
    // update-ref runs no hook: the server's own first commit
    await gitAsync(['-C', repoPath, 'update-ref', 'refs/heads/main', commit, ''])
    return commit
  } catch (err) {
    await rm(repoPath, { recursive: true, force: true })
    throw err
  }
}

/** Remove a scope repository (make-public, or a creation rolled back). */
export async function removeScopeRepo(repoPath: string): Promise<void> {
  await rm(repoPath, { recursive: true, force: true })
}

/** Every scope repository under `reposDir` (for startup configuration). */
export function listAllScopeRepos(reposDir: string): string[] {
  if (!existsSync(reposDir)) return []
  const out: string[] = []
  for (const dir of readdirSync(reposDir)) {
    if (!dir.endsWith(SCOPE_REPOS_SUFFIX)) continue
    const full = join(reposDir, dir)
    try {
      for (const name of readdirSync(full)) if (name.endsWith('.git')) out.push(join(full, name))
    } catch {
      // not a directory
    }
  }
  return out
}
