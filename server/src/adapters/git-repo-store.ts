/**
 * RepoStore on the local disk: bare repositories under REPOS_DIR, the
 * server's working clones under WORKDIR_DIR (lib/config.ts). Every git call
 * is asynchronous (lib/git-exec.ts): these run inside request handlers of the
 * process that also serves every member's git-http traffic.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { mkdir, readdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { RepoStore } from '../ports/repo-store'
import { initBareRepo, internalGitEnv } from '../lib/git-server'
import { gitAsync } from '../lib/git-exec'
import { withCompanyLock } from '../lib/company-lock'
import { companyRepoPath, REPOS_DIR, WORKDIR_DIR } from '../lib/config'
import { countFilesInRepoFolder, listFoldersFromRepo } from '../lib/repo-folders'

// Watchdog for each git command of the seeding. The push runs the
// pre-receive checker; a hung checker must fail the seeding, not leave the
// request (and the company's working-clone lock) waiting forever. Generous:
// nothing else waits on it now, and the checker (node + tsx) has taken over a
// minute for this tiny push on a loaded host — cutting it would leave the
// company without its folders.
const SEED_GIT_TIMEOUT_MS = { local: 60_000, push: 300_000 }

/** Tests only: shorten the seeding watchdog. Returns a restore function. */
export function setSeedGitTimeoutsForTests(timeouts: { local: number; push: number }): () => void {
  const previous = { ...SEED_GIT_TIMEOUT_MS }
  Object.assign(SEED_GIT_TIMEOUT_MS, timeouts)
  return () => { Object.assign(SEED_GIT_TIMEOUT_MS, previous) }
}

async function createCompanyRepo(companyId: string): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true })
  const repoPath = join(REPOS_DIR, `${companyId}.git`)
  if (!existsSync(repoPath)) {
    // Same setup as every bare repository (lib/git-server): branch main, HTTP
    // push, force-push protection, pre-receive hook.
    await initBareRepo(repoPath)
  }
  return repoPath
}

// Seed the department folders into the company repo, so the filesystem
// (source of truth) matches the department rows. Without this,
// GET /departments returns an empty list (it only returns rows whose folder
// exists on the shared branch).
//
// Asynchronous, in the working clone, under the company lock like every
// other working-clone mutation (departments.ts): this request shares the
// process with every member's git-http traffic, and the synchronous version
// blocked all of it while the push's pre-receive checker ran — with no limit.
function seedCompanyRepo(companyId: string, bareRepoPath: string, departmentFolders: string[]): Promise<void> {
  return withCompanyLock(companyId, async () => {
    const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
    const workDir = join(WORKDIR_DIR, sanitizedId)
    const local = { timeoutMs: SEED_GIT_TIMEOUT_MS.local }

    await mkdir(WORKDIR_DIR, { recursive: true })
    if (!existsSync(workDir)) {
      await gitAsync(['clone', bareRepoPath, workDir], local)
    }
    // The bare repo is empty here; pin the unborn branch to main regardless of
    // the host git's init.defaultBranch
    await gitAsync(['-C', workDir, 'checkout', '-B', 'main'], local)

    // Normalize line endings to LF on every platform: scripts inside shared
    // skills break under Git Bash on Windows when checked out as CRLF.
    // (text=auto only applies to files git detects as text — binaries are safe.)
    await writeFile(
      join(workDir, '.gitattributes'),
      '# AI Company Builder: テキストファイルの改行コードを全OSでLFに統一\n* text=auto eol=lf\n'
    )

    // Same folder layout as the create-department endpoint in departments.ts
    for (const folder of departmentFolders) {
      const folderPath = join(workDir, folder)
      await mkdir(folderPath, { recursive: true })
      await writeFile(join(folderPath, '.gitkeep'), '')

      const personalDir = join(folderPath, '.personal')
      await mkdir(personalDir, { recursive: true })
      await writeFile(join(personalDir, '.gitignore'), '# Personal workspace — not synced\n*\n!.gitignore\n')
    }

    await gitAsync(['-C', workDir, 'add', '-A'], local)
    // Explicit identity: seeding must not depend on host-level git config
    await gitAsync([
      '-C', workDir,
      '-c', 'user.name=AI Company Builder',
      '-c', 'user.email=system@ai-company-builder.local',
      'commit', '-m', 'Initialize default department folders',
    ], local)
    // The server's own push: marked so the hook skips the write-permission check
    await gitAsync(['-C', workDir, 'push', 'origin', 'main'], {
      env: internalGitEnv(),
      timeoutMs: SEED_GIT_TIMEOUT_MS.push,
    })
  })
}

// ============================================================================
// Department folders in the working clone (routes/departments.ts)
//
// Everything here is asynchronous: a synchronous git call (the old
// `execFileSync('git', ['pull', ...])` on every list request) froze the whole
// server — 42 s on a 7.7 GB working clone — for everyone. Reading the shared
// branch: lib/repo-folders.ts.
// ============================================================================

