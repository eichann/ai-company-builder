/** The drag data the file tree puts on its rows: a JSON array of the dragged absolute paths. */
export const FILE_PATHS_DRAG_TYPE = 'application/x-file-paths'

/** The absolute paths a drag from the file tree carries (none for anything else). */
export function draggedFilePaths(data: Pick<DataTransfer, 'getData'>): string[] {
  try {
    const v: unknown = JSON.parse(data.getData(FILE_PATHS_DRAG_TYPE) || '[]')
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Whether a drag over a target comes from the file tree (its data is readable only on drop). */
export function isFileTreeDrag(data: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(data.types).includes(FILE_PATHS_DRAG_TYPE)
}

/**
 * What a drag from the file tree allows: moving onto a folder, linking onto a record (its card's
 * 「つながっているもの」 uses `link`). A drop whose dropEffect the source does not allow never fires.
 */
export const FILE_TREE_EFFECT_ALLOWED = 'linkMove'

/** Whether a drop target's `dropEffect` is one the drag source allows (the browser drops nothing otherwise). */
export function dropEffectAllowed(effectAllowed: string, dropEffect: 'copy' | 'move' | 'link'): boolean {
  if (effectAllowed === 'all' || effectAllowed === 'uninitialized') return true
  return effectAllowed.toLowerCase().includes(dropEffect)
}
