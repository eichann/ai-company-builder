/**
 * Which department a new 案件・プロジェクト belongs to by default (owner decision 2026-11-06,
 * records.md "A task and its 案件・プロジェクト"): the creator's own department (所属), whoever makes
 * it — the app's 「新しい〇〇にする」 and the AI's create. One copy for the server and the app.
 *
 * - The creator belongs to the department on screen → that one.
 * - The creator belongs to others → the first of them in the tabs' order.
 * - The creator belongs to none (an owner, say), or it is not known → the department on screen
 *   (null = 全社, the whole company).
 *
 * Pure: imports nothing outside shared/core.
 */
import { pathKey } from './paths'

export interface BundleDepartment {
  id: string
  folder: string
}

export function defaultBundleFolder(input: {
  /** The company's departments in the tabs' order. */
  departments: readonly BundleDepartment[]
  /** The ids of the departments the creator belongs to; null = not known. */
  mine: readonly string[] | null
  /** The folder of the department on screen; null = 全社. */
  onScreen: string | null
}): string | null {
  const mine = new Set(input.mine ?? [])
  const own = input.departments.filter(d => mine.has(d.id))
  if (own.length === 0) return input.onScreen
  if (input.onScreen !== null && own.some(d => pathKey(d.folder) === pathKey(input.onScreen as string))) return input.onScreen
  return own[0].folder
}