// git in the working clone. internalGitEnv: the pushes made here (department
// folder create / rename / delete) are the server's own — the hook skips the
// write-permission check for them; every content rule still applies.
function git(args: string[]): Promise<string> {
  return gitAsync(args, { env: { ...internalGitEnv(), GIT_TERMINAL_PROMPT: '0' } })
}

// The working directory for a company, up to date with the bare repo.
// Mutations only, and only inside withCompanyLock.
async function getWorkingDir(companyId: string): Promise<string> {
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  const workDir = join(WORKDIR_DIR, sanitizedId)
  const bareRepo = companyRepoPath(companyId)

  if (!existsSync(bareRepo)) {
    throw new Error('Repository not found')
  }

  if (!existsSync(workDir)) {
    // Clone from bare repo
    await git(['clone', bareRepo, workDir])
  } else {
    // Ensure remote URL points to correct bare repo path (fixes server migration issues)
    try {
      const currentUrl = (await git(['-C', workDir, 'remote', 'get-url', 'origin'])).trim()
      if (currentUrl !== bareRepo) {
        await git(['-C', workDir, 'remote', 'set-url', 'origin', bareRepo])
      }
    } catch {
      // Ignore - remote might not exist yet
    }

    // Pull latest changes
    try {
      await git(['-C', workDir, 'pull', 'origin', 'main'])
    } catch {
      try {
        await git(['-C', workDir, 'pull', 'origin', 'master'])
      } catch {
        // Ignore pull errors (might be empty repo)
      }
    }
  }

  return workDir
}

// Commit and push changes
async function commitAndPush(workDir: string, message: string): Promise<void> {
  try {
    await git(['-C', workDir, 'add', '-A'])
    await git(['-C', workDir, 'commit', '-m', message, '--allow-empty'])
    try {
      await git(['-C', workDir, 'push', 'origin', 'HEAD'])
    } catch {
      // Ignore push errors (remote might not be available)
    }
  } catch (error) {
    console.error('Git commit/push error:', error)
    // Don't throw - commit might fail if nothing changed
  }
}

// Count files in a directory of the working clone (recursive)
async function countFilesInDir(dirPath: string): Promise<{ files: number; folders: number }> {
  let files = 0
  let folders = 0

  async function count(path: string) {
    if (!existsSync(path)) return
    for (const item of await readdir(path)) {
      if (item.startsWith('.')) continue
      const itemPath = join(path, item)
      if ((await stat(itemPath)).isDirectory()) {
        folders++
        await count(itemPath)
      } else {
        files++
      }
    }
  }

  await count(dirPath)
  return { files, folders }
}

function createDepartmentFolder(companyId: string, folder: string, commitMessage: string): Promise<boolean> {
  return withCompanyLock(companyId, async () => {
    const workDir = await getWorkingDir(companyId)
    const folderPath = join(workDir, folder)

    if (existsSync(folderPath)) {
      return false
    }

    // Folder with .gitkeep and the .personal workspace (gitignored)
    mkdirSync(folderPath, { recursive: true })
    writeFileSync(join(folderPath, '.gitkeep'), '')
    const personalDir = join(folderPath, '.personal')
    mkdirSync(personalDir, { recursive: true })
    writeFileSync(join(personalDir, '.gitignore'), '# Personal workspace — not synced\n*\n!.gitignore\n')

    await commitAndPush(workDir, commitMessage)
    return true
  })
}

function renameDepartmentFolder(companyId: string, from: string, to: string, commitMessage: string): Promise<boolean> {
  return withCompanyLock(companyId, async () => {
    const workDir = await getWorkingDir(companyId)
    const oldPath = join(workDir, from)
    const newPath = join(workDir, to)

    if (existsSync(newPath)) {
      return false
    }

    if (existsSync(oldPath)) {
      // git mv for proper tracking
      await git(['-C', workDir, 'mv', from, to])
      await commitAndPush(workDir, commitMessage)
    }
    return true
  })
}

function deleteDepartmentFolder(companyId: string, folder: string, commitMessage: string): Promise<{ deletedFiles: number; deletedFolders: number }> {
  return withCompanyLock(companyId, async () => {
    const workDir = await getWorkingDir(companyId)
    const folderPath = join(workDir, folder)

    if (!existsSync(folderPath)) {
      return { deletedFiles: 0, deletedFolders: 0 }
    }

    const counts = await countFilesInDir(folderPath)
    await rm(folderPath, { recursive: true, force: true })
    await git(['-C', workDir, 'add', '-A'])
    await commitAndPush(workDir, commitMessage)
    return { deletedFiles: counts.files, deletedFolders: counts.folders }
  })
}

export function localRepoStore(): RepoStore {
  if (!existsSync(WORKDIR_DIR)) {
    mkdirSync(WORKDIR_DIR, { recursive: true })
  }
  return {
    createCompanyRepo,
    seedCompanyRepo,
    companyRepoExists: companyId => existsSync(companyRepoPath(companyId)),
    listRootFolders: listFoldersFromRepo,
    countFilesInFolder: countFilesInRepoFolder,
    createDepartmentFolder,
    renameDepartmentFolder,
    deleteDepartmentFolder,
  }
}
