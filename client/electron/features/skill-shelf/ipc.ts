// A company Skill from the Skills panel (plugins.md "The Skill shelf in the app"), only in a working
// folder: skillShelf:publish (「会社に公開」: a local Skill's folder goes to the server, which
// decides) and skillShelf:editLocally (「手元で直す」: a delivered Skill becomes the member's own
// on this computer until they publish it). A git company's folder is refused.

import path from 'node:path'
import { SHELF_LIMITS, isShelfVersion } from '../../../../shared/core/skill-shelf'
import {
  SHELF_ALREADY_COMPANY_MESSAGE, SHELF_NOT_A_PLACE_MESSAGE, SHELF_NOT_HERE_MESSAGE, SHELF_NOT_READABLE_MESSAGE, SHELF_NO_PLACE_MESSAGE,
  SHELF_OFFLINE_MESSAGE, SHELF_TOO_MUCH_MESSAGE, shelfPlaceOfSkillFolder,
} from '../../../shared/skill-shelf'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'
import type { ShelfClient } from './client'
import { readSkillFolder, type SkillShelfStore } from './store'

export interface SkillShelfIpcDeps {
  paths: PathGuard
  isWorkingFolder: (rootPath: string) => boolean
  store: Pick<SkillShelfStore, 'companyOf' | 'markOf' | 'published' | 'release' | 'syncNow'>
  client: Pick<ShelfClient, 'departmentId' | 'publish'>
}

export function registerSkillShelfIpc(ipc: IpcRegistrar, { paths, isWorkingFolder, store, client }: SkillShelfIpcDeps): void {
  /** The folder's place in the working folder, or why there is none. */
  function located(rootPath: string, skillPath: string): { root: string; skill: string; rel: string; companyId: string } | { error: string } {
    const root = paths.validate(rootPath)
    const skill = paths.validate(skillPath)
    const companyId = isWorkingFolder(root) ? store.companyOf(root) : undefined
    if (!companyId) return { error: SHELF_NOT_HERE_MESSAGE }
    const rel = path.relative(root, skill).split(path.sep).join('/')
    return { root, skill, rel, companyId }
  }

  ipc.handle('skillShelf:publish', async (_, rootPath: string, skillPath: string, expectedVersion: string | null) => {
    try {
      const at = located(rootPath, skillPath)
      if ('error' in at) return { success: false, error: at.error }
      const place = shelfPlaceOfSkillFolder(at.rel)
      if (!place) return { success: false, error: SHELF_NOT_A_PLACE_MESSAGE }
      if (expectedVersion !== null && !isShelfVersion(expectedVersion)) return { success: false, error: SHELF_NOT_READABLE_MESSAGE }
      if (store.markOf(at.root, at.rel)?.state === 'company') return { success: false, error: SHELF_ALREADY_COMPANY_MESSAGE }

      const files = await readSkillFolder(at.skill)
      if (!files) return { success: false, error: SHELF_NOT_READABLE_MESSAGE }
      if (files.length > SHELF_LIMITS.files || files.reduce((sum, f) => sum + f.bytes.length, 0) > SHELF_LIMITS.skillBytes) return { success: false, error: SHELF_TOO_MUCH_MESSAGE }

      const departmentId = place.departmentFolder === null ? null : await client.departmentId(at.companyId, place.departmentFolder)
      if (departmentId === undefined) return { success: false, error: SHELF_NO_PLACE_MESSAGE }

      const answer = await client.publish(at.companyId, {
        departmentId,
        name: place.name,
        files: files.map(f => ({ path: f.path, base64: f.bytes.toString('base64') })),
        expectedVersion,
      })
      if (!answer.ok) return { success: false, error: 'offline' in answer ? SHELF_OFFLINE_MESSAGE : answer.message }
      await store.published(at.root, at.rel)
      await store.syncNow(at.root)
      return { success: true }
    } catch (error) {
      console.error('Skill shelf publish error:', error instanceof Error ? error.message : 'unknown')
      return { success: false, error: error instanceof Error ? error.message : SHELF_NOT_READABLE_MESSAGE }
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
}
