// git:sync — the one button members press to share their work.
//
// Moved out of main.ts unchanged so it can run without Electron: the host
// injects git, the dialog, the server API, the clock and the logger
// (./types.ts). main.ts keeps a thin ipcMain.handle('git:sync') that wires
// the real implementations; tests/sync-harness drives this same code against
// real bare repositories with several members.
//
// The step list and the guards each piece of defensive code stands for are
// documented in .claude/rules/sync.md and .claude/rules/sync-guards.md.

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { SimpleGit } from 'simple-git'
import {
  isProtectedConfigRejection,
  onlySkillFiles,
  parseWinPathFiles,
  winPathMessage,
  WINPATH_MARKER,
  parseProtectedConfigPaths,
  protectedConfigMessage,
  restoreProtectedPaths,
  squashUnpushedCommits,
  ProtectedConfigRecoveryError,
  isPersonalPathRejection,
  parsePersonalPaths,
  personalPathMessage,
  untrackPersonalPaths,
  type PersonalUntrackResult,
  type ProtectedConfigRecoveryResult,
  isWriteDeniedRejection,
  parseWriteDeniedPaths,
  writeDeniedMessage,
  isLocalOnlyPath,
  isLocalOnlyPathRejection,
  parseLocalOnlyPaths,
  localOnlyPathMessage,
  untrackLocalOnlyPaths,
} from '../protected-config'
import { classifyConflicts } from './conflicts'
import { pushLandedDespiteError } from './push-landed'
import {
  backUpBeforeServerOverwrite,
  findNestedGitRepos,
  gitlinksUnder,
  legacySharedExclusions,
  nestedRepoOverwriteMessage,
  largeFileOverwriteMessage,
  readNestedRepoExcludes,
  writeNestedRepoExcludes,
  type NestedRepoOverwriteResult,
} from './nested-repos'
import { findLargeFiles, LARGE_FILE_THRESHOLD } from './large-files'
import { moveOwnLinesToLocal, readLocalLargeFiles, writeLocalLargeFiles } from './local-ignores'
import { ensureGitignoreUnionMerge, tidyMergedGitignores } from './gitignore-merge'
import { ensurePromisorConfig, setRemoteUrl } from './remote'
import { appliedExclusions, applySparseSelection, readSparseConfig, sparseConfigPath, staleExclusions, writeSparseConfig } from './sparse'
import { exclusionsInside, isNotDownloaded } from '../../shared/sparse-paths'
import { holdBackOutsideCheckout, outsideCheckoutMessage, type OutsideCheckoutResult } from './outside-checkout'
import {
  holdBackReservedPaths,
  isReservedPathRejection,
  parseReservedPathRejection,
  reservedPathNote,
  untrackReservedPaths,
  type ReservedHoldBack,
} from './reserved-path'
import { createPathChecker, pathPrefixes, type PathChecker } from './path-check'
import { cloneStateOf, safeScopeDir, privateBackupsDir, readPrivateScopesCache, accessLostMessage, madePublicMessage, newPrivateFolderMessage, existingFolderMovedMessage, type MyPrivateScope } from './private-folders'
import {
  isUnderAny,
  placePrivateFolders,
  prefixedDialog,
  preparePrivateFolders,
  removeExcludedClone,
  syncReadOnlyScope,
} from './private-sync'
import type { SyncDeps, SyncDialog } from './types'
import { readExcludeLines, writeExcludeLines, type ExcludeBlock } from './local-excludes'
import { isTempSaveFile, TEMP_SAVE_EXCLUDE_PATTERN } from '../../shared/temp-save-file'
import { isOfficeLockFile, OFFICE_LOCK_EXCLUDE_PATTERNS } from '../../shared/office-lock-files'
import { openFilesAmong, openFilesStoppedMessage } from './open-files'
import { isSkillLeftover, skillExcludeLines, SKILL_LEFTOVER_PATTERNS } from '../../shared/skill-leftovers'
import { NEEDS_MEMBER_ERROR, type ReceiveResult } from '../../shared/auto-sync'
import { receiveIntoRepo, type RepoReceiveOutcome } from './receive'
import { stagedAutoCommitMessage } from './auto-message'
import { clearStaleLocks, isDiskFull, lockFailureMessage, pruneRecoveryRefs, recoverInterruptedState, recoveryNote, REPOSITORY_BUSY_MESSAGE, type KeptBeforeRecovery } from './interrupted'

const PULL_FAILED_MESSAGE = 'サーバーの最新の内容を受け取れなかったため、同期を完了できませんでした。このPCの変更はそのまま残っています。もう一度同期しても直らないときは、管理者に連絡してください。'

/** Does origin/main, as last fetched, hold commits HEAD does not? False without it (the first push of a company). */
async function upstreamNotMerged(git: SimpleGit): Promise<boolean> {
  const upstream = (await git.raw(['rev-parse', '--verify', '--quiet', 'origin/main']).catch(() => '')).trim()
  if (!upstream) return false
  // Hashes, not exit codes: simple-git does not reject on a silent non-zero exit.
  return (await git.raw(['merge-base', upstream, 'HEAD']).catch(() => '')).trim() !== upstream
}

/** This computer's ignore rule for what running a skill leaves in its folder (.git/info/exclude). */
const SKILL_LEFTOVER_EXCLUDES: ExcludeBlock = {
  begin: '# >>> ACB skill leftovers (managed by the app, local only) >>>',
  end: '# <<< ACB skill leftovers <<<',
}

/** This computer's ignore rule for the app's temporary save files (.git/info/exclude). */
const TEMP_SAVE_EXCLUDES: ExcludeBlock = {
  begin: '# >>> ACB temporary save files (managed by the app, local only) >>>',
  end: '# <<< ACB temporary save files <<<',
}

/** This computer's ignore rule for office lock / temporary files (`~$x.xlsx`, `.~lock.x#`; .git/info/exclude). */
const OFFICE_LOCK_EXCLUDES: ExcludeBlock = {
  begin: '# >>> ACB office lock files (managed by the app, local only) >>>',
  end: '# <<< ACB office lock files <<<',
}

/** The member's version of a conflicted file could not be saved: the rebase was undone, nothing was replaced. */
function conflictBackupFailedMessage(error: unknown): string {
  const stopped = '競合したファイルのバックアップを保存できなかったため、同期を中止しました。変更はこのPCに残っています。'
  return isDiskFull(error) ? `${stopped}ディスクの空きを増やしてから、もう一度同期してください。` : `${stopped}もう一度同期しても直らないときは、管理者に連絡してください。`
}

export type { SyncDeps, SyncDialog, SyncServerApi, SyncLogger } from './types'

/**
 * The result for a push the server refused with SECRET_DETECTED: the files
 * from the hook's list ("remote:   - <file> (<pattern>)"). No PENDING_PUSH —
 * the same push would be refused again until the member removes the secret.
 */
