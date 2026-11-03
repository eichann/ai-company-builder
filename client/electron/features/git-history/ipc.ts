// Read-only views of the company repository for the renderer: the sync
// preview (never stages — sync/preview.ts), per-file diffs and revert, the
// summary of pending changes, a file's earlier versions (「前の版」), file names
// (Cmd+P) and content search (electron/git-search.ts).
//   git:preview, git:revertFile, git:fileDiff, git:commitFileDiff,
//   git:generateSummary, git:listFiles, git:unsharedLargeFiles, git:log, git:grep, git:getBinaryStatus

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { commitFileDiffArgs, companySearchScope, gitLogArgs, grepCompany, listCompanyFiles, normalizeSearchFolder, parseGitLog } from '../../git-search'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { AppGit } from '../../services/app-git'
import type { CommitMessagesFor } from '../../services/commit-messages'
import { previewChanges, withScratchIndex } from '../../sync/preview'
import { findUnsharedLargeFiles } from '../../sync/large-files'
import type { PathGuard } from '../ports'
import { keepCurrentVersion } from '../backups/keep-current'

/** Shown when the member's version could not be kept: nothing was undone. */
export const REVERT_KEEP_FAILED = '今の内容を .backups に保存できなかったため、元に戻しませんでした。何も変更していません。'

/**
 * The repository holding a company path: a readable private folder is its own clone inside
 * the company folder, so its files' history is read there (the path made relative to it).
 */
function repoHolding(paths: PathGuard, root: string, companyPath: string): { repo: string; rel: string } {
  const parts = companyPath.split('/').filter(Boolean)
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = path.join(root, ...parts.slice(0, i))
    if (fs.existsSync(path.join(dir, '.git'))) return { repo: paths.validate(dir), rel: parts.slice(i).join('/') }
  }
  return { repo: root, rel: companyPath }
}

export interface GitHistoryDeps {
  paths: PathGuard
  git: AppGit
  commitMessagesFor: CommitMessagesFor
}

