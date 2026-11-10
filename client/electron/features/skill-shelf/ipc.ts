// A company Skill from the Skills panel (plugins.md "The Skill shelf in the app"), only in a working
// folder: skillShelf:publish (「会社に公開」: a local Skill's folder goes to the server, which
// decides), skillShelf:editLocally (「自分用に直す」: a delivered Skill becomes the member's own
// on this computer until they publish it), skillShelf:restoreCompany (「会社の版に戻す」: their
// version goes to .backups and the company's comes back), skillShelf:requestPublish
// (「会社に出してほしいと頼む」: the folder goes to those who may publish it, the server decides) and
// skillShelf:openBackup (「控えを開く」: the newest copy 会社の版に戻す kept, shown in Finder). A git
// company's folder is refused.

import path from 'node:path'
import { SHELF_LIMITS, isShelfVersion, outputLikePaths } from '../../../../shared/core/skill-shelf'
import {
  SHELF_ALREADY_COMPANY_MESSAGE, SHELF_BACKUP_OPEN_FAILED_MESSAGE, SHELF_NOT_A_PLACE_MESSAGE, SHELF_NOT_HERE_MESSAGE, SHELF_NOT_READABLE_MESSAGE, SHELF_NO_BACKUP_MESSAGE, SHELF_NO_PLACE_MESSAGE,
  SHELF_NOT_EDITING_MESSAGE, SHELF_OFFLINE_MESSAGE, SHELF_REQUEST_OFFLINE_MESSAGE, SHELF_RESTORE_BACKUPS_MESSAGE, SHELF_RESTORE_FAILED_MESSAGE, SHELF_RESTORE_PLACE_MESSAGE, SHELF_TOO_MUCH_MESSAGE, shelfPlaceOfSkillFolder,
  type SkillShelfRestoreResult, type SkillShelfSendResult,
} from '../../../shared/skill-shelf'
import type { ShelfFileUpload } from '../../../../shared/types/skill-shelf'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { DesktopShell, PathGuard } from '../ports'
import type { ShelfClient } from './client'
import { readSkillFolder, type SkillShelfStore } from './store'

export interface SkillShelfIpcDeps {
  paths: PathGuard
  isWorkingFolder: (rootPath: string) => boolean
  store: Pick<SkillShelfStore, 'companyOf' | 'markOf' | 'published' | 'release' | 'restoreCompany' | 'restoredOutcome' | 'syncNow' | 'latestBackup' | 'keepAside'>
  client: Pick<ShelfClient, 'departmentId' | 'publish' | 'request'>
  shell: Pick<DesktopShell, 'openPath'>
}