function secretDetectedResult(errorMessage: string) {
  // git prefixes pre-receive hook stderr with "remote: "
  const fileLines = errorMessage
    .split('\n')
    .map((line: string) => line.replace(/^remote:\s*/, '').trim())
    .filter((line: string) => line.startsWith('- '))
  const fileList = fileLines.length > 0 ? fileLines.join('\n') : '（詳細不明）'
  return {
    success: false as const,
    error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${fileList}`,
    secretDetected: true as const
  }
}

/** Filled in by runSync once files were held back (reported on every later outcome). */
interface SyncSideEffects {
  outsideCheckout: OutsideCheckoutResult | null
  /** Files in a reserved (private) folder name, moved to .backups/ before staging or after a [RESERVED_PATH] rejection. */
  reserved: ReservedHoldBack | null
  /** This computer's versions of files in excluded nested repositories, backed up before a teammate's same-path files replaced them. */
  nestedRepoOverwrite?: NestedRepoOverwriteResult | null
  largeFileOverwrite?: NestedRepoOverwriteResult | null
  /** What was on disk when an operation an earlier run left half-way was cleaned up. */
  beforeRecovery?: KeptBeforeRecovery | null
}

/**
 * Which repository runSync is syncing. The company repository is the
 * default; a readable private folder's clone (a scope repository) runs the
 * same steps with these differences: no remote migration and no department
 * folder protection (both are about the company repository), and its backups
 * go to the company's .backups/ under the folder's path.
 */
interface RunOptions {
  kind: 'company' | 'scope'
  /**
   * Company: the readable private folders' paths (their clones live there).
   * Skipped by the large-file scan and nested-repository detection; their
   * download exclusions are never dropped as stale.
   */
  privatePaths?: string[]
  /** Company: may these new paths be used (POST …/paths/check, cached)? Unknown answers are absent. */
  checkUsable?: (paths: string[]) => Promise<Map<string, boolean>>
  /** Scope: the company's .backups/ directory. */
  backupsDir?: string
  /** Scope: the folder's company-relative path (prefix of backed-up files). */
  backupPrefix?: string
}

async function runSync(deps: SyncDeps, repoPath: string, companyId: string, commitMessage: string, effects: SyncSideEffects, opts: RunOptions = { kind: 'company' }) {
  const log = deps.log
  const isScope = opts.kind === 'scope'
  const privatePaths = opts.privatePaths ?? []
  // Files a backup keeps are laid out (and listed) company-relative.
  const backupPrefix = opts.backupPrefix ? `${opts.backupPrefix}/` : ''
  const shownPath = (file: string) => `${backupPrefix}${file}`
  try {
    const git: SimpleGit = deps.createGit(repoPath)
    // Every push goes through here. A push that threw although the server
    // already has the commits (the watchdog killed it while the server was
    // still checking, or the connection died after the pack was accepted)
    // counts as pushed — see ./push-landed.ts.
    const pushToServer = async (branch: 'main' | 'master' = 'main') => {
      try {
        await git.push('origin', branch, ['--set-upstream', '--progress'])
      } catch (pushError) {
        if (await pushLandedDespiteError(git, log, pushError)) return
        throw pushError
      }
    }
    // Stage everything the member changed — never what sync keeps locally:
    // .backups/ and .workspace/ (whatever the shared .gitignore says: one
    // `!.backups/` line would otherwise share every backup) and the private
    // folders' clones (a negation in the shared .gitignore outranks
    // .git/info/exclude and would stage the clone as a gitlink). Exclusion
    // pathspecs cannot do it (git refuses an `add` whose pathspec names an
    // ignored path), so whatever of that kind reached the index is unstaged
    // right after the add — index only, nothing on disk is touched — before
    // anything is committed.
    // The document review's temporary save files (`.<name>.acb-tmp-…`, there for
    // milliseconds) are ignored on this computer only and unstaged if a shared
    // .gitignore negation re-included them (client/shared/temp-save-file.ts).
    const localOnly = ['.backups', '.workspace', ...privatePaths]
    const stageAll = async () => {
      try {
        writeExcludeLines(repoPath, TEMP_SAVE_EXCLUDES, [TEMP_SAVE_EXCLUDE_PATTERN])
        writeExcludeLines(repoPath, OFFICE_LOCK_EXCLUDES, OFFICE_LOCK_EXCLUDE_PATTERNS)
        // Unknown (offline, an older server): the block stays as the last known answer left it.
        const sharing = await deps.api.getSkillSharing(companyId).catch(() => null)
        if (sharing) writeExcludeLines(repoPath, SKILL_LEFTOVER_EXCLUDES, skillExcludeLines(sharing, opts.backupPrefix ?? ''))
        else if (readExcludeLines(repoPath, SKILL_LEFTOVER_EXCLUDES).length === 0) writeExcludeLines(repoPath, SKILL_LEFTOVER_EXCLUDES, SKILL_LEFTOVER_PATTERNS)
      } catch (excludeError) {
        log.warn('Git sync: Could not write .git/info/exclude (temporary save files):', excludeError)
      }
      await git.raw(['add', '--sparse', '.'])
      const staged = (await git.raw(['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=AMT']).catch(() => ''))
        .split('\0').filter(Boolean)
      // A leftover only while new: one the company already has is a tracked file,
      // and taking it out of the index here would delete it for everyone.
      // An office lock file the company already has (an older app shared it) is left alone too:
      // its app removes it on close, and that deletion is shared as usual.
      const added = staged.some(f => isSkillLeftover(f) || isOfficeLockFile(f))
        ? new Set((await git.raw(['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=A']).catch(() => '')).split('\0'))
        : new Set<string>()
      const stray = staged.filter(f => isUnderAny(localOnly, f) || isLocalOnlyPath(f) || isTempSaveFile(f) || (added.has(f) && (isSkillLeftover(f) || isOfficeLockFile(f))))
      if (stray.length > 0) {
        log.warn('Git sync: Unstaging local-only paths that reached the index:', stray.length)
        for (let i = 0; i < stray.length; i += 200) {
          await git.raw(['rm', '-r', '--cached', '-f', '--quiet', '--ignore-unmatch', '--sparse', '--', ...stray.slice(i, i + 200)])
        }
      }
    }
    const backupsDir = opts.backupsDir ?? path.join(repoPath, '.backups')
    const timestamp = deps.now().toISOString().replace(/[:.]/g, '-').slice(0, 23)
    // A private folder's conflict backups get their own folder next to the
    // company's (the two syncs run within the same millisecond at times).
    const backupPath = path.join(backupsDir, isScope ? `${timestamp}_private` : timestamp)

    // A partial clone that lost its promisor config (an older app removed
    // and re-added origin) cannot fetch the blobs it never downloaded, so a
    // rebase or sparse change that needs one fails. Repair it first.
    try {
      await ensurePromisorConfig(git, log)
    } catch (promisorError) {
      log.warn('Git sync: Could not check the partial clone config:', promisorError)
    }

    // Clean up old backups (older than 30 days) — async to avoid blocking UI
    // (once per sync: the company run; private folders share their backups).
    // Before the recovery below: on a full disk its copy needs this space.
    if (!isScope) {
      const RETENTION_DAYS = 30
      const cutoff = deps.now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000
      for (const dir of [backupsDir, privateBackupsDir(repoPath)]) {
        if (!fs.existsSync(dir)) continue
        try {
          const backupFolders = await fs.promises.readdir(dir)
          for (const folder of backupFolders) {
            const folderPath = path.join(dir, folder)
            try {
              const stat = await fs.promises.stat(folderPath)
              if (stat.isDirectory() && stat.mtimeMs < cutoff) {
                await fs.promises.rm(folderPath, { recursive: true, force: true })
                log.log(`Git sync: Deleted old backup: ${folder}`)
              }
            } catch { /* skip inaccessible folders */ }
          }
        } catch (cleanupError) {
          log.warn('Git sync: Backup cleanup failed:', cleanupError)
        }
      }
    }

    await pruneRecoveryRefs(git, backupsDir, log).catch((pruneError: unknown) => log.warn('Git sync: Could not prune recovery refs:', pruneError))

    // Recover from a rebase / merge an earlier run left half-way (the app quit
    // or crashed, git was killed): files edited since then are kept first
    // (./interrupted.ts); if they cannot be, nothing is cleaned up.
    const gitDir = path.join(repoPath, '.git')
    const rebaseInProgress = () =>
      fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))
    const recovery = await recoverInterruptedState({
      git, repoPath,
      backupPath: `${path.join(backupsDir, timestamp)}_before_recovery`,
      backupPrefix: opts.backupPrefix,
      skip: file => isUnderAny(localOnly, file),
      otherGitRunning: deps.otherGitRunning?.() ?? false,
      now: deps.now(),
      log,
    })
    if (!recovery.ok) {
      return {
        success: false, errorType: recovery.errorType, error: recovery.error,
        ...(recovery.kept ? { recoveredFiles: recovery.kept.files, recoveryBackupPath: recovery.kept.backupPath } : {}),
      }
    }
    effects.beforeRecovery = recovery.kept

    // .gitignore files merge line by line (union) instead of "server wins",
    // so lines sync added — nested-repo / large-file exclusions, essential
    // patterns — survive a concurrent change by a teammate. Declared in the
    // repository-local .git/info/attributes (never committed), before any
    // rebase can run. See ./gitignore-merge.ts.
    try {
      if (ensureGitignoreUnionMerge(gitDir)) log.log('Git sync: Declared .gitignore merge=union in .git/info/attributes')
    } catch (attributesError) {
      log.warn('Git sync: Could not declare .gitignore merge=union:', attributesError)
    }

    // Retry pending push from previous failed sync
    const pendingPushFile = path.join(gitDir, 'PENDING_PUSH')
    if (fs.existsSync(pendingPushFile)) {
      log.log('Git sync: Found pending push, retrying...')
      try {
        await pushToServer()
        fs.unlinkSync(pendingPushFile)
        log.log('Git sync: Pending push succeeded')
      } catch (retryError) {
        log.warn('Git sync: Pending push retry failed, will try again later:', retryError)
        // Continue with normal sync flow — push will be attempted again at the end
      }
    }

    // Auto-migrate remote URL from SSH to HTTPS if needed (the company
    // repository only: the URL it would migrate to is the company's).
    if (!isScope) {
    try {
      const remotes = await git.getRemotes(true)
      const origin = remotes.find(r => r.name === 'origin')
      if (origin && origin.refs?.fetch && !origin.refs.fetch.startsWith('https://')) {
        log.log('Git sync: Detected SSH remote URL, migrating to HTTPS...')
        const httpsUrl = await deps.api.getRepoHttpsUrl(companyId)
        if (httpsUrl) {
          // set-url, never remove + add (keeps a partial clone's promisor config, ./remote.ts)
          await setRemoteUrl(git, httpsUrl)
          log.log(`Git sync: Migrated remote URL to ${httpsUrl}`)
        }
      }
    } catch (migrationError) {
      log.warn('Git sync: Remote URL migration check failed:', migrationError)
    }
    }

    // Set git user identity from logged-in user (null when signed out)
    try {
      const user = await deps.api.getCurrentUser()
      if (user) {
        const userName = (user.name || user.email) as string
        const userEmail = user.email as string
        await git.addConfig('user.name', userName, false, 'local')
        await git.addConfig('user.email', userEmail, false, 'local')
      }
    } catch (e) {
      log.warn('Git sync: Could not set git user identity:', e)
    }

    // Ensure essential patterns are in .gitignore
    const gitignorePath = path.join(repoPath, '.gitignore')
    let gitignoreContent = ''
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
    }

    // Essential patterns that should always be ignored
    const essentialPatterns = [
      { pattern: '.backups/', comment: '' },
      { pattern: '.workspace/', comment: '# AI-generated temp files' },
      { pattern: 'node_modules/', comment: '# Dependencies' },
      { pattern: '.env', comment: '# Secrets — never sync (local only)' },
      { pattern: '.env.*', comment: '' },
      { pattern: '!.env.example', comment: '# Keep templates shared' },
      { pattern: '!.env.sample', comment: '' },
      // Personal workspaces are never shared, at any depth (the server
      // rejects them too — PERSONAL_PATH). The in-folder .gitignore that the
      // server writes into department .personal/ folders stays shared. `**/`
      // because a pattern with a slash is anchored to this file's directory.
      { pattern: '**/.personal/*', comment: '# Personal workspaces — never sync (local only)' },
      { pattern: '!**/.personal/.gitignore', comment: '' },
    ]

    const patternsToAdd: string[] = []
    for (const { pattern, comment } of essentialPatterns) {
      if (!gitignoreContent.includes(pattern)) {
        if (comment) patternsToAdd.push(comment)
        patternsToAdd.push(pattern)
      }
    }

    if (patternsToAdd.length > 0) {
      const addition = '\n' + patternsToAdd.join('\n') + '\n'
      fs.appendFileSync(gitignorePath, addition)
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
    } else if (!fs.existsSync(gitignorePath)) {
      const seed = '.backups/\nnode_modules/\n# Secrets — never sync (local only)\n.env\n.env.*\n!.env.example\n!.env.sample\n**/.personal/*\n!**/.personal/.gitignore\n'
      fs.writeFileSync(gitignorePath, seed)
      gitignoreContent = seed
    }

    // Detect nested Git repositories (e.g. user ran `git init` in a subfolder,
    // or copied in a cloned repo). Left alone, `git add` would record them as
    // gitlinks (160000 mode) and other members pulling would see empty folders.
    // Newly found repos require the user's choice BEFORE anything is modified:
    // the pre-consent `rm --cached` of the 2026-07-29 incident untracked a
    // whole shared folder (653 files) and surfaced as a terrifying "653 files
    // deleted" warning even though nothing was gone from disk.
    // "Don't share" (the default) is this member's own choice: it goes into
    // .git/info/exclude (./nested-repos.ts), never the shared .gitignore, and
    // untracks only gitlinks — teammates' files at the same path keep syncing.
    const newlyExcludedNestedRepos: string[] = []
    // Every nested repo the member has chosen to exclude (now or earlier).
    const excludedNestedRepoPaths: string[] = []
    // Gitlinks this sync untracked (their staged deletions are not the member's).
    const untrackedGitlinks: string[] = []
    // Folders excluded on this computer only (block of .git/info/exclude), still on disk.
    let localExcluded: string[] = []
    try {
      // Private folders' clones are legitimate nested repositories (their
      // origin was checked when they were placed), and a nested repository
      // at a reserved folder name is moved to .backups/ below — neither is
      // offered for exclusion.
      const nestedRepos: string[] = []
      for (const repo of await findNestedGitRepos(repoPath)) {
        if (isUnderAny(privatePaths, repo)) continue
        if (opts.checkUsable && [...(await opts.checkUsable(pathPrefixes(repo))).values()].includes(false)) continue
        nestedRepos.push(repo)
      }
      // Local exclusions of folders that are gone (the member deleted the
      // clone) are dropped; a folder whose .git was removed stays excluded
      // until the member deletes it — nothing starts being shared on its own.
      localExcluded = readNestedRepoExcludes(repoPath)
        .filter(repo => { try { return fs.lstatSync(path.join(repoPath, repo)).isDirectory() } catch { return false } })
      if (nestedRepos.length > 0) {
        const currentGitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : ''
        // `/<path>/` lines older apps wrote into the shared .gitignore: kept
        // (removing one would share the folder for everyone) and honoured.
        const legacy = legacySharedExclusions(currentGitignore)
        const alreadyExcluded = (repo: string) => legacy.has(repo.normalize('NFC')) || localExcluded.includes(repo.normalize('NFC'))
        const newRepos = nestedRepos.filter(repo => !alreadyExcluded(repo))
        const canAsk = deps.dialog.canAsk()

        for (const repo of newRepos) {
          if (!canAsk) {
            // No window to ask: keep it on this computer only (the default).
            newlyExcludedNestedRepos.push(repo)
            continue
          }

          // A folder that is already shared (tracked files in HEAD) most
          // likely picked up a stray .git from a copied clone.
          const isShared = (await git.raw(['ls-files', '--', repo])).trim().length > 0

          if (isShared) {
            const choice = await deps.dialog.confirmSharedNestedRepo(repo)
            if (choice === 'cancel') {
              return { success: false, error: `同期を中止しました（「${repo}」に別のGitリポジトリが含まれています）` }
            }
            if (choice === 'keep-sharing') {
              fs.rmSync(path.join(repoPath, repo, '.git'), { recursive: true, force: true })
              log.log(`Git sync: Removed inner .git of "${repo}" (user chose to share its files)`)
              continue // stays shared — no exclusion
            }
            // 'exclude' → excluded on this computer below
          } else {
            const choice = await deps.dialog.confirmExternalNestedRepo(repo)
            if (choice === 'cancel') {
              return { success: false, error: `同期を中止しました（「${repo}」は外部Gitリポジトリです）` }
            }
          }
          newlyExcludedNestedRepos.push(repo)
        }

        // Mutations happen only after the user has chosen. Unstage gitlinks
        // of excluded repos (previously excluded ones too); ordinary files
        // there stay tracked.
        const excludedRepos = nestedRepos.filter(repo => newlyExcludedNestedRepos.includes(repo) || alreadyExcluded(repo))
        excludedNestedRepoPaths.push(...excludedRepos)
        for (const repo of excludedRepos) {
          const gitlinks = await gitlinksUnder(git, repo)
          if (gitlinks.length === 0) continue
          await git.raw(['rm', '--cached', '-q', '--sparse', '--', ...gitlinks])
          untrackedGitlinks.push(...gitlinks)
          log.log(`Git sync: Removed gitlink for nested repo "${repo}"`)
        }
      }
      if (writeNestedRepoExcludes(repoPath, [...localExcluded, ...newlyExcludedNestedRepos]) && newlyExcludedNestedRepos.length > 0) {
        log.log(`Git sync: Excluded ${newlyExcludedNestedRepos.length} nested repo(s) on this computer (.git/info/exclude):`, newlyExcludedNestedRepos)
      }
    } catch (nestedRepoError) {
      log.warn('Git sync: Nested repo detection failed:', nestedRepoError)
    }

    // Lines older apps wrote into the shared .gitignore for this member (their
    // large files, their private skills) move to .git/info/exclude before the
    // scan and before anything is staged. See ./local-ignores.ts.
    try {
      const moved = await moveOwnLinesToLocal(git, repoPath, {
        threshold: deps.largeFileThreshold ?? LARGE_FILE_THRESHOLD,
        skills: !isScope,
      })
      if (moved.largeFiles.length + moved.skills.length > 0) {
        log.log(`Git sync: Moved ${moved.largeFiles.length} large-file and ${moved.skills.length} private-skill line(s) from .gitignore to .git/info/exclude`)
      }
    } catch (moveError) {
      log.warn('Git sync: Could not move own .gitignore lines to .git/info/exclude:', moveError)
    }

    // Detect large files (>100MB) and keep them on this computer: only the
    // files git lists (index entries + untracked files no rule ignores) are
    // stat'ed, never the whole folder, and "already ignored" is git's answer.
    // The lines go to this computer's .git/info/exclude, never the shared
    // .gitignore (a teammate's file at the same path would stop syncing).
    // A private folder's clone is its own repository with its own exclude
    // file. See ./large-files.ts. Runs after the nested-repository step: a
    // repository kept on this computer is ignored by then, and one whose .git
    // the member removed is scanned as the plain files it now is.
    let ignoredLargeFiles: string[] = []
    try {
      ignoredLargeFiles = await findLargeFiles(git, repoPath, {
        threshold: deps.largeFileThreshold,
        skip: rel => isUnderAny(localOnly, rel),
      })
    } catch (scanError) {
      log.warn('Git sync: Large file scan failed:', scanError)
    }

    // Keep large files ignored on this computer; lines of files that are gone are dropped.
    try {
      const kept = readLocalLargeFiles(repoPath).filter(rel => { try { fs.lstatSync(path.join(repoPath, rel)); return true } catch { return false } })
      writeLocalLargeFiles(repoPath, [...kept, ...ignoredLargeFiles])
      if (ignoredLargeFiles.length > 0) log.log(`Git sync: Ignored ${ignoredLargeFiles.length} large file(s) on this computer:`, ignoredLargeFiles)
    } catch (excludeError) {
      // Not ignored after all: the untracked ones are unstaged after the add
      // like .backups/ (a tracked one stays tracked, as it always did).
      log.warn('Git sync: Could not write .git/info/exclude (large files):', excludeError)
      for (const rel of ignoredLargeFiles) {
        const tracked = (await git.raw(['ls-files', '--', `:(literal)${rel}`]).catch(() => 'unknown')).trim() !== ''
        if (!tracked) localOnly.push(rel)
      }
    }

    // 1. Fetch from origin
    log.log('Git sync: Fetching from origin...')
    try {
      await git.fetch(['--progress', 'origin'])
    } catch (fetchError) {
      log.warn('Git sync: Fetch failed (may be offline):', fetchError)
    }

    // 1.3. A private folder's clone lives inside the company tree. If the
    //      server's company tree turned one of its ancestors (or the folder
    //      itself) into a file or a symlink, the pull would delete the
    //      clone — ignored files are expendable to git — with every unsynced
    //      private edit, and the next placement could follow the link out of
    //      the company folder. Stop before anything changes.
    for (const privatePath of privatePaths) {
      const segments = privatePath.split('/')
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join('/')
        const entry = (await git.raw(['ls-tree', '-z', 'origin/main', '--', prefix]).catch(() => '')).split('\0')[0]
        if (!entry) break
        const type = entry.slice(0, entry.indexOf('\t')).split(' ')[1]
        if (type !== 'tree') {
          log.error(`Git sync: "${prefix}" became a ${type} on the server; it holds private folder "${privatePath}"`)
          return {
            success: false,
            errorType: 'conflict' as const,
            error: `非公開フォルダ『${privatePath}』のある場所（${prefix}）が、サーバーでフォルダ以外に置き換えられているため、同期を止めました。手元のファイルはそのままです。管理者に連絡してください。`,
          }
        }
      }
    }

    // 1.35. A file a teammate changed that Excel, Word… has open on this
    //       computer is never replaced unasked: the app would later save its
    //       old copy over the teammate's version (and on Windows Office holds
    //       the file, so the pull could not replace it). Ask before anything
    //       changes; the default stops with everything as it is
    //       (./open-files.ts, sync-guards.md "Files open in another app").
    {
      const upstream = (await git.raw(['rev-parse', '--verify', '--quiet', 'origin/main']).catch(() => '')).trim()
      const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim()
      if (upstream && head && upstream !== head) {
        // Trees only: in a partial clone this downloads no file contents.
        const incoming = (await git.raw(['diff', '--name-only', '-z', '--no-renames', `${head}...${upstream}`]).catch(() => ''))
          .split('\0').filter(Boolean)
        const open = incoming.length > 0 ? await openFilesAmong(git, repoPath, incoming) : []
        if (open.length > 0) {
          const choice = deps.dialog.canAsk() ? await deps.dialog.confirmOpenFiles(open) : 'wait'
          if (choice !== 'continue') {
            log.log(`Git sync: ${open.length} file(s) a teammate changed are open in another app; stopped`)
            return { success: false, errorType: 'file_open' as const, error: openFilesStoppedMessage(open.map(shownPath)), openFiles: open.map(shownPath) }
          }
          log.log(`Git sync: ${open.length} open file(s) a teammate changed; the member says they are closed`)
        }
      }
    }

    // 1.4. Files created inside a folder that is not checked out (excluded in
    //      settings / not picked at first setup) are never shared: the member
    //      cannot see the teammates' files there, and staging one would
    //      silently replace a teammate's file on the server. Moved to
    //      .backups/<ts>_outside_checkout/ before anything is staged — and
    //      before the reconcile: `sparse-checkout set` with a changed file on
    //      a not-checked-out path downloads the teammate's version in a
    //      partial clone. See ./outside-checkout.ts.
    try {
      effects.outsideCheckout = await holdBackOutsideCheckout({
        git, repoPath, backupPath: `${backupPath}_outside_checkout`, now: deps.now(), log,
      })
    } catch (holdBackError) {
      // Staging such a file is exactly what this step prevents: stop here,
      // with every file still where the member left it.
      log.error('Git sync: Could not set aside files created outside the checkout:', holdBackError)
      const msg = holdBackError instanceof Error ? holdBackError.message : String(holdBackError)
      return {
        success: false,
        error: `ダウンロードしていないフォルダに作られたファイルを確認できなかったため、同期を中止しました。ファイルはこのPCに残っています。\n${msg}`,
      }
    }

    // 1.45. A folder named like a private folder the member cannot read is
    //       never shared: the server would reject the push with
    //       [RESERVED_PATH]. The server answers which new paths are usable
    //       (POST …/paths/check; unknown holds nothing back). Move such files to
    //       .backups/<ts>_reserved_path/ before staging — the same outcome as
    //       the rejection's recovery below, without the round trip.
    if (opts.checkUsable) {
      try {
        effects.reserved = await holdBackReservedPaths({
          git, repoPath, backupPath: `${backupPath}_reserved_path`, now: deps.now(), checkUsable: opts.checkUsable, log,
        })
      } catch (holdBackError) {
        log.error('Git sync: Could not set aside files in a reserved folder name:', holdBackError)
        const msg = holdBackError instanceof Error ? holdBackError.message : String(holdBackError)
        return {
          success: false,
          error: `使えない名前のフォルダに作られたファイルを確認できなかったため、同期を中止しました。ファイルはこのPCに残っています。\n${msg}`,
        }
      }
    }

    // 1.5. Reconcile sparse checkout to the user's persisted exclusions.
    //       Everything is checked out except the excluded folders (at any
    //       depth), so newly created folders appear automatically while
    //       excluded ones stay excluded across every sync. (The old code
    //       re-added every DB department here, which silently undid the
    //       user's exclusions.)
    try {
      const sparseEnabledNow = (await git.raw(['config', '--get', 'core.sparseCheckout']).catch(() => '')).trim() === 'true'

      // Recovery: a repo that is sparse but has no config file is in a legacy
      // or broken state (an earlier bug stored the config in the worktree and
      // stripped dotfolders like .claude/skills from the cone). Restore a full
      // checkout so nothing important stays hidden; the user can re-exclude.
      if (sparseEnabledNow && !fs.existsSync(sparseConfigPath(repoPath))) {
        await git.raw(['sparse-checkout', 'disable']).catch(() => {})
        writeSparseConfig(repoPath, { excluded: [] })
        log.log('Git sync: Reset legacy sparse checkout to full checkout (no config found)')
      }

      const sparseConfig = readSparseConfig(repoPath)
      if (sparseConfig.excluded.length > 0) {
        // A folder nobody has any more (a teammate deleted or renamed it) is
        // no longer excluded: otherwise a folder the member creates there
        // later would be held back as "not downloaded".
        // A readable private folder is never in the company tree: its
        // exclusion (not downloaded) is not stale.
        const stale = (await staleExclusions(git, sparseConfig.excluded))?.filter(e => !isUnderAny(privatePaths, e)) ?? null
        const excluded = stale && stale.length > 0
          ? sparseConfig.excluded.filter(e => !stale.includes(e))
          : sparseConfig.excluded
        if (stale && stale.length > 0) log.log('Git sync: Dropping exclusions of folders that no longer exist:', stale)
        // Patterns `/*` + `!/<folder>/` (non-cone): a repository still on
        // the old cone mode switches here without downloading anything.
        await applySparseSelection(git, repoPath, excluded)
      }
    } catch (sparseUpdateError) {
      log.warn('Git sync: Sparse checkout reconcile failed:', sparseUpdateError)
    }

    const restoredFolders: string[] = []

    // 2. Check for deleted files before staging. Gitlinks untracked by the
    //    nested-repo exclusion above are intentional — keep them out of the
    //    warning dialog (and never "restore" them).
    const preAddStatus = await git.status()
    const deletedFiles = preAddStatus.deleted.filter(f => !untrackedGitlinks.includes(f))

    // If files were deleted locally, warn the user before syncing
    if (deletedFiles.length > 0 && deps.dialog.canAsk()) {
      const choice = await deps.dialog.confirmDeletedFiles(deletedFiles)

      if (choice === 'cancel') {
        // Cancel sync
        return { success: false, error: '同期がキャンセルされました' }
      }

      if (choice === 'restore') {
        // Restore deleted files from HEAD
        log.log(`Git sync: Restoring ${deletedFiles.length} deleted files`)
        await git.checkout(['HEAD', '--', ...deletedFiles])
      }
    }

    // Add all files and commit
    await stageAll()
    const status = await git.status()

    // A private clone that a shared .gitignore negation re-includes shows as
    // untracked; it is never staged, so it is no change of the company's.
    const hasLocalChanges = status.staged.length > 0 || status.files.some(f => !isUnderAny(localOnly, f.path.replace(/\/$/, '')))

    if (hasLocalChanges) {
      // Use custom message if provided (not the default fallback), otherwise generate with AI
      const isCustomMessage = commitMessage && commitMessage !== 'Sync from AI Company Builder'
      const finalMessage = isCustomMessage
        ? commitMessage
        : (await deps.generateCommitMessage(repoPath, { kind: opts.kind })) || commitMessage || 'Sync from AI Company Builder'
      await git.commit(finalMessage)
    }

    // Record local commit hash before rebase attempt
    const localHash = (await git.revparse(['HEAD'])).trim()
    log.log(`Git sync: Local commit hash: ${localHash}`)

    // 3.9. A folder excluded on this computer only may be shared by a
    //      teammate at the same path: the pull would silently overwrite this
    //      computer's (ignored) files there. Back them up first; stop if that
    //      cannot be checked (the commit stays local, nothing else changed).
    const overwriteGuarded = [...new Set([...excludedNestedRepoPaths, ...localExcluded, ...newlyExcludedNestedRepos])]
    if (overwriteGuarded.length > 0) {
      try {
        effects.nestedRepoOverwrite = await backUpBeforeServerOverwrite({
          git, repoPath, repos: overwriteGuarded, backupPath: `${backupPath}_nested_repo`,
          backupPrefix: opts.backupPrefix, now: deps.now(), log,
        })
      } catch (backupError) {
        log.error('Git sync: Could not back up files of excluded nested repositories:', backupError)
        const msg = backupError instanceof Error ? backupError.message : String(backupError)
        return {
          success: false,
          error: `共有していないフォルダのファイルを確認できなかったため、同期を中止しました。変更はこのPCに保存されています。\n${msg}`,
        }
      }
    }

    //      The same for large files kept on this computer (.git/info/exclude):
    //      a teammate may share a file at the same path now that no shared
    //      line ignores it for everyone.
    try {
      const keptLarge = readLocalLargeFiles(repoPath)
      if (keptLarge.length > 0) {
        effects.largeFileOverwrite = await backUpBeforeServerOverwrite({
          git, repoPath, repos: keptLarge, files: true, backupPath: `${backupPath}_large_file`,
          backupPrefix: opts.backupPrefix, now: deps.now(), log,
        })
      }
    } catch (backupError) {
      log.error('Git sync: Could not back up large files kept on this computer:', backupError)
      const msg = backupError instanceof Error ? backupError.message : String(backupError)
      return {
        success: false,
        error: `このPCだけに置いている大きなファイルを確認できなかったため、同期を中止しました。変更はこのPCに保存されています。\n${msg}`,
      }
    }

    // 4. Pull with rebase
    let hadConflicts = false
    const conflictFiles: string[] = []
    // Conflicted paths the server had deleted. `checkout --ours` cannot resolve
    // these (the index has no stage 2), so sync follows the deletion — tracked
    // separately because the user has to be told the file was *removed*, not
    // overwritten, or its disappearance looks like data loss.
    const deletedConflictFiles: string[] = []

    // Windows: another process (running skill tool, editor, AV scan) holding
    // a file makes rebase fail with a transient lock error that clears
    // moments later — these are not conflicts, so retry before giving up.
    const isWindowsLockError = (e: unknown): boolean => {
      if (deps.platform !== 'win32') return false
      const msg = e instanceof Error ? e.message : String(e)
      return /permission denied|unable to unlink|unlink of file|unable to create .+\.lock|index\.lock|sharing violation|resource busy/i.test(msg)
    }

    try {
      log.log('Git sync: Pulling with rebase...')
      try {
        await git.pull('origin', 'main', ['--rebase', '--progress'])
      } catch (firstPullError) {
        if (!isWindowsLockError(firstPullError)) throw firstPullError
        const maxRetries = 2
        for (let attempt = 1; ; attempt++) {
          log.warn(`Git sync: Pull hit a file lock, retrying (${attempt}/${maxRetries})...`)
          await git.rebase(['--abort']).catch(() => { /* no rebase in progress */ })
          await new Promise((resolve) => setTimeout(resolve, 800))
          try {
            await git.pull('origin', 'main', ['--rebase', '--progress'])
            break
          } catch (retryError) {
            if (attempt >= maxRetries || !isWindowsLockError(retryError)) throw retryError
          }
        }
      }
    } catch (pullError) {
      if (!rebaseInProgress()) {
        // Not a conflict — e.g. network error or no remote tracking branch
        log.warn('Git sync: Pull failed but no rebase in progress:', pullError)
        // The fetch saw server changes this pull did not bring in: going on
        // would report a finished sync while the member misses them. (A push
        // would be refused anyway.) Nothing of theirs moved.
        if (await upstreamNotMerged(git)) {
          return { success: false, errorType: 'pull_failed', error: PULL_FAILED_MESSAGE }
        }
      } else {
        log.log('Git sync: Pull stopped mid-rebase, resolving conflicts...')

        // Cumulative metadata — rewritten whenever the conflict lists grow or
        // a round finishes classifying, so `deletedConflictFiles` is never
        // stale (it is only known *after* the round resolves its conflicts).
        const writeBackupMetadata = () => {
          fs.writeFileSync(
            path.join(backupPath, '_metadata.json'),
            JSON.stringify({
              timestamp: deps.now().toISOString(),
              reason: 'conflict',
              conflictFiles: conflictFiles.map(shownPath),
              deletedConflictFiles: deletedConflictFiles.map(shownPath),
              message: commitMessage || 'Sync from AI Company Builder'
            }, null, 2)
          )
        }

        // Use git cat-file to extract as binary-safe Buffer
        // (git.show returns string, which corrupts binary files). Through the
        // configured git, not a bare spawn: in a partial clone a missing
        // object is fetched lazily, which needs the app's auth and the
        // watchdog. (The member's own versions are always local — they were
        // written or checked out on this machine — so in practice this never
        // downloads anything.)
        const catFile = (spec: string): Promise<Buffer> => git.binaryCatFile(['-p', spec])

        // Back up the local version of the given files into the timestamped
        // backup folder: the member's latest version (localHash) when the
        // file still exists there, otherwise the local side of the pick being
        // replayed (index stage 3). The fallback matters when a later,
        // not-yet-pushed commit renamed or deleted the file — localHash has
        // no such path, and the edit that conflicted here would otherwise be
        // replaced by the server version without a copy anywhere.
        // Git's object id of the content saved for each path, to tell later
        // which versions a conflicted pick replaces that are not saved yet.
        const savedVersions = new Map<string, Set<string>>()
        const markSaved = (file: string, content: Buffer) => {
          const id = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
          if (!savedVersions.has(file)) savedVersions.set(file, new Set())
          savedVersions.get(file)!.add(id)
        }
        const backupConflictFiles = async (files: string[]) => {
          fs.mkdirSync(backupPath, { recursive: true })
          for (const file of files) {
            const destPath = path.join(backupPath, backupPrefix, file)
            fs.mkdirSync(path.dirname(destPath), { recursive: true })
            for (const spec of [`${localHash}:${file}`, `:3:${file}`]) {
              // Not there (e.g. a file only the server side has): try the next
              // source. A write that fails is not this: it stops the sync.
              const content = await catFile(spec).catch(() => null)
              if (!content) continue
              fs.writeFileSync(destPath, content)
              markSaved(file, content)
              break
            }
          }
          writeBackupMetadata()
        }

        // The backup above keeps one version per path: the member's latest.
        // Replaying several unpushed commits can replace an *earlier* local
        // version of a path that the latest one does not contain — the file
        // was renamed away and the path reused, or edited differently in
        // separate commits. Every such version (the local side of this pick,
        // index stage 3) goes into a sibling folder for this round, with its
        // own _metadata.json so it lists and restores like any backup.
        const backupReplacedVersions = async (round: number) => {
          const raw = await git.raw(['ls-files', '-u', '-z'])
          const replaced: Array<{ file: string; oid: string }> = []
          for (const entry of (raw || '').split('\0')) {
            const tab = entry.indexOf('\t')
            if (tab === -1) continue
            const [, oid, stage] = entry.slice(0, tab).split(' ')
            const file = entry.slice(tab + 1)
            if (stage === '3' && !savedVersions.get(file)?.has(oid)) replaced.push({ file, oid })
          }
          if (replaced.length === 0) return
          const roundPath = `${backupPath}_${round}`
          for (const { file, oid } of replaced) {
            const content = await catFile(oid).catch(() => null)
            if (!content) continue // unreadable object: nothing more to save for this path
            const destPath = path.join(roundPath, backupPrefix, file)
            fs.mkdirSync(path.dirname(destPath), { recursive: true })
            fs.writeFileSync(destPath, content)
            markSaved(file, content)
          }
          fs.writeFileSync(
            path.join(roundPath, '_metadata.json'),
            JSON.stringify({
              timestamp: deps.now().toISOString(),
              reason: 'conflict',
              conflictFiles: replaced.map(r => shownPath(r.file)),
              deletedConflictFiles: [],
              message: commitMessage || 'Sync from AI Company Builder',
              note: 'earlier local version replaced while replaying unpushed commits',
            }, null, 2)
          )
          log.log(`Git sync: Backed up ${replaced.length} earlier local version(s) to ${roundPath}`)
        }

        // A rebase replays commits one by one and pauses on every pick that
        // conflicts, so resolution has to be a loop: back up local, take the
        // server version, continue — until the rebase finishes. The old code
        // handled a single round and then fell back to `rebase --skip`,
        // which silently dropped a commit whenever a second pick conflicted.
        const MAX_ROUNDS = 200 // hard stop against a livelock
        for (let round = 1; rebaseInProgress(); round++) {
          if (round > MAX_ROUNDS) {
            log.error('Git sync: Conflict resolution did not converge, aborting rebase')
            await git.rebase(['--abort']).catch(() => { /* best effort */ })
            return {
              success: false,
              errorType: 'conflict',
              error: '競合の自動解消が収束しませんでした。変更はローカルに保存されています。もう一度同期してください。'
            }
          }

          const statusNow = await git.status()
          if (statusNow.conflicted.length > 0) {
            hadConflicts = true
            log.log(`Git sync: Conflict detected in ${statusNow.conflicted.length} files (round ${round})`)
            const newConflicts = statusNow.conflicted.filter(f => !conflictFiles.includes(f))
            conflictFiles.push(...newConflicts)

            // a. Backup local versions (works for server-deleted files too:
            // the content is read out of localHash, not the worktree), then
            // b. adopt whatever the server decided, c. mark resolved.
            try {
              await backupConflictFiles(newConflicts)
              await backupReplacedVersions(round)
            } catch (backupError) {
              // Nothing may be replaced without its copy. The local work is
              // committed, so undoing this sync's own rebase keeps all of it.
              log.error('Git sync: Could not back up conflicted files, aborting rebase:', backupError)
              await git.rebase(['--abort']).catch(() => { /* best effort: the next sync cleans up */ })
              return { success: false, errorType: 'conflict', error: conflictBackupFailedMessage(backupError) }
            }
            try {
              // Never hand every conflicted path to a single `checkout --ours`:
              // one modify/delete conflict makes that call fail atomically and
              // nothing at all gets resolved. Split by stage 2 first.
              const { take, drop } = await classifyConflicts(git)
              if (take.length > 0) {
                // --ours during a rebase means upstream / server, the inverse
                // of its meaning during a merge. Do not "fix" this to --theirs.
                log.log(`Git sync: Taking the server version of ${take.length} file(s)...`)
                await git.checkout(['--ours', '--', ...take])
                // -f: the member's side may have just excluded the folder
                // (a shared folder with a stray .git, answered "exclude"), and
                // a plain add refuses ignored paths — the same pick then fails
                // on every sync. The server version is being taken, so the
                // member's ignore rules do not apply to it.
                // --sparse: in a sparse checkout the path can lie outside the cone
                // (the member created a root folder the server did not have when
                // the cone was last set); without it git refuses to update the
                // index and the pick fails on every sync (found by the partial-
                // clone soak). No effect on a full checkout.
                await git.add(['-f', '--sparse', '--', ...take])
              }
              if (drop.length > 0) {
                // The server deleted these; following the deletion is the same
                // "server wins" policy applied to a file that no longer exists.
                log.log(`Git sync: Following the server deletion of ${drop.length} file(s)...`)
                await git.raw(['rm', '--force', '--quiet', '--sparse', '--', ...drop])
                for (const file of drop) {
                  if (!deletedConflictFiles.includes(file)) deletedConflictFiles.push(file)
                }
                writeBackupMetadata()
              }
            } catch (resolveError) {
              // A raw git failure here used to escape the whole handler, leaving
              // the rebase in progress and reporting an English git message as
              // errorType 'unknown'. Stop safely instead: the local work is
              // committed and the local versions are already in .backups/.
              const msg = resolveError instanceof Error ? resolveError.message : String(resolveError)
              log.error('Git sync: Failed to resolve conflicts, aborting rebase:', msg)
              await git.rebase(['--abort']).catch(() => { /* best effort */ })
              return {
                success: false,
                errorType: 'conflict',
                error: `競合を自動で解消できませんでした。変更はローカルに保存されています。競合したファイルのローカル版は .backups/ に保存済みです。\n${msg}`
              }
            }
          }

          try {
            log.log('Git sync: Continuing rebase...')
            await git.rebase(['--continue'])
          } catch (continueError) {
            const msg = continueError instanceof Error ? continueError.message : String(continueError)
            if (!rebaseInProgress()) {
              break // the rebase actually finished (e.g. the final pick was empty)
            }
            if (/empty|no changes|nothing to commit/i.test(msg)) {
              // Taking the server version left this pick with no content of
              // its own — skipping it is correct here (and only here).
              log.log('Git sync: Pick became empty, skipping...')
              await git.rebase(['--skip']).catch(() => { /* next round handles new conflicts */ })
            } else if ((await git.status()).conflicted.length === 0) {
              // Stuck for an unknown reason. Never guess with --skip (it
              // drops a commit) — abort and surface the error instead.
              log.error('Git sync: Cannot continue rebase, aborting:', msg)
              await git.rebase(['--abort']).catch(() => { /* best effort */ })
              return {
                success: false,
                errorType: 'conflict',
                error: `同期を安全に完了できませんでした（rebaseを継続できません）。変更はローカルに保存されています。\n${msg}`
              }
            }
            // else: the next pick conflicted — the loop resolves it next round
          }
        }
      }
    }

    // 4.4. Union merging can leave a line twice in a .gitignore (both sides
    //      added it in different places). Drop the copies the merge added
    //      before they reach the team.
    try {
      await tidyMergedGitignores({ git, repoPath, localHash, log })
    } catch (tidyError) {
      log.warn('Git sync: Could not tidy merged .gitignore files:', tidyError)
    }

    // 4.42. A line this member moved to .git/info/exclude can come back with
    //       the pull (two removals of neighbouring lines meet in the union
    //       merge, which keeps both). Move it again now, in one commit, so the
    //       shared file converges instead of trading lines sync after sync.
    try {
      const again = await moveOwnLinesToLocal(git, repoPath, { threshold: deps.largeFileThreshold ?? LARGE_FILE_THRESHOLD, skills: !isScope })
      if (again.largeFiles.length + again.skills.length > 0) {
        await git.raw(['add', '--sparse', '--', '.gitignore'])
        await git.commit('Move ignore lines kept on this computer out of .gitignore after merging')
        log.log('Git sync: Moved own .gitignore lines again after merging:', again.largeFiles.length + again.skills.length)
      }
    } catch (moveError) {
      log.warn('Git sync: Could not move own .gitignore lines after merging:', moveError)
    }

    // 4.45. Never let a gitlink of an excluded nested repository through
    //       (the rebase replays only commits made after it was untracked,
    //       and the server refuses gitlinks, so this is a backstop).
    if (excludedNestedRepoPaths.length > 0 && (await git.revparse(['HEAD'])).trim() !== localHash) {
      try {
        const retracked: string[] = []
        for (const repo of excludedNestedRepoPaths) retracked.push(...await gitlinksUnder(git, repo))
        if (retracked.length > 0) {
          await git.raw(['rm', '--cached', '-q', '--sparse', '--', ...retracked])
          await git.commit(`Stop sharing nested Git repositories: ${retracked.join(', ')}`)
          log.log('Git sync: Untracked excluded nested repos again after merging:', retracked)
        }
      } catch (untrackError) {
        log.warn('Git sync: Could not untrack excluded nested repos after merging:', untrackError)
      }
    }

    // 4.5. Protect department folders (restore if deleted locally)
    //       Runs AFTER pull so that renames from the server are already applied.
    if (companyId && !isScope) {
      try {
        // Folders not downloaded on this computer (sparse exclusions that
        // are applied): a department among them is absent on purpose.
        const notDownloaded = await appliedExclusions(git, repoPath).catch(() => [] as string[])

        const departments = await deps.api.getDepartments(companyId)
        if (departments) {
          for (const dept of departments) {
            if (!dept.folder || dept.folder.includes('..') || path.isAbsolute(dept.folder)) {
              log.warn(`Git sync: Skipping invalid department folder: ${dept.folder}`)
              continue
            }
            if (isNotDownloaded(notDownloaded, dept.folder)) {
              continue
            }

            const deptPath = path.join(repoPath, dept.folder)
            if (!fs.existsSync(deptPath)) {
              // Everything in it may be in excluded sub-folders: then the
              // folder is legitimately absent (a deletion the member made
              // was already confirmed by the deleted-files warning).
              if (exclusionsInside(notDownloaded, dept.folder).length > 0) continue
              log.log(`Git sync: Restoring deleted department folder: ${dept.folder}`)
              try {
                await git.checkout(['origin/main', '--', dept.folder])
                restoredFolders.push(dept.folder)
              } catch (restoreError) {
                log.warn(`Git sync: Could not restore ${dept.folder}, creating empty:`, restoreError)
                fs.mkdirSync(deptPath, { recursive: true })
                fs.writeFileSync(path.join(deptPath, '.gitkeep'), '')
                restoredFolders.push(dept.folder)
              }
            }
          }

          // If any folders were restored, stage and commit them
          if (restoredFolders.length > 0) {
            await stageAll()
            const restoreStatus = await git.status()
            if (restoreStatus.staged.length > 0) {
              await git.commit(`Restore department folders: ${restoredFolders.join(', ')}`)
            }
          }
        }
      } catch (apiError) {
        log.warn('Git sync: Could not fetch departments for folder protection:', apiError)
      }
    }

    // 5. Push (only if we have local changes to push). Commits left unpushed
    //    by an earlier sync also count: a push the server rejected (e.g. a
    //    protected config change the member cancelled out of) writes no
    //    PENDING_PUSH, and without this check the next sync with no new edits
    //    would report success while those commits never reach the team.
    let unpushedCommits = 0
    try {
      unpushedCommits = Number((await git.raw(['rev-list', '--count', 'origin/main..HEAD'])).trim()) || 0
    } catch {
      // No origin/main yet (first sync) — hasLocalChanges decides as before.
    }
    if (!hasLocalChanges && !hadConflicts && unpushedCommits === 0) {
      // No local changes and no conflicts — just pulled remote changes
      let successMessage = restoredFolders.length > 0
        ? `部署フォルダを復元しました: ${restoredFolders.join(', ')}`
        : '同期が完了しました'
      if (ignoredLargeFiles.length > 0) {
        successMessage += `（${ignoredLargeFiles.length}個の大容量ファイルを同期対象外にしました）`
      }
      return {
        success: true,
        message: successMessage,
        restoredFolders,
        ignoredLargeFiles,
        excludedNestedRepos: newlyExcludedNestedRepos
      }
    }

    // Set when a SECRET_DETECTED rejection was resolved by squashing: the
    // secret was only in an earlier, unpushed version.
    let secretSquashed = false
    const secretNote = () => secretSquashed
      ? '前回検出されたシークレットは最新の版から削除されていたため、途中の版をまとめて共有しました（シークレットは共有されていません）。'
      : ''
    // Set when a PERSONAL_PATH rejection was resolved by untracking files.
    let personalUntrack = null as PersonalUntrackResult | null // widened: assigned inside nested try
    // Set when a LOCAL_ONLY_PATH rejection was resolved by untracking files.
    let localOnlyUntracked = null as string[] | null
    const personalNote = () => (personalUntrack && personalUntrack.untracked.length > 0
      ? `個人用フォルダ（.personal）のファイル${personalUntrack.untracked.length}件は共有できないため、共有対象から外しました（このPCには残っています）。`
      : '') + (localOnlyUntracked && localOnlyUntracked.length > 0
      ? `バックアップ・作業用フォルダ（.backups / .workspace）のファイル${localOnlyUntracked.length}件は共有できないため、共有対象から外しました（このPCには残っています）。`
      : '')

    try {
      log.log('Git sync: Pushing to origin...')
      try {
        await pushToServer()
      } catch (firstPushError) {
        // `.personal/` content is never shared, for anyone (the server rejects
        // it with PERSONAL_PATH). It is the member's private file, so the fix
        // is to untrack it — keep it on disk — not to restore a server version.
        // No dialog: nothing is lost and there is no choice to make. The
        // commits are squashed because the hook checks every commit in the
        // range. A remaining rejection (e.g. PROTECTED_CONFIG reported in the
        // same push) falls through to the handling below.
        const firstMsg = firstPushError instanceof Error ? firstPushError.message : String(firstPushError)
        const personalRejected = isPersonalPathRejection(firstMsg)
        const reservedRejected = isReservedPathRejection(firstMsg)
        const localOnlyRejected = isLocalOnlyPathRejection(firstMsg)
        if (!personalRejected && !reservedRejected && !localOnlyRejected) throw firstPushError
        // [LOCAL_ONLY_PATH]: .backups/ or .workspace/ content (any depth) is
        // never shared. Like .personal: untrack (kept on disk), no dialog.
        let localOnlyCommitted = false
        if (localOnlyRejected) {
          const localOnlyFiles = parseLocalOnlyPaths(firstMsg)
          log.warn('Git sync: Push rejected — .backups/.workspace content:', localOnlyFiles.length)
          try {
            const r = await untrackLocalOnlyPaths({ git, repoPath, paths: localOnlyFiles })
            localOnlyCommitted = r.committed
            localOnlyUntracked = r.untracked
          } catch (untrackError) {
            const msg = untrackError instanceof Error ? untrackError.message : String(untrackError)
            return {
              success: false,
              errorType: 'local_only_path' as const,
              localOnlyFiles,
              error: `${localOnlyPathMessage(localOnlyFiles)}\n\n${untrackError instanceof ProtectedConfigRecoveryError ? msg : `共有対象から外せませんでした。変更はこのPCに残っています。\n${msg}`}`,
            }
          }
        }
        if (personalRejected) {
          const personalFiles = parsePersonalPaths(firstMsg)
          log.warn('Git sync: Push rejected — .personal/ content:', personalFiles)
          try {
            personalUntrack = await untrackPersonalPaths({ git, repoPath, paths: personalFiles })
          } catch (untrackError) {
            const msg = untrackError instanceof Error ? untrackError.message : String(untrackError)
            return {
              success: false,
              errorType: 'personal_path' as const,
              personalFiles,
              error: `${personalPathMessage(personalFiles)}\n\n${untrackError instanceof ProtectedConfigRecoveryError ? msg : `共有対象から外せませんでした。変更はこのPCに残っています。\n${msg}`}`,
            }
          }
        }
        // [RESERVED_PATH]: a folder named like a private folder the member
        // cannot see (the path check above could not answer). Like
        // PERSONAL_PATH there is no choice to make, but the files cannot stay
        // in place — the next sync would stage them again: back them up to
        // .backups/<ts>_reserved_path/, take them out of the commit and off
        // the disk, and push once more. Never in a loop: a second rejection
        // is reported (no PENDING_PUSH).
        let reservedCommitted = false
        if (reservedRejected) {
          const rejection = parseReservedPathRejection(firstMsg)
          log.warn('Git sync: Push rejected — reserved folder name:', rejection.paths)
          const reservedError = (detail: string) => ({
            success: false,
            errorType: 'reserved_path' as const,
            reservedPathFiles: rejection.paths,
            error: `使えない名前のフォルダにファイルがあるため、同期できませんでした。\n${rejection.reasons.join('\n')}\n\n${detail}`,
          })
          if (rejection.paths.length === 0) return reservedError('もう一度同期してください。')
          try {
            const recovery = await untrackReservedPaths({
              git, repoPath, rejection, backupPath: `${backupPath}_reserved_path`, now: deps.now(),
              keepOnDisk: p => isUnderAny(privatePaths, p),
            })
            reservedCommitted = recovery.committed
            const before = effects.reserved
            effects.reserved = {
              files: [...(before?.files ?? []), ...recovery.files],
              folders: [...new Set([...(before?.folders ?? []), ...recovery.folders])],
              backupPath: recovery.backupPath,
              reasons: recovery.reasons,
            }
          } catch (untrackError) {
            const msg = untrackError instanceof Error ? untrackError.message : String(untrackError)
            return reservedError(untrackError instanceof ProtectedConfigRecoveryError ? msg : `共有対象から外せませんでした。変更はこのPCに残っています。\n${msg}`)
          }
        }
        if (personalUntrack?.committed || reservedCommitted || localOnlyCommitted) {
          await pushToServer()
        }
      }
    } catch (pushError) {
      const pushErrorMsg = pushError instanceof Error ? pushError.message : String(pushError)

      // Two rejections share one way out because the hook checks every commit
      // in the pushed range for both — the rejected change is already
      // committed locally, so a plain retry (or a revert commit on top)
      // would fail at this same step forever:
      //  - PROTECTED_CONFIG: only an owner/admin may change agent-execution
      //    config (.claude/settings.json, .mcp.json, .claude/hooks/ ... —
      //    Claude Code runs the commands in them without a prompt).
      //  - WRITE_DENIED: the member has no write permission for the folder.
      // Ask first (both questions before anything changes), then put just
      // those paths back to the server's version (member's copy saved in
      // .backups/ first), squash the unpushed commits without them, push
      // again — once, for both. Never write PENDING_PUSH for this.
      const hasProtected = isProtectedConfigRejection(pushErrorMsg)
      const hasWriteDenied = isWriteDeniedRejection(pushErrorMsg)
      if (hasProtected || hasWriteDenied) {
        const protectedFiles = hasProtected ? parseProtectedConfigPaths(pushErrorMsg) : []
        const writeDeniedListed = hasWriteDenied ? parseWriteDeniedPaths(pushErrorMsg) : []
        // A path in both lists is handled once, as protected config.
        const writeDeniedFiles = writeDeniedListed.filter(p => !protectedFiles.includes(p))
        if (hasProtected) log.warn('Git sync: Push rejected — protected config changed by a non-admin:', protectedFiles)
        if (hasWriteDenied) log.warn('Git sync: Push rejected — no write permission:', writeDeniedListed)
        const protectedError = `${protectedConfigMessage(protectedFiles)}\n\nもう一度同期ボタンを押すと、これらのファイルをサーバーの状態に戻して同期できます。配布が必要な場合は管理者に依頼してください。`
        const writeDeniedError = `${writeDeniedMessage(writeDeniedListed)}\n\nもう一度同期ボタンを押すと、これらのファイルを元に戻して残りの変更を同期できます。編集が必要な場合は、そのフォルダの管理者に権限を依頼してください。`
        const rejectionError = (p: boolean, w: boolean, pFiles: string[], wFiles: string[]) => [
          p ? `${protectedConfigMessage(pFiles)}` : '',
          w ? `${writeDeniedMessage(wFiles)}` : '',
        ].filter(Boolean).join('\n\n')
        const rejected = {
          success: false,
          errorType: (hasProtected ? 'protected_config' : 'write_denied') as 'protected_config' | 'write_denied',
          protectedFiles: hasProtected ? protectedFiles : undefined,
          writeDeniedFiles: hasWriteDenied ? writeDeniedListed : undefined,
          error: [hasProtected ? protectedError : '', hasWriteDenied ? writeDeniedError : ''].filter(Boolean).join('\n\n'),
          hadConflicts,
          conflictFiles,
          deletedConflictFiles,
          backupPath: hadConflicts ? backupPath : undefined,
        }
        if (!deps.dialog.canAsk() || (hasProtected && protectedFiles.length === 0) || (hasWriteDenied && writeDeniedListed.length === 0)) {
          return rejected
        }

        if (hasProtected) {
          const choice = await deps.dialog.confirmProtectedConfigRestore(protectedFiles)
          if (choice === 'cancel') {
            return { ...rejected, errorType: 'protected_config' as const, error: `同期を中止しました。\n\n${rejected.error}` }
          }
        }
        if (writeDeniedFiles.length > 0) {
          const choice = await deps.dialog.confirmWriteDeniedRestore(writeDeniedFiles)
          if (choice === 'cancel') {
            return { ...rejected, errorType: 'write_denied' as const, error: `同期を中止しました。\n\n${rejected.error}` }
          }
        }

        // Wording for what was refused: admin-only config, a folder the
        // member may not edit, or both.
        const refusedWhat = hasProtected && hasWriteDenied
          ? '共有できない'
          : hasProtected ? (onlySkillFiles(protectedFiles) ? '変更できないスキルの' : '管理者だけが変更できる') : '編集する権限がないフォルダの'

        // First try keeping every file as the member has it now. The hook
        // checks every commit in the range, so a change the member has since
        // undone (e.g. took the auto-run setting out of a skill after the
        // first rejection, or put back a file in a folder they may not edit)
        // blocks the push only until the intermediate commit is squashed
        // away. Restoring right away would throw away — or, for a new skill,
        // remove — the member's now-acceptable final version.
        let protectedToRestore = protectedFiles
        let writeDeniedToRestore = writeDeniedFiles
        try {
          const squash = await squashUnpushedCommits({ git })
          if (squash.squashed) {
            if (squash.committed) await pushToServer()
            if (fs.existsSync(pendingPushFile)) fs.unlinkSync(pendingPushFile)
            const parts = [`同期完了。${refusedWhat}内容は最新の版には残っていなかったため、ファイルは戻さずにそのまま共有しました。`]
            if (hadConflicts) parts.push(`${conflictFiles.length}ファイルが競合したため、サーバー版を採用しました（競合前のローカル版も .backups/ にあります）。`)
            parts.push(personalNote())
            if (!squash.committed) parts.push('共有する変更は他にありませんでした。')
            return {
              success: true,
              message: parts.join(''),
              untrackedPersonalFiles: personalUntrack?.untracked,
              restoredProtectedFiles: hasProtected ? [] : undefined,
              restoredWriteDeniedFiles: hasWriteDenied ? [] : undefined,
              hadConflicts,
              conflictFiles,
              deletedConflictFiles,
              backupPath: hadConflicts ? backupPath : undefined,
              restoredFolders,
              ignoredLargeFiles,
              excludedNestedRepos: newlyExcludedNestedRepos
            }
          }
        } catch (squashError) {
          const squashMsg = squashError instanceof Error ? squashError.message : String(squashError)
          if (squashError instanceof ProtectedConfigRecoveryError) return { ...rejected, error: squashMsg }
          const stillProtected = isProtectedConfigRejection(squashMsg)
          const stillWriteDenied = isWriteDeniedRejection(squashMsg)
          if (stillProtected || stillWriteDenied) {
            // Still rejected: restore exactly what the final version still
            // has. A section that is gone was resolved by the squash.
            if (stillProtected) {
              const still = parseProtectedConfigPaths(squashMsg)
              if (still.length > 0) protectedToRestore = still
            } else {
              protectedToRestore = []
            }
            if (stillWriteDenied) {
              const still = parseWriteDeniedPaths(squashMsg)
              if (still.length > 0) writeDeniedToRestore = still
              writeDeniedToRestore = writeDeniedToRestore.filter(p => !protectedToRestore.includes(p))
            } else {
              writeDeniedToRestore = []
            }
          } else if (squashMsg.includes('SECRET_DETECTED')) {
            return secretDetectedResult(squashMsg)
          } else {
            // Ordinary push failure (network, a teammate pushed in between):
            // the squashed commit stays local and the next sync retries it.
            log.error('Git sync: Push after squashing unpushed commits failed:', squashMsg)
            fs.writeFileSync(pendingPushFile, deps.now().toISOString())
            return {
              success: false,
              error: 'ローカルにコミットしましたが、プッシュに失敗しました。次回の同期で再試行します。',
              errorType: 'push_failed' as const,
              pushFailed: true,
            }
          }
        }

        const stamp = deps.now().toISOString().replace(/[:.]/g, '-').slice(0, 23)
        let protectedRecovery = null as ProtectedConfigRecoveryResult | null
        let writeDeniedRecovery = null as ProtectedConfigRecoveryResult | null
        try {
          // One after the other, without pushing in between: each squashes
          // the unpushed commits (the second only the first one's commit).
          if (protectedToRestore.length > 0) {
            protectedRecovery = await restoreProtectedPaths({
              git, repoPath, paths: protectedToRestore, backupPath: path.join(backupsDir, `${stamp}_protected`), backupPrefix: opts.backupPrefix,
            })
          }
          if (writeDeniedToRestore.length > 0) {
            writeDeniedRecovery = await restoreProtectedPaths({
              git, repoPath, paths: writeDeniedToRestore, backupPath: path.join(backupsDir, `${stamp}_write_denied`), reason: 'write_denied', backupPrefix: opts.backupPrefix,
            })
          }
        } catch (recoveryError) {
          const msg = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          log.error(hasProtected ? 'Git sync: Protected config recovery failed:' : 'Git sync: Write-denied recovery failed:', msg)
          return {
            ...rejected,
            error: recoveryError instanceof ProtectedConfigRecoveryError
              ? msg
              : `ファイルをサーバーの状態に戻せませんでした。変更はこのPCに残っています。\n${msg}`,
          }
        }
        // Nothing left to restore (should not happen) — report the rejection
        // rather than claim success with commits still unpushed.
        if (!protectedRecovery && !writeDeniedRecovery) return rejected
        const revertedProtected = protectedRecovery ? [...protectedRecovery.restored, ...protectedRecovery.removed] : []
        const revertedWriteDenied = writeDeniedRecovery ? [...writeDeniedRecovery.restored, ...writeDeniedRecovery.removed] : []
        const recoveryBackupPath = protectedRecovery?.backupPath ?? writeDeniedRecovery?.backupPath ?? undefined
        const reverted = {
          restoredProtectedFiles: hasProtected ? revertedProtected : undefined,
          protectedBackupPath: protectedRecovery?.backupPath ?? undefined,
          restoredWriteDeniedFiles: hasWriteDenied ? revertedWriteDenied : undefined,
          writeDeniedBackupPath: writeDeniedRecovery?.backupPath ?? undefined,
        }
        // The later restore saw the final state of the unpushed commits.
        const committed = (writeDeniedRecovery ?? protectedRecovery)?.committed ?? false

        if (committed) {
          try {
            await pushToServer()
          } catch (retryError) {
            const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
            const againProtected = isProtectedConfigRejection(retryMsg)
            const againWriteDenied = isWriteDeniedRejection(retryMsg)
            if (againProtected || againWriteDenied) {
              const remainingProtected = againProtected ? parseProtectedConfigPaths(retryMsg) : []
              const remainingWriteDenied = againWriteDenied ? parseWriteDeniedPaths(retryMsg) : []
              return {
                ...rejected,
                errorType: (againProtected ? 'protected_config' : 'write_denied') as 'protected_config' | 'write_denied',
                protectedFiles: againProtected ? remainingProtected : undefined,
                writeDeniedFiles: againWriteDenied ? remainingWriteDenied : undefined,
                error: rejectionError(againProtected, againWriteDenied, remainingProtected, remainingWriteDenied),
              }
            }
            if (retryMsg.includes('SECRET_DETECTED')) return secretDetectedResult(retryMsg)
            // The local history is clean now; an ordinary push failure (network,
            // a teammate pushed in between) is retried by the next sync.
            log.error(hasProtected ? 'Git sync: Push after protected config recovery failed:' : 'Git sync: Push after write-denied recovery failed:', retryMsg)
            fs.writeFileSync(pendingPushFile, deps.now().toISOString())
            return {
              success: false,
              error: hasProtected && !hasWriteDenied
                ? `${refusedWhat}ファイルをサーバーの状態に戻しましたが、プッシュに失敗しました。次回の同期で再試行します。`
                : `${refusedWhat}ファイルを元に戻しましたが、プッシュに失敗しました。次回の同期で再試行します。`,
              errorType: 'push_failed' as const,
              pushFailed: true,
              ...reverted,
            }
          }
        }
        if (fs.existsSync(pendingPushFile)) fs.unlinkSync(pendingPushFile)

        const parts = ['同期完了。']
        if (hasProtected) parts.push(`${onlySkillFiles(revertedProtected) ? '変更できないスキルの' : '管理者だけが変更できる'}ファイル（${revertedProtected.length}件）はサーバーの状態に戻しました。`)
        if (hasWriteDenied) parts.push(`編集する権限がないフォルダのファイル（${revertedWriteDenied.length}件）は元に戻しました。`)
        if (recoveryBackupPath) parts.push('あなたが編集した版は .backups/ に保存してあります。')
        if (hadConflicts) parts.push(`${conflictFiles.length}ファイルが競合したため、サーバー版を採用しました（競合前のローカル版も .backups/ にあります）。`)
        parts.push(personalNote())
        parts.push(committed ? 'その他の変更は正常に反映されました。' : '共有する変更は他にありませんでした。')
        return {
          success: true,
          message: parts.join(''),
          untrackedPersonalFiles: personalUntrack?.untracked,
          ...reverted,
          hadConflicts,
          conflictFiles,
          deletedConflictFiles,
          backupPath: hadConflicts ? backupPath : recoveryBackupPath,
          restoredFolders,
          ignoredLargeFiles,
          excludedNestedRepos: newlyExcludedNestedRepos
        }
      }

      // Still rejected for .backups/.workspace content after untracking
      // (should not happen): report, no PENDING_PUSH, no loop.
      if (isLocalOnlyPathRejection(pushErrorMsg)) {
        const localOnlyFiles = parseLocalOnlyPaths(pushErrorMsg)
        return {
          success: false,
          errorType: 'local_only_path' as const,
          localOnlyFiles,
          error: `${localOnlyPathMessage(localOnlyFiles)}\n\nもう一度同期してください。`,
        }
      }

      // Still rejected for a reserved folder name after the recovery above
      // (should not happen): report it, no PENDING_PUSH, no loop.
      if (isReservedPathRejection(pushErrorMsg)) {
        const rejection = parseReservedPathRejection(pushErrorMsg)
        return {
          success: false,
          errorType: 'reserved_path' as const,
          reservedPathFiles: rejection.paths,
          error: `使えない名前のフォルダにファイルがあるため、同期できませんでした。\n${rejection.reasons.join('\n')}\n\nもう一度同期してください。`,
        }
      }

      // Still rejected for .personal/ content after untracking (should not
      // happen) — stop without PENDING_PUSH rather than retry forever.
      if (isPersonalPathRejection(pushErrorMsg)) {
        const personalFiles = parsePersonalPaths(pushErrorMsg)
        return {
          success: false,
          errorType: 'personal_path' as const,
          personalFiles,
          error: `${personalPathMessage(personalFiles)}\n\nもう一度同期してください。`,
        }
      }

      // SECRET_DETECTED: the hook scans every commit in the push, not just
      // the final state. A secret the member has since removed (the first
      // rejection told them to) still blocks the push through the commit
      // that added it — a plain retry would be refused forever. So, like
      // the first step of PROTECTED_CONFIG: squash the unpushed commits into
      // one with the files as they are now (only onto an origin/main that
      // is an ancestor of HEAD) and push once more. If the secret is still
      // in the files, that push is refused too: report it, no PENDING_PUSH.
      // The secret is never removed on the member's behalf.
      if (pushErrorMsg.includes('SECRET_DETECTED')) {
        log.warn('Git sync: Push rejected — secret detected')
        try {
          const squash = await squashUnpushedCommits({ git })
          // Zero or one unpushed commit: the secret is in the current files.
          if (!squash.squashed) return secretDetectedResult(pushErrorMsg)
          if (squash.committed) await pushToServer()
          secretSquashed = true
          log.log('Git sync: Pushed the unpushed commits squashed into one — the secret was only in an earlier version')
        } catch (squashError) {
          const squashMsg = squashError instanceof Error ? squashError.message : String(squashError)
          if (squashMsg.includes('SECRET_DETECTED')) return secretDetectedResult(squashMsg)
          // origin/main is not an ancestor (should not happen right after the
          // rebase): nothing was changed — report the rejection as it was.
          if (squashError instanceof ProtectedConfigRecoveryError) return secretDetectedResult(pushErrorMsg)
          // Ordinary push failure (network, a teammate pushed in between):
          // the squashed commit holds no secret, the next sync retries it.
          log.error('Git sync: Push after squashing unpushed commits failed:', squashMsg)
          fs.writeFileSync(pendingPushFile, deps.now().toISOString())
          return {
            success: false,
            error: 'ローカルにコミットしましたが、プッシュに失敗しました。次回の同期で再試行します。',
            errorType: 'push_failed' as const,
            pushFailed: true,
            hadConflicts,
            conflictFiles,
            deletedConflictFiles,
            backupPath: hadConflicts ? backupPath : undefined,
            restoredFolders,
            ignoredLargeFiles,
            excludedNestedRepos: newlyExcludedNestedRepos
          }
        }
      } else if (pushErrorMsg.includes(WINPATH_MARKER)) {
        // The name decides, so a retry would be refused the same way: no
        // PENDING_PUSH, and the member is told which file.
        log.warn('Git sync: Push rejected — a name other computers cannot hold')
        return { success: false, errorType: 'path_name', error: winPathMessage(parseWinPathFiles(pushErrorMsg)) }
      } else {
        log.error('Git sync: Push to main failed:', pushErrorMsg)
        // Try master branch if main fails
        try {
          await pushToServer('master')
        } catch (masterPushError) {
          // Check secret detection on master push too
          const masterErrorMsg = masterPushError instanceof Error ? masterPushError.message : String(masterPushError)
          if (masterErrorMsg.includes('SECRET_DETECTED')) return secretDetectedResult(masterErrorMsg)
          log.error('Git sync: Push to master also failed:', masterErrorMsg)
          // Record pending push for retry on next sync
          const pendingPushFile = path.join(repoPath, '.git', 'PENDING_PUSH')
          fs.writeFileSync(pendingPushFile, deps.now().toISOString())
          return {
            success: false,
            error: 'ローカルにコミットしましたが、プッシュに失敗しました。次回の同期で再試行します。',
            errorType: 'push_failed' as const,
            pushFailed: true,
            hadConflicts,
            conflictFiles,
            deletedConflictFiles,
            backupPath: hadConflicts ? backupPath : undefined,
            restoredFolders,
            ignoredLargeFiles,
            excludedNestedRepos: newlyExcludedNestedRepos
          }
        }
      }
    }

    // Push succeeded — clean up pending push marker if exists
    if (fs.existsSync(pendingPushFile)) {
      fs.unlinkSync(pendingPushFile)
    }

    // Success
    if (hadConflicts) {
      // A file the server deleted has to be reported as deleted, not as
      // "overwritten" — otherwise the user cannot tell why it vanished.
      const overwrittenFiles = conflictFiles.filter(f => !deletedConflictFiles.includes(f))
      const outcomes: string[] = []
      if (overwrittenFiles.length > 0) outcomes.push(`${overwrittenFiles.length}件はサーバー版で上書き`)
      if (deletedConflictFiles.length > 0) {
        outcomes.push(`${deletedConflictFiles.length}件はサーバー側で削除されていたため削除`)
      }
      return {
        success: true,
        message: `同期完了。${conflictFiles.length}ファイルが競合しました（${outcomes.join('、')}）。競合前のローカル版は .backups/ に保存してあります。${personalNote()}${secretNote()}その他の変更は正常に反映されました。`,
        untrackedPersonalFiles: personalUntrack?.untracked,
        hadConflicts: true,
        conflictFiles,
        deletedConflictFiles,
        backupPath,
        restoredFolders,
        ignoredLargeFiles,
        excludedNestedRepos: newlyExcludedNestedRepos
      }
    }

    let successMessage = '同期が完了しました'
    if (ignoredLargeFiles.length > 0) {
      successMessage += `（${ignoredLargeFiles.length}個の大容量ファイルを同期対象外にしました）`
    }
    if (personalNote()) successMessage += `。${personalNote()}`
    if (secretNote()) successMessage += `。${secretNote()}`

    return {
      success: true,
      message: successMessage,
      untrackedPersonalFiles: personalUntrack?.untracked,
      restoredFolders,
      ignoredLargeFiles,
      excludedNestedRepos: newlyExcludedNestedRepos
    }
  } catch (error) {
    log.error('Git sync error:', error)
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    // Classify error type for UI
    // Another git appeared mid-run (the check before the run found nothing).
    const lockFailure = lockFailureMessage(errorMsg)
    if (lockFailure) return { success: false, error: lockFailure, errorType: 'locked' }
    let errorType = 'unknown'
    if (errorMsg.includes('Could not resolve host') || errorMsg.includes('unable to access') || errorMsg.includes('network')) {
      errorType = 'network'
    } else if (errorMsg.includes('Authentication') || errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('credential')) {
      errorType = 'auth'
    } else if (errorMsg.includes('CONFLICT') || errorMsg.includes('conflict') || errorMsg.includes('rebase')) {
      errorType = 'conflict'
    }
    return { success: false, error: errorMsg, errorType }
  }
}


