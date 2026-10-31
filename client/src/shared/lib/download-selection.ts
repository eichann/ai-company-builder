/**
 * The settings panel's "ダウンロードするフォルダ" draft: which folders the
 * member wants left out, edited as a tree of tri-state checkboxes and applied
 * in one go. Pure — the main process applies it (electron/sync/sparse.ts).
 *
 * The model is shared/sparse-paths.ts: an exclusion list, everything else
 * downloaded; an excluded folder covers its whole subtree (no re-including
 * inside it, so its children are shown unchecked and disabled).
 */
import { excludedFolderOf, exclusionsInside, normalizeExclusions, pathKey } from '../../../shared/sparse-paths'

/**
 * - `checked`: downloaded, nothing inside left out
 * - `partial`: downloaded, but something inside is left out
 * - `unchecked`: left out (this folder is in the list)
 * - `inherited`: inside a folder that is left out (cannot be changed on its own)
 */
export type FolderCheckState = 'checked' | 'partial' | 'unchecked' | 'inherited'

export function folderCheckState(exclusions: readonly string[], folder: string): FolderCheckState {
  const covering = excludedFolderOf(exclusions, folder)
  if (covering !== null) return pathKey(covering) === pathKey(folder) ? 'unchecked' : 'inherited'
  return exclusionsInside(exclusions, folder).length > 0 ? 'partial' : 'checked'
}

/**
 * Click on a folder's checkbox. Checked or partial → leave the whole folder
 * out (what was left out inside it is folded in). Unchecked → download it
 * again. Inherited → no change.
 */
export function toggleFolder(exclusions: readonly string[], folder: string): string[] {
  const state = folderCheckState(exclusions, folder)
  if (state === 'inherited') return [...exclusions]
  if (state === 'unchecked') return exclusions.filter(e => pathKey(e) !== pathKey(folder))
  const key = pathKey(folder)
  return normalizeExclusions([...exclusions.filter(e => !pathKey(e).startsWith(`${key}/`)), folder])
}

export interface SelectionDiff {
  /** Folders that will stop being downloaded. */
  excluded: string[]
  /** Folders that will be downloaded again. */
  included: string[]
}

export function diffSelection(applied: readonly string[], draft: readonly string[]): SelectionDiff {
  const a = new Set(applied.map(pathKey))
  const d = new Set(draft.map(pathKey))
  return {
    excluded: draft.filter(e => !a.has(pathKey(e))),
    included: applied.filter(e => !d.has(pathKey(e))),
  }
}

export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  const d = diffSelection(a, b)
  return d.excluded.length === 0 && d.included.length === 0
}

/** Bytes of the company that are downloaded with these exclusions; null when a size is unknown. */
export function downloadedBytes(total: number | null, exclusions: readonly string[], sizes: Readonly<Record<string, number | null | undefined>>): number | null {
  if (total === null) return null
  let excluded = 0
  for (const e of normalizeExclusions(exclusions)) {
    const s = sizes[e]
    if (s === null || s === undefined) return null
    excluded += s
  }
  return Math.max(0, total - excluded)
}

/** 「12.4 GB」「850 MB」「3 KB」 (1024-based, one decimal from GB up when < 100). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.max(0, bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const digits = i >= 3 && v < 100 ? 1 : i >= 2 && v < 10 ? 1 : 0
  return `${v.toFixed(digits)} ${units[i]}`
}
