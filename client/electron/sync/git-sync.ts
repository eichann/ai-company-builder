// git:sync — the one button members press to share their work.
//
// Moved out of main.ts unchanged so it can run without Electron: the host
// injects git, the dialog, the server API, the clock and the logger
// (./types.ts). main.ts keeps a thin ipcMain.handle('git:sync') that wires
// the real implementations; tests/sync-harness drives this same code against
// real bare repositories with several members.
//
// The step list and the guards each piece of defensive code stands for are
// documented under "Architecture: Client Sync (git:sync)" in CLAUDE.md.

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { SimpleGit } from 'simple-git'
import {
  isProtectedConfigRejection,
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
} from '../protected-config'
import { classifyConflicts } from './conflicts'
import { pushLandedDespiteError } from './push-landed'
import { findNestedGitRepos } from './nested-repos'
import { ensureGitignoreUnionMerge, tidyMergedGitignores } from './gitignore-merge'
import { applySparseSelection, readSparseConfig, sparseConfigPath, writeSparseConfig } from './sparse'
import { holdBackOutsideCheckout, outsideCheckoutMessage, type OutsideCheckoutResult } from './outside-checkout'
import type { SyncDeps } from './types'

export type { SyncDeps, SyncDialog, SyncServerApi, SyncLogger } from './types'

/** Filled in by runSync once files outside the checkout were held back (reported on every later outcome). */
interface SyncSideEffects { outsideCheckout: OutsideCheckoutResult | null }