export interface PrivateFolderSyncReport {
  /** The private folder's company-relative path. */
  path: string
  success: boolean
  message?: string
  error?: string
  errorType?: string
  /** Downloaded (cloned) during this sync. */
  cloned?: boolean
  /** Not downloaded on this computer (settings): its clone was synced one last time and removed. */
  removed?: boolean
  /** Sync set something of the member's aside here (a conflict's version, a recovery copy): worth a lasting notice. */
  setAside?: boolean
  /** Where that was kept. */
  backupPath?: string
}

export type GitSyncResult = Awaited<ReturnType<typeof runSync>> & {
  /** Files created inside a folder that is not checked out, moved to outsideCheckoutBackupPath instead of being shared. */
  outsideCheckoutFiles?: string[]
  outsideCheckoutBackupPath?: string
  /** Files of an excluded nested repository a teammate's same-path files replaced; this computer's versions are in nestedRepoBackupPath. */
  nestedRepoBackupFiles?: string[]
  nestedRepoBackupPath?: string
  /** Files in a folder named like a private folder ([RESERVED_PATH]), moved to reservedPathBackupPath instead of being shared. */
  reservedPathFiles?: string[]
  reservedPathBackupPath?: string
  /** One entry per readable private folder this sync handled. */
  privateFolders?: PrivateFolderSyncReport[]
  /** Private folders deleted because the member may no longer read them (Q1: no backup). */
  lostPrivateFolders?: string[]
  /** Private folders made public: they now sync with the company folder. */
  madePublicFolders?: string[]
  madePublicBackupPath?: string
  /** Private folders downloaded for the first time during this sync. */
  newPrivateFolders?: string[]
  /** Private folders whose place held something else: moved to movedAsideBackupPath first. */
  movedAsideFolders?: string[]
  movedAsideBackupPath?: string
  /** Large files kept on this computer that a teammate shared at the same path; this computer's versions are in largeFileBackupPath. */
  largeFileBackupFiles?: string[]
  largeFileBackupPath?: string
  /** On disk when an operation an earlier run left half-way was cleaned up; copied to recoveryBackupPath. */
  recoveredFiles?: string[]
  recoveryBackupPath?: string
}

