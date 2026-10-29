/**
 * RepoStore on the local disk: bare repositories under REPOS_DIR
 * (lib/config.ts). Reads come from the shared branch (lib/repo-folders.ts);
 * the server's own changes — company seeding, department folder create /
 * rename / delete — are commits built in the bare repository itself and
 * published through the push checker (lib/bare-commit.ts): no working tree,
 * so they take about the same time whatever the company's size. Every git
 * call is asynchronous (lib/git-exec.ts): these run inside request handlers
 * of the process that also serves every member's git-http traffic.
 */
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import type { RepoStore } from '../ports/repo-store'
import { initBareRepo } from '../lib/git-server'
import { withCompanyLock } from '../lib/company-lock'
import { companyRepoPath, REPOS_DIR } from '../lib/config'
import { commitRootEdit, writeBlob, writeTree, type CommitIdentity, type TreeEntry } from '../lib/bare-commit'
import { countFilesInRepoFolder, countFilesInTree, listFoldersFromRepo, listRepoSubfolders, resolveRepoFolder } from '../lib/repo-folders'
import { listPrivateSubfolders } from '../lib/private-folders'
import { nameKey } from '../../shared/core/paths'

// Watchdog for each git command of the server's commits. The push runs the
// pre-receive checker; a hung checker must fail the request, not leave it
// (and the company lock) waiting forever. Generous: the checker (node + tsx)
// has taken over a minute for a tiny push on a loaded host — cutting it would
// leave a new company without its folders.
const GIT_TIMEOUT_MS = { local: 60_000, push: 300_000 }

/** Tests only: shorten the watchdog. Returns a restore function. */
export function setRepoGitTimeoutsForTests(timeouts: { local: number; push: number }): () => void {
  const previous = { ...GIT_TIMEOUT_MS }
  Object.assign(GIT_TIMEOUT_MS, timeouts)
  return () => { Object.assign(GIT_TIMEOUT_MS, previous) }
}

// The identities the server's commits always had: the seed set its own, the
// department commits used the image's global git config (server/Dockerfile).
// Both are explicit now, independent of the host's git config.
const SEED_IDENTITY: CommitIdentity = { name: 'AI Company Builder', email: 'system@ai-company-builder.local' }
const DEPARTMENT_IDENTITY: CommitIdentity = { name: 'AI Company Builder', email: 'system@ai-company-builder' }

// Normalize line endings to LF on every platform: scripts inside shared
// skills break under Git Bash on Windows when checked out as CRLF.
// (text=auto only applies to files git detects as text — binaries are safe.)
const GITATTRIBUTES = '# AI Company Builder: テキストファイルの改行コードを全OSでLFに統一\n* text=auto eol=lf\n'
const PERSONAL_GITIGNORE = '# Personal workspace — not synced\n*\n!.gitignore\n'

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

// A department folder's tree: `.gitkeep` and the `.personal` workspace whose
// `.gitignore` keeps everything else in it on the member's machine.
async function departmentTree(bareRepo: string): Promise<string> {
  const local = GIT_TIMEOUT_MS.local
  const gitkeep = await writeBlob(bareRepo, '', local)
  const gitignore = await writeBlob(bareRepo, PERSONAL_GITIGNORE, local)
  const personal = await writeTree(bareRepo, [{ mode: '100644', type: 'blob', oid: gitignore, name: '.gitignore' }], local)
  return writeTree(bareRepo, [
    { mode: '100644', type: 'blob', oid: gitkeep, name: '.gitkeep' },
    { mode: '040000', type: 'tree', oid: personal, name: '.personal' },
  ], local)
}

// A department folder is one root entry. Its name as the DB stores it (NFC)
// may be spelled NFD in the repository (a Mac client created it): exact match
// first, then NFC. No case folding here — the source must be unambiguous.
function findEntry(entries: TreeEntry[], folder: string): TreeEntry | undefined {
  return entries.find(e => e.name === folder)
    ?? entries.find(e => e.name.normalize('NFC') === folder.normalize('NFC'))
}

// A name is taken when a root entry (folder or file) has the same nameKey:
// NFC, A–Z folded — "Sales" and "sales" are one folder on members' Macs and
// Windows PCs (shared/core/paths.ts, as the rest of the server compares).
function nameTaken(entries: TreeEntry[], name: string, except?: TreeEntry): boolean {
  const key = nameKey(name)
  return entries.some(e => e !== except && nameKey(e.name) === key)
}

// A department folder is a root folder: one path segment.
function assertRootFolder(folder: string): void {
  if (!folder || folder.includes('/') || folder === '.' || folder === '..') {
    throw new Error('A department folder must be a single root folder name')
  }
}

function requireRepo(companyId: string): string {
  const bareRepo = companyRepoPath(companyId)
  if (!existsSync(bareRepo)) throw new Error('Repository not found')
  return bareRepo
}