async function runSync(deps: SyncDeps, repoPath: string, companyId: string, commitMessage: string, effects: SyncSideEffects) {
  const log = deps.log
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
    const backupsDir = path.join(repoPath, '.backups')
    const timestamp = deps.now().toISOString().replace(/[:.]/g, '-').slice(0, 23)
    const backupPath = path.join(backupsDir, timestamp)

    // Recover from stale rebase/merge state (e.g., app crashed mid-sync).
    // A rebase in progress is signalled by the rebase-merge / rebase-apply
    // directory — REBASE_HEAD is just a ref that can linger after a rebase
    // finished, so it must not be used as the indicator (WP-3.1).
    const gitDir = path.join(repoPath, '.git')
    const rebaseInProgress = () =>
      fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))
    if (rebaseInProgress()) {
      log.log('Git sync: Detected stale rebase, aborting...')
      try {
        await git.rebase(['--abort'])
      } catch (abortError) {
        log.warn('Git sync: Failed to abort rebase:', abortError)
      }
    }
    for (const stateFile of ['MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (fs.existsSync(path.join(gitDir, stateFile))) {
        log.log(`Git sync: Detected stale ${stateFile}, aborting...`)
        try {
          if (stateFile === 'MERGE_HEAD') {
            await git.merge(['--abort'])
          } else {
            await git.raw(['cherry-pick', '--abort'])
          }
        } catch (abortError) {
          log.warn(`Git sync: Failed to abort ${stateFile}:`, abortError)
        }
      }
    }

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

    // Clean up old backups (older than 30 days) — async to avoid blocking UI
    if (fs.existsSync(backupsDir)) {
      const RETENTION_DAYS = 30
      const cutoff = deps.now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000
      try {
        const backupFolders = await fs.promises.readdir(backupsDir)
        for (const folder of backupFolders) {
          const folderPath = path.join(backupsDir, folder)
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

    // Auto-migrate remote URL from SSH to HTTPS if needed
    try {
      const remotes = await git.getRemotes(true)
      const origin = remotes.find(r => r.name === 'origin')
      if (origin && origin.refs?.fetch && !origin.refs.fetch.startsWith('https://')) {
        log.log('Git sync: Detected SSH remote URL, migrating to HTTPS...')
        const httpsUrl = await deps.api.getRepoHttpsUrl(companyId)
        if (httpsUrl) {
          await git.removeRemote('origin')
          await git.addRemote('origin', httpsUrl)
          log.log(`Git sync: Migrated remote URL to ${httpsUrl}`)
        }
      }
    } catch (migrationError) {
      log.warn('Git sync: Remote URL migration check failed:', migrationError)
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

    // Detect large files (>100MB) and add to .gitignore — async to avoid blocking UI
    const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024 // 100MB
    const ignoredLargeFiles: string[] = []

    async function scanForLargeFiles(dir: string, baseDir: string): Promise<void> {
      try {
        const items = await fs.promises.readdir(dir)

        for (const item of items) {
          const fullPath = path.join(dir, item)
          const relativePath = path.relative(baseDir, fullPath)

          // Skip directories that are always ignored
          if (item === '.git' || item === '.backups' || item === 'node_modules') continue
          // Skip if already in .gitignore
          if (gitignoreContent.includes(relativePath)) continue

          try {
            const stat = await fs.promises.stat(fullPath)
            if (stat.isDirectory()) {
              await scanForLargeFiles(fullPath, baseDir)
            } else if (stat.isFile() && stat.size > LARGE_FILE_THRESHOLD) {
              ignoredLargeFiles.push(relativePath)
            }
          } catch {
            // Skip files we can't access
          }
        }
      } catch {
        // Directory doesn't exist or can't be read
      }
    }

    await scanForLargeFiles(repoPath, repoPath)

    // Add large files to .gitignore
    if (ignoredLargeFiles.length > 0) {
      const largeFilesSection = '\n# Auto-ignored: Large files (>100MB)\n' +
        ignoredLargeFiles.map(f => f).join('\n') + '\n'
      await fs.promises.appendFile(gitignorePath, largeFilesSection)
      log.log(`Git sync: Ignored ${ignoredLargeFiles.length} large file(s):`, ignoredLargeFiles)
    }

    // Detect nested Git repositories (e.g. user ran `git init` in a subfolder,
    // or copied in a cloned repo). Left alone, `git add` would record them as
    // gitlinks (160000 mode) and other members pulling would see empty folders.
    // Newly found repos require the user's choice BEFORE anything is modified:
    // the pre-consent `rm --cached` of the 2026-07-29 incident untracked a
    // whole shared folder (653 files) and surfaced as a terrifying "653 files
    // deleted" warning even though nothing was gone from disk.
    const newlyExcludedNestedRepos: string[] = []
    // Every nested repo the member has chosen to exclude (now or earlier).
    const excludedNestedRepoPaths: string[] = []
    try {
      const nestedRepos = await findNestedGitRepos(repoPath)
      if (nestedRepos.length > 0) {
        const currentGitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : ''
        const existingPatterns = new Set(currentGitignore.split('\n').map(l => l.trim()))
        const newRepos = nestedRepos.filter(repo => !existingPatterns.has(`/${repo}/`))
        const canAsk = deps.dialog.canAsk()

        for (const repo of newRepos) {
          if (!canAsk) {
            // No window to ask — legacy behavior (exclude silently)
            newlyExcludedNestedRepos.push(repo)
            continue
          }

          // A folder that is already shared (tracked files in HEAD) most
          // likely picked up a stray .git from a copied clone. Excluding it
          // would delete it from every member's machine — the right fix is
          // usually to drop the inner .git and keep sharing.
          const isShared = (await git.raw(['ls-files', '--', repo])).trim().length > 0

          if (isShared) {
            const choice = await deps.dialog.confirmSharedNestedRepo(repo)
            if (choice === 'cancel') {
              return { success: false, error: `同期を中止しました（「${repo}」に別のGitリポジトリが含まれています）` }
            }
            if (choice === 'keep-sharing') {
              fs.rmSync(path.join(repoPath, repo, '.git'), { recursive: true, force: true })
              log.log(`Git sync: Removed inner .git of "${repo}" (user chose to keep sharing)`)
              continue // stays shared — no exclusion
            }
            // 'exclude' → exclude below
          } else {
            const choice = await deps.dialog.confirmExternalNestedRepo(repo)
            if (choice === 'cancel') {
              return { success: false, error: `同期を中止しました（「${repo}」は外部Gitリポジトリです）` }
            }
          }
          newlyExcludedNestedRepos.push(repo)
        }

        // Mutations happen only after the user has chosen. Unstage gitlinks
        // for excluded repos (previously consented ones too — `rm --cached`
        // errors silently when the path isn't tracked).
        const excludedRepos = nestedRepos.filter(
          repo => newlyExcludedNestedRepos.includes(repo) || existingPatterns.has(`/${repo}/`)
        )
        excludedNestedRepoPaths.push(...excludedRepos)
        for (const repo of excludedRepos) {
          try {
            await git.raw(['rm', '--cached', '-rf', '--sparse', repo])
            log.log(`Git sync: Removed gitlink for nested repo "${repo}"`)
          } catch {
            // Not tracked yet — fine.
          }
        }

        if (newlyExcludedNestedRepos.length > 0) {
          const trailingNewline = currentGitignore.endsWith('\n') || currentGitignore === '' ? '' : '\n'
          const section = `${trailingNewline}\n# Auto-ignored: nested Git repositories (managed independently)\n${newlyExcludedNestedRepos.map(repo => `/${repo}/`).join('\n')}\n`
          await fs.promises.appendFile(gitignorePath, section)
          log.log(`Git sync: Added ${newlyExcludedNestedRepos.length} nested repo(s) to .gitignore:`, newlyExcludedNestedRepos)
        }
      }
    } catch (nestedRepoError) {
      log.warn('Git sync: Nested repo detection failed:', nestedRepoError)
    }

    // 1. Fetch from origin
    log.log('Git sync: Fetching from origin...')
    try {
      await git.fetch(['--progress', 'origin'])
    } catch (fetchError) {
      log.warn('Git sync: Fetch failed (may be offline):', fetchError)
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

    // 1.5. Reconcile sparse checkout to the user's persisted exclusions.
    //       The cone is always (all root dirs − excluded), so newly created
    //       folders appear automatically while excluded ones stay excluded
    //       across every sync. (The old code re-added every DB department
    //       here, which silently undid the user's exclusions.)
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
        await applySparseSelection(git, repoPath, sparseConfig.excluded)
      }
    } catch (sparseUpdateError) {
      log.warn('Git sync: Sparse checkout reconcile failed:', sparseUpdateError)
    }

    const restoredFolders: string[] = []

    // 2. Check for deleted files before staging. Deletions staged by the
    //    consented nested-repo exclusion above are intentional — keep them
    //    out of the warning dialog (and never "restore" them).
    const preAddStatus = await git.status()
    const deletedFiles = preAddStatus.deleted.filter(
      f => !newlyExcludedNestedRepos.some(repo => f === repo || f.startsWith(`${repo}/`))
    )

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
    await git.raw(['add', '--sparse', '.'])
    const status = await git.status()

    const hasLocalChanges = status.staged.length > 0 || status.files.length > 0

    if (hasLocalChanges) {
      // Use custom message if provided (not the default fallback), otherwise generate with AI
      const isCustomMessage = commitMessage && commitMessage !== 'Sync from AI Company Builder'
      const finalMessage = isCustomMessage
        ? commitMessage
        : (await deps.generateCommitMessage(repoPath)) || commitMessage || 'Sync from AI Company Builder'
      await git.commit(finalMessage)
    }

    // Record local commit hash before rebase attempt
    const localHash = (await git.revparse(['HEAD'])).trim()
    log.log(`Git sync: Local commit hash: ${localHash}`)

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
              conflictFiles,
              deletedConflictFiles,
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
            const destPath = path.join(backupPath, file)
            fs.mkdirSync(path.dirname(destPath), { recursive: true })
            for (const spec of [`${localHash}:${file}`, `:3:${file}`]) {
              try {
                const content = await catFile(spec)
                fs.writeFileSync(destPath, content)
                markSaved(file, content)
                break
              } catch {
                // Not there (e.g. a file only the server side has) — try the next source.
              }
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
            try {
              const content = await catFile(oid)
              const destPath = path.join(roundPath, file)
              fs.mkdirSync(path.dirname(destPath), { recursive: true })
              fs.writeFileSync(destPath, content)
              markSaved(file, content)
            } catch {
              // Unreadable object — nothing more to save for this path.
            }
          }
          fs.writeFileSync(
            path.join(roundPath, '_metadata.json'),
            JSON.stringify({
              timestamp: deps.now().toISOString(),
              reason: 'conflict',
              conflictFiles: replaced.map(r => r.file),
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
            await backupConflictFiles(newConflicts)
            await backupReplacedVersions(round)
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

    // 4.45. Taking the server version of a conflicted file can track a
    //       teammate's file again inside a folder the member excluded (a
    //       shared folder with a stray .git, answered "exclude"). Untrack it
    //       again now, as the member already chose — otherwise only the next
    //       sync does, and the team needs an extra round to converge.
    if (excludedNestedRepoPaths.length > 0 && (await git.revparse(['HEAD'])).trim() !== localHash) {
      try {
        const retracked: string[] = []
        for (const repo of excludedNestedRepoPaths) {
          if ((await git.raw(['ls-files', '--', repo])).trim()) retracked.push(repo)
        }
        if (retracked.length > 0) {
          await git.raw(['rm', '--cached', '-r', '-q', '--sparse', '--', ...retracked])
          await git.commit(`Stop sharing nested Git repositories: ${retracked.join(', ')}`)
          log.log('Git sync: Untracked excluded nested repos again after merging:', retracked)
        }
      } catch (untrackError) {
        log.warn('Git sync: Could not untrack excluded nested repos after merging:', untrackError)
      }
    }

    // 4.5. Protect department folders (restore if deleted locally)
    //       Runs AFTER pull so that renames from the server are already applied.
    if (companyId) {
      try {
        let sparseEnabled = false
        let sparseCheckedOut: string[] = []
        try {
          const sparseConfig = await git.raw(['config', '--get', 'core.sparseCheckout'])
          sparseEnabled = sparseConfig.trim() === 'true'
          if (sparseEnabled) {
            const sparseList = await git.raw(['sparse-checkout', 'list'])
            sparseCheckedOut = sparseList.split('\n').filter(Boolean)
          }
        } catch {
          // Not a sparse checkout repo — protect all departments
        }

        const departments = await deps.api.getDepartments(companyId)
        if (departments) {
          for (const dept of departments) {
            if (!dept.folder || dept.folder.includes('..') || path.isAbsolute(dept.folder)) {
              log.warn(`Git sync: Skipping invalid department folder: ${dept.folder}`)
              continue
            }
            if (sparseEnabled && !sparseCheckedOut.includes(dept.folder)) {
              continue
            }

            const deptPath = path.join(repoPath, dept.folder)
            if (!fs.existsSync(deptPath)) {
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
            await git.raw(['add', '--sparse', '.'])
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

    // Set when a PERSONAL_PATH rejection was resolved by untracking files.
    let personalUntrack = null as PersonalUntrackResult | null // widened: assigned inside nested try
    const personalNote = () => personalUntrack && personalUntrack.untracked.length > 0
      ? `個人用フォルダ（.personal）のファイル${personalUntrack.untracked.length}件は共有できないため、共有対象から外しました（このPCには残っています）。`
      : ''

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
        if (!isPersonalPathRejection(firstMsg)) throw firstPushError
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
        if (personalUntrack.committed) {
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
          : hasProtected ? '管理者だけが変更できる' : '編集する権限がないフォルダの'

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
            return {
              success: false,
              error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${squashMsg.split('\n').map(l => l.replace(/^remote:\s*/, '').trim()).filter(l => l.startsWith('- ')).join('\n') || '（詳細不明）'}`,
              secretDetected: true
            }
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
              git, repoPath, paths: protectedToRestore, backupPath: path.join(backupsDir, `${stamp}_protected`),
            })
          }
          if (writeDeniedToRestore.length > 0) {
            writeDeniedRecovery = await restoreProtectedPaths({
              git, repoPath, paths: writeDeniedToRestore, backupPath: path.join(backupsDir, `${stamp}_write_denied`), reason: 'write_denied',
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
            if (retryMsg.includes('SECRET_DETECTED')) {
              return {
                success: false,
                error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${retryMsg.split('\n').map(l => l.replace(/^remote:\s*/, '').trim()).filter(l => l.startsWith('- ')).join('\n') || '（詳細不明）'}`,
                secretDetected: true
              }
            }
            // The local history is clean now; an ordinary push failure (network,
            // a teammate pushed in between) is retried by the next sync.
            log.error(hasProtected ? 'Git sync: Push after protected config recovery failed:' : 'Git sync: Push after write-denied recovery failed:', retryMsg)
            fs.writeFileSync(pendingPushFile, deps.now().toISOString())
            return {
              success: false,
              error: hasProtected && !hasWriteDenied
                ? '管理者だけが変更できるファイルをサーバーの状態に戻しましたが、プッシュに失敗しました。次回の同期で再試行します。'
                : `${refusedWhat}ファイルを元に戻しましたが、プッシュに失敗しました。次回の同期で再試行します。`,
              errorType: 'push_failed' as const,
              pushFailed: true,
              ...reverted,
            }
          }
        }
        if (fs.existsSync(pendingPushFile)) fs.unlinkSync(pendingPushFile)

        const parts = ['同期完了。']
        if (hasProtected) parts.push(`管理者だけが変更できるファイル（${revertedProtected.length}件）はサーバーの状態に戻しました。`)
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

      // Check if push was rejected due to secret detection
      if (pushErrorMsg.includes('SECRET_DETECTED')) {
        // Extract file list from error message
        // git prefixes pre-receive hook stderr with "remote: "
        const fileLines = pushErrorMsg
          .split('\n')
          .map((line: string) => line.replace(/^remote:\s*/, '').trim())
          .filter((line: string) => line.startsWith('- '))
        const fileList = fileLines.length > 0
          ? fileLines.join('\n')
          : '（詳細不明）'
        return {
          success: false,
          error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${fileList}`,
          secretDetected: true
        }
      }

      log.error('Git sync: Push to main failed:', pushErrorMsg)
      // Try master branch if main fails
      try {
        await pushToServer('master')
      } catch (masterPushError) {
        // Check secret detection on master push too
        const masterErrorMsg = masterPushError instanceof Error ? masterPushError.message : String(masterPushError)
        if (masterErrorMsg.includes('SECRET_DETECTED')) {
          const fileLines = masterErrorMsg
            .split('\n')
            .map((line: string) => line.replace(/^remote:\s*/, '').trim())
            .filter((line: string) => line.startsWith('- '))
          const fileList = fileLines.length > 0
            ? fileLines.join('\n')
            : '（詳細不明）'
          return {
            success: false,
            error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${fileList}`,
            secretDetected: true
          }
        }
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
        message: `同期完了。${conflictFiles.length}ファイルが競合しました（${outcomes.join('、')}）。競合前のローカル版は .backups/ に保存してあります。${personalNote()}その他の変更は正常に反映されました。`,
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
    let errorType = 'unknown'
    if (errorMsg.includes('Could not resolve host') || errorMsg.includes('unable to access') || errorMsg.includes('network')) {
      errorType = 'network'
    } else if (errorMsg.includes('Authentication') || errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('credential')) {
      errorType = 'auth'
    } else if (errorMsg.includes('CONFLICT') || errorMsg.includes('conflict') || errorMsg.includes('rebase')) {
      errorType = 'conflict'
    } else if (errorMsg.includes('lock') || errorMsg.includes('index.lock')) {
      errorType = 'locked'
    }
    return { success: false, error: errorMsg, errorType }
  }
}


export type GitSyncResult = Awaited<ReturnType<typeof runSync>> & {
  /** Files created inside a folder that is not checked out, moved to outsideCheckoutBackupPath instead of being shared. */
  outsideCheckoutFiles?: string[]
  outsideCheckoutBackupPath?: string
}

/** Report held-back files on whatever the sync ended with. */
function withSideEffects(result: Awaited<ReturnType<typeof runSync>>, effects: SyncSideEffects): GitSyncResult {
  const held = effects.outsideCheckout
  if (!held) return result
  const note = outsideCheckoutMessage(held)
  const fields = { outsideCheckoutFiles: held.files, outsideCheckoutBackupPath: held.backupPath }
  if (result.success) {
    const message = 'message' in result && typeof result.message === 'string' ? result.message : '同期が完了しました'
    // Every result shape gets the note in its own text field; the union cannot express that per member.
    return { ...result, ...fields, message: `${message}${message.endsWith('。') ? '' : '。'}${note}` } as GitSyncResult
  }
  const error = 'error' in result && typeof result.error === 'string' ? result.error : ''
  return { ...result, ...fields, error: error ? `${error}\n\n${note}` : note } as GitSyncResult
}
export type GitSync = (repoPath: string, companyId: string, commitMessage: string) => Promise<GitSyncResult>

/**
 * Create the sync function. Each instance owns its per-repository lock, so
 * main.ts creates one for the app and each simulated member gets its own.
 */
export function createGitSync(deps: SyncDeps): GitSync {
  // Sync lock per repository to prevent concurrent syncs
  const syncLocks = new Map<string, Promise<unknown>>()

  return async (repoPath, companyId, commitMessage) => {
    // Serialize syncs per repository. Register our run BEFORE waiting on the
    // previous one — the old code awaited first and registered later, so two
    // clicks queued behind the same sync woke together and ran concurrently
    // (WP-3.1).
    const previous = syncLocks.get(repoPath)

    const syncPromise = (async () => {
      if (previous) {
        deps.log.log('Git sync: Already syncing, waiting for previous sync to complete...')
        try { await previous } catch { /* previous sync errors belong to its caller */ }
      }
      const effects: SyncSideEffects = { outsideCheckout: null }
      return withSideEffects(await runSync(deps, repoPath, companyId, commitMessage, effects), effects)
    })()

    syncLocks.set(repoPath, syncPromise)
    try {
      return await syncPromise
    } finally {
      if (syncLocks.get(repoPath) === syncPromise) {
        syncLocks.delete(repoPath)
      }
    }
  }
}