type RunResult = Awaited<ReturnType<typeof runSync>>

/** Append notes to whatever text field the result carries (message on success, error otherwise). */
function withNotes(result: GitSyncResult | RunResult, notes: string[], fields: Partial<GitSyncResult>): GitSyncResult {
  let out = { ...result, ...fields } as GitSyncResult
  for (const note of notes) {
    if (out.success) {
      const message = 'message' in out && typeof out.message === 'string' ? out.message : '同期が完了しました'
      // Every result shape gets the note in its own text field; the union cannot express that per member.
      out = { ...out, message: `${message}${message.endsWith('。') ? '' : '。'}${note}` } as GitSyncResult
    } else {
      const error = 'error' in out && typeof out.error === 'string' ? out.error : ''
      out = { ...out, error: error ? `${error}\n\n${note}` : note } as GitSyncResult
    }
  }
  return out
}

/** Report held-back files on whatever the sync ended with. */
function withSideEffects(result: RunResult, effects: SyncSideEffects): GitSyncResult {
  const notes: string[] = []
  const fields: Partial<GitSyncResult> = {}
  const recovered = effects.beforeRecovery
  if (recovered) {
    notes.push(recoveryNote(recovered))
    Object.assign(fields, { recoveredFiles: recovered.files, recoveryBackupPath: recovered.backupPath })
  }
  const held = effects.outsideCheckout
  if (held) {
    notes.push(outsideCheckoutMessage(held))
    Object.assign(fields, { outsideCheckoutFiles: held.files, outsideCheckoutBackupPath: held.backupPath })
  }
  const overwritten = effects.nestedRepoOverwrite
  if (overwritten) {
    notes.push(nestedRepoOverwriteMessage(overwritten))
    Object.assign(fields, { nestedRepoBackupFiles: overwritten.files, nestedRepoBackupPath: overwritten.backupPath })
  }
  const largeOverwritten = effects.largeFileOverwrite
  if (largeOverwritten) {
    notes.push(largeFileOverwriteMessage(largeOverwritten))
    Object.assign(fields, { largeFileBackupFiles: largeOverwritten.files, largeFileBackupPath: largeOverwritten.backupPath })
  }
  const reserved = effects.reserved
  if (reserved && reserved.files.length > 0) {
    notes.push(reservedPathNote(reserved))
    Object.assign(fields, { reservedPathFiles: reserved.files, reservedPathBackupPath: reserved.backupPath })
  }
  if (notes.length === 0) return result
  return withNotes(result, notes, fields)
}