// Seed the department folders into the company repo, so the filesystem
// (source of truth) matches the department rows. Without this,
// GET /departments returns an empty list (it only returns rows whose folder
// exists on the shared branch). Asynchronous and under the company lock: this
// request shares the process with every member's git-http traffic.
function seedCompanyRepo(companyId: string, bareRepoPath: string, departmentFolders: string[]): Promise<void> {
  return withCompanyLock(companyId, () => commitRootEdit(bareRepoPath, {
    message: 'Initialize default department folders',
    identity: SEED_IDENTITY,
    timeouts: GIT_TIMEOUT_MS,
  }, async entries => {
    departmentFolders.forEach(assertRootFolder)
    // A new repository is empty; on an existing branch the files are added
    // on top, as the old working-clone seeding did.
    const local = GIT_TIMEOUT_MS.local
    const attributes = await writeBlob(bareRepoPath, GITATTRIBUTES, local)
    const folder = await departmentTree(bareRepoPath)
    const replaced = new Set(['.gitattributes', ...departmentFolders])
    const next = entries.filter(e => !replaced.has(e.name))
    next.push({ mode: '100644', type: 'blob', oid: attributes, name: '.gitattributes' })
    for (const name of departmentFolders) next.push({ mode: '040000', type: 'tree', oid: folder, name })
    return { entries: next, result: undefined }
  }))
}

// ============================================================================
// Department folders (services/departments.ts)
//
// Root-tree edits in the bare repository, under the company lock. The old
// working clone (`data/workdirs/<companyId>`) had to `git pull` and
// `git add -A` the whole company first: a 1 MB rename took 119 s in
// production. Reading the shared branch: lib/repo-folders.ts.
// ============================================================================

function departmentCommit(companyId: string, message: string) {
  return { bareRepo: requireRepo(companyId), options: { message, identity: DEPARTMENT_IDENTITY, timeouts: GIT_TIMEOUT_MS } }
}

function createDepartmentFolder(companyId: string, folder: string, commitMessage: string): Promise<boolean> {
  return withCompanyLock(companyId, async () => {
    assertRootFolder(folder)
    const { bareRepo, options } = departmentCommit(companyId, commitMessage)
    return commitRootEdit(bareRepo, options, async entries => {
      if (nameTaken(entries, folder)) return { result: false }
      const tree = await departmentTree(bareRepo)
      return { entries: [...entries, { mode: '040000', type: 'tree', oid: tree, name: folder }], result: true }
    })
  })
}

function renameDepartmentFolder(companyId: string, from: string, to: string, commitMessage: string): Promise<boolean> {
  return withCompanyLock(companyId, async () => {
    assertRootFolder(from)
    assertRootFolder(to)
    const { bareRepo, options } = departmentCommit(companyId, commitMessage)
    return commitRootEdit(bareRepo, options, async entries => {
      const source = findEntry(entries, from)
      // The target is taken unless it is the source itself (a case-only rename)
      if (nameTaken(entries, to, source)) return { result: false }
      // Nothing to move: the row is renamed alone, as before
      if (!source) return { result: true }
      // The folder's tree is reused as it is: nothing is read or rewritten below it
      return { entries: entries.map(e => e === source ? { ...e, name: to } : e), result: true }
    })
  })
}

function deleteDepartmentFolder(companyId: string, folder: string, commitMessage: string): Promise<{ deletedFiles: number; deletedFolders: number }> {
  return withCompanyLock(companyId, async () => {
    assertRootFolder(folder)
    const { bareRepo, options } = departmentCommit(companyId, commitMessage)
    return commitRootEdit(bareRepo, options, async entries => {
      const target = findEntry(entries, folder)
      if (!target) return { result: { deletedFiles: 0, deletedFolders: 0 } }
      // The counts the old code made on the checkout: hidden entries skipped
      // (a gitlink checked out as an empty directory: nothing inside)
      const counts = target.type === 'tree' ? await countFilesInTree(bareRepo, target.oid) : { files: 0, folders: 0 }
      return {
        entries: entries.filter(e => e !== target),
        result: { deletedFiles: counts.files, deletedFolders: counts.folders },
      }
    })
  })
}

export function localRepoStore(): RepoStore {
  return {
    createCompanyRepo,
    seedCompanyRepo,
    companyRepoExists: companyId => existsSync(companyRepoPath(companyId)),
    listRootFolders: listFoldersFromRepo,
    countFilesInFolder: countFilesInRepoFolder,
    resolveFolder: resolveRepoFolder,
    listSubfolders: listRepoSubfolders,
    listPrivateSubfolders,
    createDepartmentFolder,
    renameDepartmentFolder,
    deleteDepartmentFolder,
  }
}
