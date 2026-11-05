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
import { companyFileOf, companyPathOf, readPrivateScopesCache, readableScopeOf } from '../../sync/private-folders'
import { readLocalPrivateSkills } from '../../sync/local-ignores'
import { agentConfigMessage, inPrivateSkill, isUnsharedPath, skillFileMessage, type InstructionAuthority } from '../../write-guard'
import { isSkillFile, mayChangeSkillFile } from '../../../../shared/core/skill-files'
import { isAgentConfig } from '../../../../shared/core/agent-config'
import { FULL_ACCESS_ROLES } from '../../../../shared/core/permissions'

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
    reservedFolderOf(rel: string, options?: { file?: boolean }): Promise<string | null>
    readOnlyFolderOf(rel: string): string | null
  } | undefined
  /** The server's sentence when creating `absPath` would use a folder name the member may not use; else null. */
  reservedRefusal(absPath: string): Promise<string | null>
  /**
   * The sentence when the member may not change the skill file at `absPath`;
   * else null, also while their authority is unknown (the push check decides).
   * A skill kept on this computer is theirs, unless it is about to be shared (`sharing`).
   */
  skillRefusal(absPath: string, options?: { sharing?: boolean }): Promise<string | null>
  /**
   * The sentence when the member may not change the agent config at `absPath`
   * (owner/admin only, shared/core/agent-config.ts); else null, also while
   * their authority is unknown (the push check decides).
   */
  agentConfigRefusal(absPath: string): Promise<string | null>
  /** What the app's own file operations ask: the skill rule, the agent config rule, then the reserved names. */
  writeRefusal(absPath: string): Promise<string | null>
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

  function refreshAuthority(companyId: string, timeoutMs: number): Promise<void> {
    let pending = authorityRefreshes.get(companyId)
    if (!pending) {
      pending = api.capabilities(companyId)
        .then(result => {
          if (!result.success) return
          if (result.role === 'owner' || result.role === 'admin' || result.managedDepartmentFolders) {
            instructionAuthority.set(companyId, {
              role: result.role,
              managedFolders: result.managedDepartmentFolders ?? [],
              ...(result.skillEditing ? { skillEditing: result.skillEditing } : {}),
            })
          } else instructionAuthority.delete(companyId)
        })
        .catch(() => {})
        .finally(() => authorityRefreshes.delete(companyId))
      authorityRefreshes.set(companyId, pending)
    }
    return waitAtMost(pending, timeoutMs)
  }

  async function reservedRefusal(absPath: string): Promise<string | null> {
    if (fs.existsSync(absPath)) return null
    const where = companyPathOf(absPath)
    if (!where) return null
    const folder = await pathChecker.reservedFolderOf(where.companyId, where.rel).catch(() => null)
    if (folder === null) return null
    console.warn('[fs] Refused a write into a folder name that cannot be used')
    return reservedPathMessage(folder)
  }

  async function skillRefusal(absPath: string, options?: { sharing?: boolean }): Promise<string | null> {
    const where = companyFileOf(absPath)
    if (!where || !isSkillFile(where.rel) || isUnsharedPath(where.rel)) return null
    if (!options?.sharing && inPrivateSkill(readLocalPrivateSkills(where.root), where.rel)) return null
    // Only skill files come this far. A known answer is used at once (an editor
    // save never waits on the network) and refreshed for the next one.
    const pending = refreshAuthority(where.companyId, 3000)
    if (!instructionAuthority.has(where.companyId)) await pending
    const authority = instructionAuthority.get(where.companyId)
    if (!authority?.skillEditing || mayChangeSkillFile({ ...authority, skillEditing: authority.skillEditing }, where.rel)) return null
    console.warn('[fs] Refused a change to a skill file')
    return skillFileMessage(where.rel)
  }

  async function agentConfigRefusal(absPath: string): Promise<string | null> {
    const where = companyFileOf(absPath)
    if (!where || !isAgentConfig(where.rel) || isUnsharedPath(where.rel)) return null
    const pending = refreshAuthority(where.companyId, 3000)
    if (!instructionAuthority.has(where.companyId)) await pending
    const authority = instructionAuthority.get(where.companyId)
    if (!authority || FULL_ACCESS_ROLES.has(authority.role)) return null
    console.warn('[fs] Refused a change to agent config')
    return agentConfigMessage(where.rel)
  }

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
    refreshAuthority,
    authority: companyId => instructionAuthority.get(companyId),
    // Private folders as the chat write guard sees them, from the cached
    // /me/scopes answer sync keeps in the company's .git (no network call).
    guardView(root) {
      const cache = readPrivateScopesCache(root)
      if (!cache) return undefined
      const readable = [...cache.scopes, ...(cache.pendingPublic ?? [])]
      return {
        reservedFolderOf: async (rel: string, options?: { file?: boolean }) => {
          if (readableScopeOf(readable, rel) || fs.existsSync(path.join(root, ...rel.split('/')))) return null
          return pathChecker.reservedFolderOf(cache.companyId, rel, options).catch(() => null)
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
    reservedRefusal,
    skillRefusal,
    agentConfigRefusal,
    writeRefusal: async absPath => await skillRefusal(absPath) ?? await agentConfigRefusal(absPath) ?? await reservedRefusal(absPath),
  }
}
