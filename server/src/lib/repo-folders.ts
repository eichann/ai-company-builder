/**
 * Folders on the shared branch of a company's bare repository, read
 * straight from the bare repository (no working clone, no pull): the
 * department list and stats (routes/departments.ts), and folder paths the
 * permission editor and private folders resolve (routes/permission-rules.ts,
 * routes/private-folders.ts).
 *
 * Read-only and asynchronous: these run inside request handlers of the
 * process that also serves every member's git-http traffic. A synchronous
 * `git pull` of the working clone on every list request froze the whole
 * server — 42 s on a 7.7 GB clone — for everyone.
 */
import { existsSync } from 'fs'
import { companyRepoPath } from './config'
import { gitAsync } from './git-exec'

// The shared branch of the bare repo: main, or master for a repo created
// before the branch name was pinned (the old working-clone pull fell back the
// same way). null while the repo has no commits.
async function resolveSharedBranch(bareRepo: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    try {
      await gitAsync(['-C', bareRepo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
      return `refs/heads/${branch}`
    } catch {
      // Try the next name
    }
  }
  return null
}

interface TreeEntry { type: string; path: string }

// `git ls-tree -z` records: "<mode> <type> <object>\t<path>\0" (-z: paths are
// not quoted, so Japanese names come through as they are)
function parseLsTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    entries.push({ type: record.slice(0, tab).split(' ')[1], path: record.slice(tab + 1) })
  }
  return entries
}

// Helper: List department folders — the non-hidden directories at the root of
// the shared branch, read straight from the bare repo. This is what a
// checkout of that branch shows (a gitlink checks out as an empty directory),
// and it is always current: no working clone, no pull.
export async function listFoldersFromRepo(companyId: string): Promise<string[]> {
  const bareRepo = companyRepoPath(companyId)
  if (!existsSync(bareRepo)) {
    throw new Error('Repository not found')
  }
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return [] // Empty repo: nothing to check out
  return parseLsTree(await gitAsync(['-C', bareRepo, 'ls-tree', '-z', ref]))
    .filter(e => (e.type === 'tree' || e.type === 'commit') && !e.path.startsWith('.'))
    .map(e => e.path)
}

// Helper: Count files and folders in a department folder of the shared
// branch, skipping hidden entries and everything below them — the count
// countFilesInDir makes on a checkout. null when the folder does not exist
// (or is not a directory).
export async function countFilesInRepoFolder(companyId: string, folder: string): Promise<{ files: number; folders: number } | null> {
  const bareRepo = companyRepoPath(companyId)
  if (!existsSync(bareRepo)) return null
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return null
  try {
    const type = (await gitAsync(['-C', bareRepo, 'cat-file', '-t', `${ref}:${folder}`])).trim()
    if (type !== 'tree') return null
  } catch {
    return null
  }

  let files = 0
  let folders = 0
  for (const entry of parseLsTree(await gitAsync(['-C', bareRepo, 'ls-tree', '-r', '-t', '-z', `${ref}:${folder}`]))) {
    if (entry.path.split('/').some(part => part.startsWith('.'))) continue
    if (entry.type === 'tree' || entry.type === 'commit') folders++
    else files++
  }
  return { files, folders }
}

// Directory entries (trees and gitlinks, hidden ones skipped) of `dir` on the
// shared branch, '' being the root. null when the repo, branch or directory
// does not exist.
async function listRepoDirectory(companyId: string, dir: string): Promise<string[] | null> {
  const bareRepo = companyRepoPath(companyId)
  if (!existsSync(bareRepo)) return null
  const ref = await resolveSharedBranch(bareRepo)
  if (!ref) return null
  const target = dir === '' ? ref : `${ref}:${dir}`
  if (dir !== '') {
    try {
      if ((await gitAsync(['-C', bareRepo, 'cat-file', '-t', target])).trim() !== 'tree') return null
    } catch {
      return null
    }
  }
  return parseLsTree(await gitAsync(['-C', bareRepo, 'ls-tree', '-z', target]))
    .filter(e => (e.type === 'tree' || e.type === 'commit') && !e.path.startsWith('.'))
    .map(e => e.path)
}

/**
 * Resolve a repo-relative folder path (NFC, '/'-separated, as stored in
 * `scopes`) against the shared branch of the bare repo, segment by segment,
 * comparing names in NFC: a Mac client commits Japanese names in NFD, so a
 * byte-wise lookup of the NFC path would miss them. Returns the path as the
 * repository spells it, or null when some segment is not a (non-hidden)
 * folder there. '' (the company root) resolves to ''.
 */
export async function resolveRepoFolder(companyId: string, path: string): Promise<string | null> {
  let stored = ''
  for (const segment of path.split('/').filter(Boolean)) {
    const entries = await listRepoDirectory(companyId, stored)
    const match = entries?.find(e => e.normalize('NFC') === segment.normalize('NFC'))
    if (!match) return null
    stored = stored ? `${stored}/${match}` : match
  }
  return stored
}

/** Sub-folder names (NFC, sorted) of an existing folder on the shared branch; null when it does not exist. */
export async function listRepoSubfolders(companyId: string, path: string): Promise<string[] | null> {
  const stored = await resolveRepoFolder(companyId, path)
  if (stored === null) return null
  const entries = await listRepoDirectory(companyId, stored)
  if (entries === null) return null
  return entries.map(e => e.normalize('NFC')).sort((a, b) => a.localeCompare(b, 'ja'))
}