/** A run the member stopped (a dialog answered with cancel): nothing else runs after it. */
function isCancelled(result: GitSyncResult): boolean {
  const error = 'error' in result && typeof result.error === 'string' ? result.error : ''
  return !result.success && /^同期を中止しました|^同期がキャンセルされました/.test(error)
}

/** How a sync was started: `auto` = 「自動で送る」 (template message, questions stop it). */
export interface SyncRunOptions {
  auto?: boolean
}

/** Shown when 「自動で送る」 stopped at a question (the member's next manual sync asks it). */
export const AUTO_NEEDS_MEMBER_MESSAGE = '自動で送る途中で、確認が必要なことがありました。変更はこのPCに残っています。「サーバーと同期」ボタンを押して続けてください。'

/**
 * The dialog of an automatic send: nothing is decided for the member. Any
 * question cancels (the same as the member pressing キャンセル: nothing
 * changes) and is recorded, so the result can say a manual sync is needed.
 * canAsk stays true: the no-window path would sync deletions unasked.
 */
function askLaterDialog(asked: { value: boolean }): SyncDialog {
  const later = async () => { asked.value = true; return 'cancel' as const }
  return {
    canAsk: () => true,
    confirmSharedNestedRepo: later,
    confirmExternalNestedRepo: later,
    confirmDeletedFiles: later,
    confirmProtectedConfigRestore: later,
    confirmWriteDeniedRestore: later,
    // Not a question that stops automatic sync: it waits, and a later run goes
    // through once the file is closed (its failure notice is shown once).
    confirmOpenFiles: async () => 'wait' as const,
  }
}

