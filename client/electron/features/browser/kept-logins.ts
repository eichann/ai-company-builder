// A site's login kept on this PC (agent-browser.md "Keeping a login on disk"). No Electron: the shell's session
// clearing comes in as `clearSession`; the disk is read and written here with `fs`.
//
// The trust boundary: a login on disk is readable by anything that runs as the member on this PC. The app keeps
// one only where every AI turn the app starts here is enclosed by the company sandbox, which denies the app's data
// folder (`<userData>`, where Electron keeps `Partitions/`). So:
// - the folders: `<userData>/Partitions/acb-browser-keep-<u>-<c>-<h>` (`persist:` partitions; u = account, c =
//   account × company, h = account × company × site, 16 hex of sha256 each), one per account × company × site —
//   two members or two companies never share one, and every wipe can name exactly whose it removes;
// - the disk is the truth: what is removed is read from the folder, not from memory, so a folder an earlier run or
//   a crash left is found and removed like one of this run;
// - **stopped for this run**: once an AI turn without the sandbox is about to run, nothing is kept again until the
//   app quits (`stop`, set before anything is awaited), and a partition whose folder was removed is never used again
//   in this run (its session still lives in Chromium's memory; a fresh in-memory one is used instead);
// - removing = the shell clears every session of it this run loaded (cookies, storage, caches), then the folder is
//   deleted (a link of that name is unlinked, never followed); `remove` answers true only when no matching folder is
//   left on disk afterwards.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sandboxKeepsPlaceUnread, type ResolvedSandbox } from '../../../shared/agents/sandbox-policy'

/** What the chat server knows of an AI turn about to run: its sandbox as decided (none = undefined) and its company folder. */
export interface AiTurnFacts {
  sandbox?: { mode: 'observe' | 'enforce'; resolved: ResolvedSandbox }
  companyRoot?: string
}

/**
 * Is this AI turn one a kept login may sit next to? Only `enforce`, with the kept logins' folder denied to both
 * agents and outside the turn's company folder (`sandboxKeepsPlaceUnread`). Anything else — observe, off, no
 * sandbox (the API key's tools, a policy never received), a company folder around the app's data — is not.
 */
export function turnEnclosesKeptLogins(partitionsDir: string, turn: AiTurnFacts): boolean {
  return turn.sandbox?.mode === 'enforce' && sandboxKeepsPlaceUnread(turn.sandbox.resolved, partitionsDir, turn.companyRoot)
}

const PREFIX = 'acb-browser-keep-'
/** A kept login's folder name, exactly (lower-case hex as written: anything else of the family is a leftover). */
export const KEPT_LOGIN_FOLDER_RE = /^acb-browser-keep-([0-9a-f]{16})-([0-9a-f]{16})-([0-9a-f]{16})$/

const part = (values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16)

/** The folder of one account × company × site's kept login (under `<userData>/Partitions`). */
export function keptLoginFolder(userId: string, companyId: string, host: string): string {
  return `${PREFIX}${part([userId])}-${part([userId, companyId])}-${part([userId, companyId, host])}`
}

/** Whose kept logins a removal names. */
export type KeptLoginScope =
  | { all: true }
  | { otherThan: string }
  | { userId: string; companyId?: string; host?: string; exceptHosts?: readonly string[] }

/** Does a kept folder's name fall in the scope? Only exact kept names ever do. */
export function keptFolderIn(name: string, scope: KeptLoginScope): boolean {
  const m = KEPT_LOGIN_FOLDER_RE.exec(name)
  if (!m) return false
  if ('all' in scope) return true
  if ('otherThan' in scope) return m[1] !== part([scope.otherThan])
  if (m[1] !== part([scope.userId])) return false
  if (scope.companyId === undefined) return true
  if (m[2] !== part([scope.userId, scope.companyId])) return false
  if (scope.host !== undefined) return m[3] === part([scope.userId, scope.companyId, scope.host])
  return !(scope.exceptHosts ?? []).some(host => m[3] === part([scope.userId, scope.companyId!, host]))
}