export function registerGitHistoryIpc(ipc: IpcRegistrar, { paths, git: appGit, commitMessagesFor }: GitHistoryDeps): void {
  // Report which git binary is in use (bundled dugite git vs system fallback),
  // so the UI can warn when the bundled binary failed (e.g. arch mismatch).
  ipc.handle('git:getBinaryStatus', async () => appGit.binaryStatus())

  // Preview changes before sync. Strictly read-only: it never stages — a
  // staged file inside a not-downloaded folder slipped past sync's
  // outside-checkout hold-back and was shared (sync/preview.ts).
  ipc.handle('git:preview', async (_, repoPath: string) => {
    try {
      const safePath = paths.validate(repoPath)
      const git: SimpleGit = appGit.create(safePath)
      const { added, modified, deleted } = await previewChanges(git)

      const totalCount = added.length + modified.length + deleted.length

      return {
        success: true,
        hasChanges: totalCount > 0,
        changes: { added, modified, deleted },
        totalCount,
      }
    } catch (err) {
      console.error('Git preview error:', err)
      return {
        success: false,
        hasChanges: false,
        changes: { added: [], modified: [], deleted: [] },
        totalCount: 0,
        error: err instanceof Error ? err.message : 'Preview failed',
      }
    }
  })

  // 「元に戻す」 one change: an added file is deleted, a modified or deleted one
  // gets HEAD's version back. The member's version on disk is first kept in
  // .backups/<ts>_before_revert/ (or the private backups); if that fails,
  // nothing changes.
  ipc.handle('git:revertFile', async (_, repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => {
    try {
      const safePath = paths.validate(repoPath)
      const git: SimpleGit = appGit.create(safePath)

      if (fileStatus === 'added' || fileStatus === 'modified') {
        const onDisk = paths.validate(path.join(safePath, filePath), { followFinal: false })
        const kept = await keepCurrentVersion(paths, safePath, onDisk, 'before_revert')
        if (!kept.success) return { success: false, error: REVERT_KEEP_FAILED }
      }

      if (fileStatus === 'added') {
        // New file: drop it from the index if it is there (preview no longer
        // stages, so it usually is not) and delete it
        await git.raw(['rm', '--cached', '--quiet', '--ignore-unmatch', '--sparse', '--', filePath])
        const fullPath = paths.validate(path.join(safePath, filePath), { followFinal: false })
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath)
        }
      } else {
        // Modified or deleted: restore from HEAD
        await git.raw(['checkout', 'HEAD', '--', filePath])
      }

      return { success: true }
    } catch (err) {
      console.error('Git revert file error:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Revert failed' }
    }
  })

  // Get diff for a specific file (what the next sync would share: the file on
  // disk against HEAD — preview does not stage)
  ipc.handle('git:fileDiff', async (_, repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => {
    try {
      const safePath = paths.validate(repoPath)
      const git: SimpleGit = appGit.create(safePath)

      if (fileStatus === 'added') {
        // New file: show entire content as addition
        const content = fs.readFileSync(paths.validate(path.join(safePath, filePath)), 'utf-8')
        return { success: true, diff: content, isNewFile: true }
      } else if (fileStatus === 'deleted') {
        // Deleted file: show entire content as deletion
        const content = await git.show([`HEAD:${filePath}`])
        return { success: true, diff: content, isDeletedFile: true }
      } else {
        // Modified: show unified diff
        const diff = await git.diff(['HEAD', '-U3', '--', filePath])
        return { success: true, diff }
      }
    } catch (err) {
      console.error('Git file diff error:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Diff failed', diff: '' }
    }
  })

  // Get diff for a specific file in a specific commit
  ipc.handle('git:commitFileDiff', async (_, repoPath: string, commitHash: string, filePath: string) => {
    try {
      const { repo, rel } = repoHolding(paths, paths.validate(repoPath), String(filePath ?? ''))
      const git: SimpleGit = appGit.create(repo)
      // A hex commit id only: `--output=<file>` here made git write a file.
      const diff = await git.raw(commitFileDiffArgs(commitHash, rel))
      return { success: true, diff }
    } catch (err) {
      console.error('Git commit file diff error:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Diff failed', diff: '' }
    }
  })

  // Generate change summary (async, called separately from preview)
  ipc.handle('git:generateSummary', async (_, repoPath: string) => {
    try {
      const safePath = paths.validate(repoPath)
      // Staged into a throwaway copy of the index: preview never stages.
      const summary = await withScratchIndex({
        git: appGit.create(safePath),
        repoPath: safePath,
        makeGit: env => appGit.create(safePath, env),
        fn: async scratch => {
          await scratch.raw(['add', '--sparse', '.'])
          return commitMessagesFor(() => scratch)(safePath)
        },
      })
      return { success: true, summary: summary || null }
    } catch {
      return { success: false, summary: null }
    }
  })

  // File names in a folder ('' = the whole company) for Cmd+P: tracked and
  // untracked (not ignored), downloaded folders and readable private folders.
  ipc.handle('git:listFiles', async (_, repoPath: string, folderPath: string) => {
    try {
      const safePath = paths.validate(repoPath)
      const scope = companySearchScope(safePath, normalizeSearchFolder(folderPath))
      const { files, truncated } = await listCompanyFiles(appGit.searchCommand(), scope)
      return { success: true, files, truncated }
    } catch (err) {
      console.error('Git ls-files error:', err)
      return { success: false, files: [], error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  // Files over the size limit that sync does not share (the file tree's
  // 「大きすぎて共有されていません」 mark), company-relative. Read-only.
  ipc.handle('git:unsharedLargeFiles', async (_, repoPath: string) => {
    try {
      const safePath = paths.validate(repoPath)
      return { success: true, files: await findUnsharedLargeFiles(appGit.create(safePath, { GIT_NO_LAZY_FETCH: '1' }), safePath) }
    } catch (err) {
      console.error('Unshared large files error:', err instanceof Error ? err.message : err)
      return { success: false, files: [] }
    }
  })

  // Git log of a folder or one file (no --follow: see gitLogArgs)
  ipc.handle('git:log', async (_, repoPath: string, folderPath: string, limit: number = 50) => {
    try {
      const { repo, rel } = repoHolding(paths, paths.validate(repoPath), normalizeSearchFolder(folderPath))
      const git: SimpleGit = appGit.create(repo)
      const raw = await git.raw(gitLogArgs(rel, limit))
      return { success: true, commits: parseGitLog(raw) }
    } catch (err) {
      console.error('Git log error:', err)
      return { success: false, commits: [], error: err instanceof Error ? err.message : 'Failed' }
    }
  })

  // Content search in a folder ('' = the whole company): fixed string, A–Z
  // case-insensitive, ≤20 matches per file and ≤500 in all (git is stopped
  // there), lines cut around the match. A new search from the same window stops
  // the previous one.
  const runningGreps = new Map<number, AbortController>()
  ipc.handle('git:grep', async (event, repoPath: string, query: string, folderPath: string) => {
    const senderId = event.sender.id
    runningGreps.get(senderId)?.abort()
    const controller = new AbortController()
    runningGreps.set(senderId, controller)
    try {
      const safePath = paths.validate(repoPath)
      const scope = companySearchScope(safePath, normalizeSearchFolder(folderPath))
      const { matches, truncated, timedOut } = await grepCompany(appGit.searchCommand(), scope, String(query ?? ''), controller.signal)
      return { success: true, results: matches, truncated, timedOut, cancelled: controller.signal.aborted }
    } catch (err: unknown) {
      console.error('Git grep error:', err)
      return { success: false, results: [], error: err instanceof Error ? err.message : 'Failed' }
    } finally {
      if (runningGreps.get(senderId) === controller) runningGreps.delete(senderId)
    }
  })
}