export interface GitSync {
  (repoPath: string, companyId: string, commitMessage: string, options?: SyncRunOptions): Promise<GitSyncResult>
  /**
   * 「自動で受け取る」: fast-forward the company repository and each readable
   * private folder's clone to the server, only where nothing of the
   * member's is touched (./receive.ts). Never commits or pushes.
   */
  receive(repoPath: string, companyId: string): Promise<ReceiveResult>
  /** A sync, receive or private-folder change holds a repository lock right now. */
  isRunning(): boolean
  /** Resolves once nothing holds a repository lock (closing the app waits for this). New automatic runs wait from now on, so timers cannot extend it. */
  whenIdle(): Promise<void>
  /** The member stayed after all: automatic runs go on. */
  resumeAutomaticRuns(): void
  /** whenIdle() is holding automatic runs back. */
  automaticRunsHeld(): boolean
  /**
   * Apply the member's download choices for private folders now (settings
   * panel): download a folder that is no longer excluded, and remove the
   * clone of one that is (after syncing it one last time; kept when that
   * fails). Uses the cached /me/scopes answer; runs under the sync lock.
   */
  applyPrivateFolderChoices(repoPath: string, companyId: string): Promise<PrivateFolderSyncReport[]>
  /** The reserved-name checker sync uses (shared cache): for the app's file operations and the chat guard. */
  pathChecker: PathChecker
}

