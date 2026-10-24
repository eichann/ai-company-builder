// What the app knows about private folders when it guards a write or a read:
// the folders this member may read and who may change AI instruction files
// (refreshed at each chat turn), the chat write guard's view from the cached
// /me/scopes answer, and the reserved-name refusal for the app's own file
// operations. Was module state in main.ts.

import fs from 'fs'
import path from 'path'
import { reservedPathMessage } from '../../../../shared/types/private-folders'
import type { PrivateFoldersApi } from '../../private-folders-api'
import type { PathChecker } from '../../sync/path-check'
import { companyPathOf, readPrivateScopesCache, readableScopeOf } from '../../sync/private-folders'
import type { InstructionAuthority } from '../../write-guard'

export interface PrivateFolderGuardsDeps {
  api: PrivateFoldersApi
  /** Sync's shared, cached POST …/paths/check client. */
  pathChecker: PathChecker
}

export interface PrivateFolderGuards {
  /** Refresh the private folders this member may read (waits at most `timeoutMs`; a failure keeps the last answer). */
  refreshReadable(companyId: string, timeoutMs: number): Promise<void>
  /** The last answer (NFC paths), or undefined (unknown: local reads are not recognised). */
  readable(companyId: string): string[] | undefined
  /** Refresh who may change CLAUDE.md / AGENTS.md (role + managed department folders). */
  refreshAuthority(companyId: string, timeoutMs: number): Promise<void>
  authority(companyId: string): InstructionAuthority | undefined
  /** Private folders as the chat write guard sees them (cached /me/scopes, no network call). */
  guardView(root: string): {
    reservedFolderOf(rel: string): Promise<string | null>
    readOnlyFolderOf(rel: string): string | null
  } | undefined
  /** The server's sentence when creating `absPath` would use a folder name the member may not use; else null. */
  reservedRefusal(absPath: string): Promise<string | null>
}

function waitAtMost(pending: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })]).finally(() => clearTimeout(timer))
}

export function createPrivateFolderGuards({ api, pathChecker }: PrivateFolderGuardsDeps): PrivateFolderGuards {
  // The private folders this member may read, per company, for the chat's
  // private-read guard (private-read-guard.ts). Refreshed at every chat turn;
  // a failed refresh keeps the last answer (unknown = local reads are not recognised).
  const readablePrivateFolders = new Map<string, string[]>()
  const privateFolderRefreshes = new Map<string, Promise<void>>()
  // Who may change CLAUDE.md / AGENTS.md (write-guard.ts): role + managed
  // department folders from /me/capabilities. A server without the folders
  // leaves a non-admin's authority unknown (never blocks; the push check stays).
  const instructionAuthority = new Map<string, InstructionAuthority>()
  const authorityRefreshes = new Map<string, Promise<void>>()

  return {
    refreshReadable(companyId, timeoutMs) {
      let pending = privateFolderRefreshes.get(companyId)
      if (!pending) {
        pending = api.mine(companyId)
          .then(result => { if (result.success) readablePrivateFolders.set(companyId, result.folders.map(f => f.path.normalize('NFC'))) })
          .catch(() => {})
          .finally(() => privateFolderRefreshes.delete(companyId))
        privateFolderRefreshes.set(companyId, pending)
      }
      return waitAtMost(pending, timeoutMs)
    },
    readable: companyId => readablePrivateFolders.get(companyId),
    refreshAuthority(companyId, timeoutMs) {
      let pending = authorityRefreshes.get(companyId)
      if (!pending) {
        pending = api.capabilities(companyId)
          .then(result => {
            if (!result.success) return
            if (result.role === 'owner' || result.role === 'admin' || result.managedDepartmentFolders) {
              instructionAuthority.set(companyId, { role: result.role, managedFolders: result.managedDepartmentFolders ?? [] })
            } else instructionAuthority.delete(companyId)
          })
          .catch(() => {})
          .finally(() => authorityRefreshes.delete(companyId))
        authorityRefreshes.set(companyId, pending)
      }
      return waitAtMost(pending, timeoutMs)
    },
    authority: companyId => instructionAuthority.get(companyId),
    // Private folders as the chat write guard sees them, from the cached
    // /me/scopes answer sync keeps in the company's .git (no network call).
    guardView(root) {
      const cache = readPrivateScopesCache(root)
      if (!cache) return undefined
      const readable = [...cache.scopes, ...(cache.pendingPublic ?? [])]
      return {
        reservedFolderOf: async (rel: string) => {
          if (readableScopeOf(readable, rel) || fs.existsSync(path.join(root, ...rel.split('/')))) return null
          return pathChecker.reservedFolderOf(cache.companyId, rel).catch(() => null)
        },
        readOnlyFolderOf: (rel: string) => {
          const scope = readableScopeOf(cache.scopes, rel)
          return scope && !scope.canWrite ? scope.path : null
        },
      }
    },
    /**
     * Refuse creating something at a folder name the member may not use (a
     * private folder they cannot read — the server answers POST …/paths/check;
     * sync's shared, cached checker). Only for paths that do not exist yet (an
     * editor save never waits on it); unknown answers allow — sync's hold-back
     * and the server's [RESERVED_PATH] stay the safety net. The message is the
     * server's own wording, naming only what the member typed.
     */
    async reservedRefusal(absPath) {
      if (fs.existsSync(absPath)) return null
      const where = companyPathOf(absPath)
      if (!where) return null
      const folder = await pathChecker.reservedFolderOf(where.companyId, where.rel).catch(() => null)
      if (folder === null) return null
      console.warn('[fs] Refused a write into a folder name that cannot be used')
      return reservedPathMessage(folder)
    },
  }
}
