// Setting a company folder up: what a chosen folder may become (empty →
// first setup with the department picker; a clone of this company → open;
// anything else refused — sync/company-folder.ts), and the setup itself
// (join with all or the picked departments as a partial clone, or the
// owner's first push). Reports download progress as setup:progress.
//   git:inspectCompanyFolder, git:setupCompanyRemote

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { AppGit } from '../../services/app-git'
import type { Session } from '../../services/session'
import { decideCompanyFolder, inspectLocalFolder, sameCompanyRemote, watchPackBytes, type CompanyFolderDecision } from '../../sync/company-folder'
import { checkoutSelectedDepartments } from '../../sync/first-setup'
import { configureOrigin } from '../../sync/remote'
import { isDownloadFailure } from '../../sync/sparse'
import type { PathGuard } from '../ports'

export interface CompanySetupDeps {
  paths: PathGuard
  appGit: AppGit
  session: Session
  serverUrl: () => string
  /** The app's own folder (ls-remote by URL needs no repository; it runs there). */
  userDataDir: () => string
}

const SETUP_OFFLINE_MESSAGE = 'サーバーに接続できませんでした。インターネット接続を確認して、もう一度お試しください。'

export function registerCompanySetupIpc(ipc: IpcRegistrar, { paths, appGit, session, serverUrl, userDataDir }: CompanySetupDeps): void {

  // The company's repository URL on the server (null when the server cannot say).
  async function companyRemoteUrl(companyId: string): Promise<string | null> {
    const repoInfoResponse = await fetch(`${serverUrl()}/api/git/repos/${encodeURIComponent(companyId)}`, {
      headers: session.cookies().length > 0 ? { 'Cookie': session.cookies().join('; ') } : {},
    })
    if (!repoInfoResponse.ok) return null
    const repoInfo = await repoInfoResponse.json()
    return typeof repoInfo.data?.httpsUrl === 'string' && repoInfo.data.httpsUrl ? repoInfo.data.httpsUrl : null
  }

  // Which setup a chosen company folder gets (./sync/company-folder.ts). Reads
  // only: nothing in the folder is created or changed. Throws when the server
  // cannot be reached (the remote's state is part of the decision).
  async function companyFolderDecision(folder: string, remoteUrl: string): Promise<{ decision: CompanyFolderDecision; remoteHasCommits: boolean }> {
    const local = await inspectLocalFolder(folder, args => appGit.create(folder).raw(args))
    // ls-remote by URL needs no repository; run it from the app's own folder.
    const heads = await appGit.create(userDataDir()).raw(['ls-remote', '--heads', remoteUrl])
    const remoteHasCommits = heads.trim().length > 0
    return { decision: decideCompanyFolder({ ...local, remoteHasCommits }, remoteUrl), remoteHasCommits }
  }

  // CompanySelector asks before setting a folder up: 'firstSetup' shows the
  // department picker, 'refuse' explains why the folder cannot be used.
  // Offline, only a clone of this company (recognised by its origin's path,
  // /api/git-http/<companyId>) can be opened — work goes on without the server;
  // everything else needs it for the first download.
  ipc.handle('git:inspectCompanyFolder', async (_, folder: string, companyId: string) => {
    let safe: string
    try {
      safe = paths.validate(folder)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    try {
      const remoteUrl = await companyRemoteUrl(companyId)
      if (remoteUrl) return { success: true, decision: (await companyFolderDecision(safe, remoteUrl)).decision }
    } catch (error) {
      console.warn('Git setup: Could not inspect the folder online:', error)
    }
    try {
      const local = await inspectLocalFolder(safe, args => appGit.create(safe).raw(args))
      const expected = `${serverUrl()}/api/git-http/${companyId.replace(/[^a-zA-Z0-9_-]/g, '')}.git` // as server/src/routes/git.ts builds it
      if (local.hasGitDir && local.originUrl && local.hasLocalCommits && sameCompanyRemote(local.originUrl, expected)) {
        return { success: true, offline: true, decision: { action: 'existingClone' } satisfies CompanyFolderDecision }
      }
    } catch (error) {
      console.warn('Git setup: Could not inspect the folder:', error)
    }
    return { success: false, error: SETUP_OFFLINE_MESSAGE }
  })

  // Setup Git remote for a company
  //
  // While it runs, the bytes arriving in .git/objects/pack are reported to the
  // window as 'setup:progress' events: a first download of a large company
  // takes minutes, and the setup screen shows it moving.
  ipc.handle('git:setupCompanyRemote', async (event, repoPath: string, companyId: string, selectedPaths?: string[]) => {
    let stopProgress: (() => void) | null = null
    try {
      repoPath = paths.validate(repoPath)
      // Fetch HTTPS URL from server API
      let remoteUrl: string | null
      try {
        remoteUrl = await companyRemoteUrl(companyId)
      } catch (fetchError) {
        console.warn('Git setup: Could not reach the server:', fetchError)
        return { success: false, error: SETUP_OFFLINE_MESSAGE }
      }
      if (!remoteUrl) {
        return { success: false, error: 'Failed to get repository info from server' }
      }

      // Backstop for the selector's own check: never re-point another
      // remote's clone at this company, and never check the company out over
      // the member's own files (./sync/company-folder.ts).
      let decision: CompanyFolderDecision
      let remoteHasCommits: boolean
      try {
        ({ decision, remoteHasCommits } = await companyFolderDecision(repoPath, remoteUrl))
      } catch (inspectError) {
        console.warn('Git setup: ls-remote failed:', inspectError)
        return { success: false, error: SETUP_OFFLINE_MESSAGE }
      }
      if (decision.action === 'refuse') {
        return { success: false, refused: true, error: decision.message }
      }

      const git: SimpleGit = appGit.create(repoPath)

      // A repository of its own, even when the folder sits inside another
      // repository (checkIsRepo would answer for the parent, whose origin
      // would then be replaced below).
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        await git.init()
      }
      stopProgress = watchPackBytes(repoPath, receivedBytes => {
        if (!event.sender.isDestroyed()) event.sender.send('setup:progress', { repoPath, receivedBytes })
      })

      // Configure git user from authenticated session (local to this repo)
      try {
        const meResponse = await fetch(`${serverUrl()}/api/me`, {
          headers: session.cookies().length > 0 ? { 'Cookie': session.cookies().join('; ') } : {},
        })
        if (meResponse.ok) {
          const meData = await meResponse.json()
          if (meData.success && meData.data) {
            await git.addConfig('user.email', meData.data.email, false)
            await git.addConfig('user.name', meData.data.name || meData.data.email, false)
            console.log(`Git setup: Configured user as ${meData.data.email}`)
          }
        }
      } catch (configError) {
        console.warn('Git setup: Could not configure user identity:', configError)
      }

      // Windows: deep Japanese folder trees easily exceed MAX_PATH (260 chars)
      // and break checkout — opt this repo into long path support
      if (process.platform === 'win32') {
        try {
          await git.addConfig('core.longpaths', 'true', false)
        } catch (longPathError) {
          console.warn('Git setup: Could not set core.longpaths:', longPathError)
        }
      }

      // Add/update origin remote. set-url, never remove + add: this runs
      // again whenever a company is reopened, and `remote remove` deleted a
      // partial clone's promisor config, so downloading a department later
      // failed (./sync/remote.ts). Repair a clone that already lost it.
      await configureOrigin(git, remoteUrl, console)

      if (remoteHasCommits) {
        // Check if we have local commits
        const localLog = await git.log().catch(() => null)

        // First setup with departments picked: download only those (plus what
        // the whole company shares) — a partial clone with the sparse cone set
        // before the first checkout (./sync/first-setup.ts). Only for a folder
        // with no local commits; an existing clone is never converted.
        if ((!localLog || localLog.total === 0) && Array.isArray(selectedPaths) && selectedPaths.length > 0) {
          const lsHeads = await git.listRemote(['--heads', 'origin'])
          const headMatch = lsHeads.match(/refs\/heads\/(\S+)/)
          let departments: string[] | null = null
          try {
            const deptResponse = await fetch(`${serverUrl()}/api/companies/${encodeURIComponent(companyId)}/departments`, {
              headers: session.cookies().length > 0 ? { 'Cookie': session.cookies().join('; ') } : {},
            })
            const deptData = deptResponse.ok ? await deptResponse.json() : null
            if (deptData?.success && Array.isArray(deptData.data)) {
              departments = (deptData.data as Array<{ folder?: unknown }>)
                .map(d => d.folder)
                .filter((f): f is string => typeof f === 'string' && f.length > 0 && !f.includes('/'))
            }
          } catch (deptError) {
            console.warn('Git setup: Could not load departments, treating root folders as departments:', deptError)
          }
          try {
            const { excluded, included } = await checkoutSelectedDepartments({
              git,
              repoPath,
              branch: headMatch ? headMatch[1] : 'main',
              departments,
              selected: selectedPaths.filter((p): p is string => typeof p === 'string'),
              log: console,
            })
            return {
              success: true,
              remoteUrl,
              cloned: true,
              partial: true,
              downloadedDepartments: included,
              excludedDepartments: excluded,
              message: `Cloned from server (selected departments only): ${remoteUrl}`,
            }
          } catch (partialError) {
            const msg = partialError instanceof Error ? partialError.message : String(partialError)
            console.error('Git setup: Partial clone failed:', msg)
            return {
              success: false,
              error: isDownloadFailure(msg)
                ? 'ダウンロードできませんでした。インターネット接続を確認して、もう一度お試しください。'
                : msg,
            }
          }
        }

        // Remote has content — pull it down (member joining existing company)
        console.log('Git setup: Remote has commits, fetching...')
        await git.fetch(['--progress', 'origin'])

        // Determine the main branch name
        const lsRemote = await git.listRemote(['--heads', 'origin'])
        const branchMatch = lsRemote.match(/refs\/heads\/(\S+)/)
        const remoteBranch = branchMatch ? branchMatch[1] : 'main'

        if (!localLog || localLog.total === 0) {
          // No local commits — checkout the remote branch
          await git.checkout(['-b', remoteBranch, `origin/${remoteBranch}`])
          console.log(`Git setup: Checked out origin/${remoteBranch}`)
        } else {
          // Local commits exist — set up tracking and pull
          const status = await git.status()
          const localBranch = status.current || 'main'
          const hasChanges = !status.isClean()
          if (hasChanges) {
            console.log('Git setup: Uncommitted changes detected, skipping pull (will resolve on next sync)')
          } else {
            try {
              await git.pull('origin', remoteBranch, ['--rebase', '--progress'])
              console.log(`Git setup: Pulled origin/${remoteBranch} into ${localBranch}`)
            } catch (pullError) {
              console.warn('Git setup: Pull failed, will resolve on next sync:', pullError)
            }
          }
        }

        return {
          success: true,
          remoteUrl,
          cloned: true,
          message: `Cloned from server: ${remoteUrl}`
        }
      } else {
        // Remote is empty — initialize and push (owner's first setup)
        console.log('Git setup: Remote is empty, initializing...')

        const localLog = await git.log().catch(() => null)
        if (!localLog || localLog.total === 0) {
          // Create .gitignore if it doesn't exist
          const gitignorePath = path.join(repoPath, '.gitignore')
          if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, '.DS_Store\n*.log\nnode_modules/\n.backups/\n.workspace/\n# Secrets — never sync (local only)\n.env\n.env.*\n!.env.example\n!.env.sample\n')
          }

          await git.raw(['add', '--sparse', '.'])
          await git.commit('Initial commit')
        }

        // Push to server
        try {
          const status = await git.status()
          const branch = status.current || 'main'
          await git.push('origin', branch, ['--set-upstream', '--progress'])
          console.log(`Git setup: Pushed to origin/${branch}`)
        } catch (pushError) {
          console.warn('Git setup: Push failed (may be first time or network issue):', pushError)
        }

        return {
          success: true,
          remoteUrl,
          cloned: false,
          message: `Git remote configured: ${remoteUrl}`
        }
      }
    } catch (error) {
      console.error('Git setup error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      stopProgress?.()
    }
  })
}
