// Which kind of setup a chosen company folder gets (CompanySelector, both the
// 「既存のフォルダを開く」 and the 「新しく作成」 path, and main.ts's
// git:setupCompanyRemote as the backstop).
//
//   folder                                         remote has commits   remote empty
//   ─────────────────────────────────────────────  ───────────────────  ──────────────
//   clone of this company with commits             existingClone        existingClone
//   clone of another remote                        refuse               refuse
//   repo without origin, with commits              refuse               uploadExisting
//   empty (or no .git, no commits, only OS files)  firstSetup           uploadExisting
//   no commits yet but the member's own files      refuse               uploadExisting
//
// firstSetup is the department picker + partial clone (./first-setup.ts); an
// existing clone is opened as before and never converted. A non-empty folder
// without a clone is refused while the company has content: the checkout
// would either stop on a name that exists on both sides (leaving a
// half-set-up repository) or mix the member's unrelated files into the
// company folder, where the next sync's `git add .` shares them with
// everyone. Nothing in the folder is touched; the member picks an empty
// folder (or 「新しく作成」, which makes one). When the company has no
// content yet, the folder's files become its first commit — the owner's
// first upload, as before.

import fs from 'node:fs'
import path from 'node:path'

export interface CompanyFolderFacts {
  /** `.git` (a directory or a gitfile) at the folder itself, not in a parent. */
  hasGitDir: boolean
  /** remote.origin.url from the folder's own config, or null. */
  originUrl: string | null
  /** HEAD resolves to a commit. */
  hasLocalCommits: boolean
  /** Anything besides `.git` and files the OS drops into folders (.DS_Store, …). */
  hasUserFiles: boolean
  /** The company's server repository has at least one branch. */
  remoteHasCommits: boolean
}

export type CompanyFolderDecision =
  | { action: 'firstSetup' }
  | { action: 'existingClone' }
  | { action: 'uploadExisting' }
  | { action: 'refuse'; reason: 'otherRemote' | 'unrelatedRepo' | 'notEmpty'; message: string }

export const OTHER_REMOTE_MESSAGE =
  'このフォルダは別の会社（または別のプロジェクト）と同期しているため使えません。空のフォルダを選ぶか、「新しく作成」を使ってください。'
export const UNRELATED_REPO_MESSAGE =
  'このフォルダには、この会社とは別の履歴があるため使えません。空のフォルダを選ぶか、「新しく作成」を使ってください。'
export const NOT_EMPTY_MESSAGE =
  'このフォルダにはすでにファイルがあるため使えません（中のファイルはそのままです）。空のフォルダを選ぶか、「新しく作成」を使ってください。'

/** Files the OS creates on its own; they do not make a folder "non-empty". */
const OS_FILES = new Set(['.ds_store', '.localized', 'thumbs.db', 'desktop.ini', '.git'])

function remotePath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!/^(https?|file):$/.test(parsed.protocol)) return null
    let p = decodeURIComponent(parsed.pathname).replace(/\/+$/, '')
    if (p.toLowerCase().endsWith('.git')) p = p.slice(0, -4)
    return p.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * Whether a clone's origin is this company's server repository. Compared by
 * path (`/api/git-http/<companyId>`), not host: the company id is unique, and
 * a server that moved to another address (PUBLIC_URL) still serves the same
 * company — setup points origin at the current address anyway.
 */
export function sameCompanyRemote(actual: string, expected: string): boolean {
  const a = remotePath(actual.trim())
  const b = remotePath(expected.trim())
  return a !== null && b !== null && a.length > 0 && a === b
}

export function decideCompanyFolder(facts: CompanyFolderFacts, expectedRemoteUrl: string): CompanyFolderDecision {
  if (facts.hasGitDir && facts.originUrl) {
    if (!sameCompanyRemote(facts.originUrl, expectedRemoteUrl)) {
      return { action: 'refuse', reason: 'otherRemote', message: OTHER_REMOTE_MESSAGE }
    }
    if (facts.hasLocalCommits) return { action: 'existingClone' }
    // This company's remote but nothing checked out yet: an interrupted first
    // setup. Same rules as a folder without .git (resume with the picker).
  } else if (facts.hasGitDir && facts.hasLocalCommits) {
    return facts.remoteHasCommits
      ? { action: 'refuse', reason: 'unrelatedRepo', message: UNRELATED_REPO_MESSAGE }
      : { action: 'uploadExisting' }
  }
  if (!facts.remoteHasCommits) return { action: 'uploadExisting' }
  if (facts.hasUserFiles) return { action: 'refuse', reason: 'notEmpty', message: NOT_EMPTY_MESSAGE }
  return { action: 'firstSetup' }
}

export interface LocalFolderFacts {
  exists: boolean
  hasGitDir: boolean
  originUrl: string | null
  hasLocalCommits: boolean
  hasUserFiles: boolean
}

/** The local half of the facts. A folder that does not exist yet is empty. */
export async function inspectLocalFolder(
  folder: string,
  runGit: (args: string[]) => Promise<string>,
): Promise<LocalFolderFacts> {
  let entries: string[]
  try {
    entries = await fs.promises.readdir(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, hasGitDir: false, originUrl: null, hasLocalCommits: false, hasUserFiles: false }
    }
    throw error
  }
  const hasUserFiles = entries.some(name => !OS_FILES.has(name.toLowerCase()))
  const hasGitDir = fs.existsSync(path.join(folder, '.git'))
  if (!hasGitDir) return { exists: true, hasGitDir, originUrl: null, hasLocalCommits: false, hasUserFiles }
  const originUrl = (await runGit(['config', '--local', '--get', 'remote.origin.url']).catch(() => '')).trim() || null
  const hasLocalCommits = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    .then(out => out.trim().length > 0, () => false)
  return { exists: true, hasGitDir, originUrl, hasLocalCommits, hasUserFiles }
}

/**
 * Bytes git has written to `.git/objects/pack` (temporary packs included)
 * since the call, reported every `intervalMs` until the returned stop
 * function is called. Fetch output is not parsed: the pack growing on disk
 * is what a download looks like for any git version and transport.
 */
export function watchPackBytes(repoPath: string, onBytes: (receivedBytes: number) => void, intervalMs = 400): () => void {
  const packDir = path.join(repoPath, '.git', 'objects', 'pack')
  const packBytes = () => {
    let total = 0
    try {
      for (const f of fs.readdirSync(packDir)) {
        try { total += fs.statSync(path.join(packDir, f)).size } catch { /* renamed meanwhile */ }
      }
    } catch { /* no pack dir yet */ }
    return total
  }
  const start = packBytes()
  const timer = setInterval(() => onBytes(Math.max(0, packBytes() - start)), intervalMs)
  return () => clearInterval(timer)
}