export function registerSkillShelfIpc(ipc: IpcRegistrar, { paths, isWorkingFolder, store, client, shell }: SkillShelfIpcDeps): void {
  /** The folder's place in the working folder, or why there is none. */
  function located(rootPath: string, skillPath: string): { root: string; skill: string; rel: string; companyId: string } | { error: string } {
    const root = paths.validate(rootPath)
    const skill = paths.validate(skillPath)
    const companyId = isWorkingFolder(root) ? store.companyOf(root) : undefined
    if (!companyId) return { error: SHELF_NOT_HERE_MESSAGE }
    const rel = path.relative(root, skill).split(path.sep).join('/')
    return { root, skill, rel, companyId }
  }

  /**
   * What a local Skill sends (publish and request alike): a Skill folder at a place that takes
   * Skills, not one the company delivered, read without links and junk (`readSkillFolder`), within
   * the shelf's limits, its department found by the folder. Files that look like outputs
   * (`outputLikePaths`) stop it before anything is sent, unless the member chose to leave them out.
   */
  async function upload(rootPath: string, skillPath: string, leaveOutOutputs: boolean): Promise<{ error: string } | { outputs: string[] } | { root: string; rel: string; companyId: string; departmentId: string | null; name: string; files: ShelfFileUpload[]; leftOut: string[] }> {
    const at = located(rootPath, skillPath)
    if ('error' in at) return at
    const place = shelfPlaceOfSkillFolder(at.rel)
    if (!place) return { error: SHELF_NOT_A_PLACE_MESSAGE }
    if (store.markOf(at.root, at.rel)?.state === 'company') return { error: SHELF_ALREADY_COMPANY_MESSAGE }
    const read = await readSkillFolder(at.skill)
    if (!read) return { error: SHELF_NOT_READABLE_MESSAGE }
    const outputs = outputLikePaths(read.map(f => f.path))
    if (outputs.length > 0 && leaveOutOutputs !== true) return { outputs }
    const files = read.filter(f => !outputs.includes(f.path))
    if (files.length > SHELF_LIMITS.files || files.reduce((sum, f) => sum + f.bytes.length, 0) > SHELF_LIMITS.skillBytes) return { error: SHELF_TOO_MUCH_MESSAGE }
    const departmentId = place.departmentFolder === null ? null : await client.departmentId(at.companyId, place.departmentFolder)
    if (departmentId === undefined) return { error: SHELF_NO_PLACE_MESSAGE }
    return { root: at.root, rel: at.rel, companyId: at.companyId, departmentId, name: place.name, files: files.map(f => ({ path: f.path, base64: f.bytes.toString('base64') })), leftOut: outputs }
  }

  /**
   * 外して出す, once the server took what was sent: the files left out move to the kept copies
   * (`store.keepAside`); only then, so a refusal leaves them where they were. `keptAside: false`
   * when they could not be moved (they stay where they were).
   */
  async function keptAside(at: { root: string; rel: string; leftOut: string[] }): Promise<{ keptAside?: boolean }> {
    if (at.leftOut.length === 0) return {}
    try {
      return { keptAside: await store.keepAside(at.root, at.rel, at.leftOut) }
    } catch (error) {
      console.error('Skill shelf keep-aside error:', (error as NodeJS.ErrnoException).code ?? 'unknown')
      return { keptAside: false }
    }
  }

  ipc.handle('skillShelf:publish',async (_, rootPath: string, skillPath: string, expectedVersion: string | null, leaveOutOutputs: boolean): Promise<SkillShelfSendResult> => {
    try {
      const at = await upload(rootPath, skillPath, leaveOutOutputs)
      if ('error' in at) return { success: false, error: at.error }
      if ('outputs' in at) return { success: false, outputs: at.outputs }
      if (expectedVersion !== null && !isShelfVersion(expectedVersion)) return { success: false, error: SHELF_NOT_READABLE_MESSAGE }
      const answer = await client.publish(at.companyId, { departmentId: at.departmentId, name: at.name, files: at.files, expectedVersion })
      if (!answer.ok) return { success: false, error: 'offline' in answer ? SHELF_OFFLINE_MESSAGE : answer.message }
      // Before the sync: the folder must be what was sent to be taken over as the company's.
      const kept = await keptAside(at)
      await store.published(at.root, at.rel)
      await store.syncNow(at.root)
      return { success: true, ...kept }
    } catch (error) {
      console.error('Skill shelf publish error:', error instanceof Error ? error.message : 'unknown')
      return { success: false, error: error instanceof Error ? error.message : SHELF_NOT_READABLE_MESSAGE }
    }
  })

  ipc.handle('skillShelf:requestPublish', async (_, rootPath: string, skillPath: string, leaveOutOutputs: boolean): Promise<SkillShelfSendResult> => {
    try {
      const at = await upload(rootPath, skillPath, leaveOutOutputs)
      if ('error' in at) return { success: false, error: at.error }
      if ('outputs' in at) return { success: false, outputs: at.outputs }
      const answer = await client.request(at.companyId, { departmentId: at.departmentId, name: at.name, files: at.files })
      if (!answer.ok) return { success: false, error: 'offline' in answer ? SHELF_REQUEST_OFFLINE_MESSAGE : answer.message }
      const kept = await keptAside(at)
      // The card shows 待っている from the next list.
      await store.syncNow(at.root)
      return { success: true, ...kept }
    } catch (error) {
      console.error('Skill shelf request error:', error instanceof Error ? error.message : 'unknown')
      return { success: false, error: SHELF_NOT_READABLE_MESSAGE }
    }
  })

  ipc.handle('skillShelf:openBackup', async (_, rootPath: string, skillPath: string) => {
    try {
      const at = located(rootPath, skillPath)
      if ('error' in at) return { success: false, error: at.error }
      const copy = store.latestBackup(at.root, at.rel)
      if (!copy) return { success: false, error: SHELF_NO_BACKUP_MESSAGE }
      // The store found it inside this working folder's own .backups, no link on the way (latestBackup).
      const opened = await shell.openPath(copy)
      return opened ? { success: false, error: SHELF_BACKUP_OPEN_FAILED_MESSAGE } : { success: true }
    } catch (error) {
      console.error('Skill shelf backup error:', error instanceof Error ? error.message : 'unknown')
      return { success: false, error: SHELF_BACKUP_OPEN_FAILED_MESSAGE }
    }
  })

  ipc.handle('skillShelf:editLocally', async (_, rootPath: string, skillPath: string) => {
    try {
      const at = located(rootPath, skillPath)
      if ('error' in at) return { success: false, error: at.error }
      return await store.release(at.root, at.rel) ? { success: true } : { success: false, error: SHELF_NOT_A_PLACE_MESSAGE }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : SHELF_NOT_READABLE_MESSAGE }
    }
  })

  ipc.handle('skillShelf:restoreCompany', async (_, rootPath: string, skillPath: string): Promise<SkillShelfRestoreResult> => {
    try {
      const at = located(rootPath, skillPath)
      if ('error' in at) return { success: false, error: at.error }
      const done = await store.restoreCompany(at.root, at.rel)
      if (!done.ok) return { success: false, error: { 'not-editing': SHELF_NOT_EDITING_MESSAGE, place: SHELF_RESTORE_PLACE_MESSAGE, backups: SHELF_RESTORE_BACKUPS_MESSAGE }[done.reason] }
      // Placed now when the server answers; otherwise by a later fetch (the hold is gone either way).
      await store.syncNow(at.root)
      return { success: true, companyVersion: store.restoredOutcome(at.root, at.rel, done.id) }
    } catch (error) {
      console.error('Skill shelf restore error:', error instanceof Error ? error.message : 'unknown')
      return { success: false, error: SHELF_RESTORE_FAILED_MESSAGE }
    }
  })
}