export interface KeptLoginsDeps {
  /** `<userData>/Partitions` (Electron keeps a `persist:<name>` partition in `<name>` there). */
  partitionsDir: () => string
  /** The shell clears a partition's session (cookies, storage, caches); only for one loaded this run. */
  clearSession: (partition: string) => Promise<void>
  /** This platform runs the company sandbox (`sandboxPlatform`); false = nothing is ever kept (earlier folders still go). */
  platformEncloses: boolean
  log?: Pick<Console, 'warn'>
}

export function createKeptLogins(deps: KeptLoginsDeps) {
  const log = deps.log ?? console
  let stopped = !deps.platformEncloses
  /** Folders whose session this run loaded (a window was opened on them). */
  const loaded = new Set<string>()
  /** Folders removed this run: their session is never used again (a new window gets memory instead). */
  const spent = new Set<string>()
  /** Removals one after another, so a later one reads the disk after an earlier one finished. */
  let queue: Promise<unknown> = Promise.resolve()

  /** Loaded sessions in the scope are spent at once (a window opened meanwhile gets memory), then cleared. */
  async function clearLoaded(scope: KeptLoginScope): Promise<void> {
    for (const name of [...loaded]) {
      if (!keptFolderIn(name, scope)) continue
      loaded.delete(name)
      spent.add(name)
      try { await deps.clearSession(`persist:${name}`) } catch (error) {
        log.warn(`[browser] a kept login's session could not be cleared (${error instanceof Error ? error.message : 'unknown'})`)
      }
    }
  }

  async function removeNow(scope: KeptLoginScope): Promise<boolean> {
    await clearLoaded(scope)
    const dir = deps.partitionsDir()
    const matching = async () => {
      try { return (await fs.promises.readdir(dir)).filter(name => keptFolderIn(name, scope)) } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null
      }
    }
    const names = await matching()
    if (names === null) return false
    for (const name of names) {
      spent.add(name)
      const target = path.join(dir, name)
      try {
        const stat = await fs.promises.lstat(target)
        if (stat.isDirectory()) await fs.promises.rm(target, { recursive: true, force: true })
        else await fs.promises.unlink(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          log.warn(`[browser] a kept login could not be removed (${error instanceof Error ? error.message : 'unknown'})`)
        }
      }
    }
    // A session loaded while this ran (an earlier run's folder opened meanwhile): cleared too, never used again.
    await clearLoaded(scope)
    const left = await matching()
    return left !== null && left.length === 0
  }

  return {
    /** Nothing is kept again in this run (an AI turn without the sandbox is about to run). Synchronous on purpose. */
    stop(): void { stopped = true },

    /** May a login be kept now (this run never ran an AI turn without the sandbox)? */
    keeping(): boolean { return !stopped },

    /** The `persist:` partition of a site's kept login, or null when it may not be kept now (memory then). */
    partition(userId: string, companyId: string, host: string): string | null {
      const name = keptLoginFolder(userId, companyId, host)
      if (stopped || spent.has(name)) return null
      loaded.add(name)
      return `persist:${name}`
    },

    /** Is this a partition `partition` gave? */
    isKept(partition: string): boolean {
      return partition.startsWith('persist:') && KEPT_LOGIN_FOLDER_RE.test(partition.slice('persist:'.length))
    },

    /**
     * Removes the kept logins in the scope (memory and disk); true only when none is left on disk. What this run
     * loaded is spent at once (synchronously), so no window opened after the call uses a session being removed.
     */
    remove(scope: KeptLoginScope): Promise<boolean> {
      for (const name of loaded) if (keptFolderIn(name, scope)) spent.add(name)
      const run = queue.then(() => removeNow(scope), () => removeNow(scope))
      queue = run.catch(() => undefined)
      return run.catch(() => false)
    },
  }
}

export type KeptLogins = ReturnType<typeof createKeptLogins>
