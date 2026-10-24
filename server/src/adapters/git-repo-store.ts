/**
 * RepoStore on the local disk: bare repositories under REPOS_DIR, the
 * server's working clones under WORKDIR_DIR (lib/config.ts). Every git call
 * is asynchronous (lib/git-exec.ts): these run inside request handlers of the
 * process that also serves every member's git-http traffic.
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { RepoStore } from '../ports/repo-store'
import { initBareRepo, internalGitEnv } from '../lib/git-server'
import { gitAsync } from '../lib/git-exec'
import { withCompanyLock } from '../lib/company-lock'
import { REPOS_DIR, WORKDIR_DIR } from '../lib/config'

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

export function localRepoStore(): RepoStore {
  return { createCompanyRepo, seedCompanyRepo }
}