/**
 * Create the sync function. Each instance owns its per-repository lock, so
 * features/sync/wire.ts creates one for the app and each simulated member gets its own.
 *
 * One press syncs the company repository and then every readable private
 * folder (its own repository, cloned at its path inside the company folder),
 * each under its own lock entry and with the same guards. A failure in one
 * does not stop the others; the result summarises all of them.
 */
export function createGitSync(deps: SyncDeps): GitSync {
  // Sync lock per repository to prevent concurrent syncs
  const syncLocks = new Map<string, Promise<unknown>>()
  const pathChecker = createPathChecker((companyId, paths) => deps.api.checkPaths(companyId, paths), { log: deps.log })

  // Serialize per repository. Register our run BEFORE waiting on the
  // previous one — the old code awaited first and registered later, so two
  // clicks queued behind the same sync woke together and ran concurrently
  // (WP-3.1).
  const locked = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = syncLocks.get(key)
    const run = (async () => {
      if (previous) {
        deps.log.log('Git sync: Already syncing, waiting for previous sync to complete...')
        try { await previous } catch { /* previous sync errors belong to its caller */ }
      }
      return fn()
    })()
    syncLocks.set(key, run)
    try {
      return await run
    } finally {
      if (syncLocks.get(key) === run) syncLocks.delete(key)
    }
  }

  // Under the repository's own lock, so no sync or receive of it is running.
  const lockState = (repoPath: string, d: SyncDeps = deps) => clearStaleLocks(repoPath, {
    otherGitRunning: d.otherGitRunning?.() ?? false,
    log: d.log,
  })
  let automaticHeld = false
  const repositoryBusy = { success: false, errorType: 'locked', error: REPOSITORY_BUSY_MESSAGE } as GitSyncResult

  const runOne = async (runDeps: SyncDeps, repoPath: string, companyId: string, commitMessage: string, opts: RunOptions): Promise<GitSyncResult> => {
    if (await lockState(repoPath, runDeps) === 'busy') return repositoryBusy
    const effects: SyncSideEffects = { outsideCheckout: null, reserved: null }
    return withSideEffects(await runSync(runDeps, repoPath, companyId, commitMessage, effects, opts), effects)
  }

  /** Sync one readable private folder's clone. */
  const syncScope = (d: SyncDeps, repoPath: string, companyId: string, commitMessage: string, scope: MyPrivateScope, dir: string): Promise<PrivateFolderSyncReport> =>
    locked(dir, async () => {
      const scopeDeps = { ...d, dialog: prefixedDialog(d.dialog, scope.path) }
      const r = scope.canWrite
        ? await runOne(scopeDeps, dir, companyId, commitMessage, {
            kind: 'scope', backupsDir: privateBackupsDir(repoPath), backupPrefix: scope.path,
          })
        : await lockState(dir, d) === 'busy' ? repositoryBusy : await syncReadOnlyScope(scopeDeps, repoPath, scope, dir)
      const view = r as { success: boolean; message?: string; error?: string; errorType?: string; recoveredFiles?: string[]; recoveryBackupPath?: string; backupPath?: string; outsideCheckoutBackupPath?: string; writeDeniedBackupPath?: string }
      // A private folder's backups are kept inside .git (privateBackupsDir),
      // not in .backups/: say so in the shared wording.
      const where = (text?: string) => text?.replace(/\.backups\/?/g, '非公開フォルダのバックアップ')
      // Anything but the plain success message is something sync did to the member's files.
      const setAside = !!view.recoveredFiles?.length || (view.success && !!view.message && view.message !== '同期が完了しました')
      const backupPath = view.recoveryBackupPath ?? view.backupPath ?? view.outsideCheckoutBackupPath ?? view.writeDeniedBackupPath
      return { path: scope.path, success: view.success, message: where(view.message), error: where(view.error), errorType: view.errorType, setAside, backupPath }
    })

  /** Place every readable private folder and sync (or retire) each clone. */
  const syncPrivateFolders = async (d: SyncDeps, repoPath: string, companyId: string, commitMessage: string, scopes: MyPrivateScope[], options: { syncEach: boolean }) => {
    const reports: PrivateFolderSyncReport[] = []
    const movedAside: Array<{ folder: string; backupPath: string }> = []
    for (const placement of await placePrivateFolders(d, repoPath, scopes)) {
      const { scope } = placement
      if (placement.kind === 'failed') {
        reports.push({ path: scope.path, success: false, errorType: 'network', error: `非公開フォルダをダウンロードできませんでした。\n${placement.error}` })
        continue
      }
      if (placement.movedAside) movedAside.push({ folder: scope.path, backupPath: placement.movedAside })
      if (placement.kind === 'excluded') {
        if (!placement.clone) continue
        // Left out in settings: push its edits first, then remove it.
        const r = await syncScope(d, repoPath, companyId, commitMessage, scope, placement.dir)
        const removed = r.success && await locked(placement.dir, () => removeExcludedClone(d, repoPath, placement.dir)).catch(() => false)
        reports.push({ ...r, removed })
        continue
      }
      if (!options.syncEach && !placement.cloned) continue
      reports.push({ ...(await syncScope(d, repoPath, companyId, commitMessage, scope, placement.dir)), cloned: placement.cloned })
    }
    return { reports, movedAside }
  }

  const syncWith = (runDeps: SyncDeps, repoPath: string, companyId: string, commitMessage: string): Promise<GitSyncResult> =>
    locked(repoPath, async () => {
      // Before the company repository: what changed in the member's access,
      // and the local excludes that keep private content out of it.
      const prep = await preparePrivateFolders(runDeps, repoPath, companyId, pathChecker)
      const cache = prep.cache
      const readable = cache ? [...cache.scopes, ...(cache.pendingPublic ?? [])] : []
      const company = await runOne(runDeps, repoPath, companyId, commitMessage, {
        kind: 'company',
        privatePaths: readable.map(s => s.path),
        // Only for a server that knows private folders (it answered /me/scopes once).
        checkUsable: cache ? (paths: string[]) => pathChecker.usable(companyId, paths) : undefined,
      })

      const notes: string[] = []
      const fields: Partial<GitSyncResult> = {}
      if (prep.lost.length > 0) {
        notes.push(accessLostMessage(prep.lost))
        fields.lostPrivateFolders = prep.lost
      }
      if (prep.madePublic.length > 0) {
        notes.push(madePublicMessage(prep.madePublic, prep.madePublicBackup?.files.length ?? 0))
        fields.madePublicFolders = prep.madePublic
        if (prep.madePublicBackup) fields.madePublicBackupPath = prep.madePublicBackup.path
      }
      if (!cache || cache.scopes.length === 0 || isCancelled(company)) {
        return notes.length > 0 ? withNotes(company, notes, fields) : company
      }

      // Then each readable private folder, whatever the company sync did:
      // a failure in one repository must not hold the others back.
      const { reports, movedAside } = await syncPrivateFolders(runDeps, repoPath, companyId, commitMessage, cache.scopes, { syncEach: true })
      fields.privateFolders = reports
      const cloned = reports.filter(r => r.cloned && r.success).map(r => r.path)
      if (cloned.length > 0) {
        notes.push(newPrivateFolderMessage(cloned))
        fields.newPrivateFolders = cloned
      }
      if (movedAside.length > 0) {
        fields.movedAsideFolders = movedAside.map(m => m.folder)
        fields.movedAsideBackupPath = movedAside[0].backupPath
        notes.push(existingFolderMovedMessage(fields.movedAsideFolders))
      }
      for (const r of reports) {
        if (r.success && r.message && r.message !== '同期が完了しました') notes.push(`『${r.path}』: ${r.message}`)
      }
      const failed = reports.filter(r => !r.success)
      if (failed.length === 0) return withNotes(company, notes, fields)
      const failures = failed.map(r => `非公開フォルダ『${r.path}』を同期できませんでした。\n${r.error ?? ''}`.trim())
      if (!company.success) return withNotes(company, [...failures, ...notes], fields)
      const companyMessage = 'message' in company && typeof company.message === 'string' ? company.message : '同期が完了しました'
      return withNotes({
        ...company,
        success: false,
        errorType: failed[0].errorType ?? 'unknown',
        error: `${failures.join('\n\n')}\n\nその他のフォルダは同期しました（${companyMessage}）`,
      } as GitSyncResult, notes, fields)
    })

  // 「自動で送る」: the same sync with a template message and no questions answered for the member.
  const autoDeps = (asked: { value: boolean }): SyncDeps => ({
    ...deps,
    dialog: askLaterDialog(asked),
    generateCommitMessage: async (repoPath: string) => stagedAutoCommitMessage(deps.createGit(repoPath)),
  })

  const sync = (async (repoPath: string, companyId: string, commitMessage: string, options: SyncRunOptions = {}): Promise<GitSyncResult> => {
    if (!options.auto) return syncWith(deps, repoPath, companyId, commitMessage)
    const asked = { value: false }
    const result = await syncWith(autoDeps(asked), repoPath, companyId, 'Sync from AI Company Builder')
    if (!asked.value || result.success) return result
    const error = 'error' in result && typeof result.error === 'string' ? result.error : ''
    return { ...result, errorType: NEEDS_MEMBER_ERROR, error: error ? `${AUTO_NEEDS_MEMBER_MESSAGE}\n\n${error}` : AUTO_NEEDS_MEMBER_MESSAGE } as GitSyncResult
  }) as GitSync

  sync.applyPrivateFolderChoices = (repoPath, companyId) => locked(repoPath, async () => {
    const cache = readPrivateScopesCache(repoPath)
    if (!cache || cache.companyId !== companyId || cache.scopes.length === 0) return []
    // Called from inside the download-choice change: its own mark says nothing about these clones.
    const own: SyncDeps = { ...deps, otherGitRunning: () => deps.otherGitRunning?.({ ownActivity: true }) ?? false }
    return (await syncPrivateFolders(own, repoPath, companyId, 'Sync from AI Company Builder', cache.scopes, { syncEach: false })).reports
  })

  sync.receive = async (repoPath, companyId) => {
    const outcomes: RepoReceiveOutcome[] = []
    // A leftover lock goes first; one that may be in use holds the repository back.
    const receiveOne = (dir: string) => locked(dir, async () => {
      await lockState(dir)
      return receiveIntoRepo(deps.createGit(dir), dir, deps.log)
    })
    const openFiles: string[] = []
    const company = await receiveOne(repoPath)
    if (company.kind === 'offline') return { success: false, received: 0, heldBack: 0, offline: true }
    outcomes.push(company)
    if (company.kind === 'held-back') openFiles.push(...company.openFiles ?? [])
    // Each readable private folder already on this computer (nothing is
    // cloned or removed here: access changes are the next sync's job).
    const cache = readPrivateScopesCache(repoPath)
    if (cache && cache.companyId === companyId) {
      const notDownloaded = readSparseConfig(repoPath).excluded
      for (const scope of cache.scopes) {
        if (isNotDownloaded(notDownloaded, scope.path)) continue
        const dir = safeScopeDir(repoPath, scope.path)
        if (!dir || await cloneStateOf(deps.createGit, dir, scope) !== 'clone') continue
        const outcome = await receiveOne(dir)
        outcomes.push(outcome)
        if (outcome.kind === 'held-back') openFiles.push(...(outcome.openFiles ?? []).map(f => `${scope.path}/${f}`))
      }
    }
    const received = outcomes.reduce((n, o) => n + (o.kind === 'received' ? o.files : 0), 0)
    const heldBack = outcomes.filter(o => o.kind === 'held-back').length
    if (received > 0 || heldBack > 0) deps.log.log(`Auto receive: ${received} file(s) received, ${heldBack} repository(ies) held back`)
    return { success: true, received, heldBack, ...(openFiles.length > 0 ? { openFiles } : {}) }
  }

  sync.isRunning = () => syncLocks.size > 0

  sync.resumeAutomaticRuns = () => { automaticHeld = false }

  sync.automaticRunsHeld = () => automaticHeld

  sync.whenIdle = async () => {
    automaticHeld = true
    while (syncLocks.size > 0) await Promise.allSettled([...syncLocks.values()])
  }

  sync.pathChecker = pathChecker

  return sync
}
