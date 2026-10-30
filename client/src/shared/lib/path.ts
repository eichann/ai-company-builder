/**
 * Normalize path separators to forward slashes for comparison.
 *
 * On Windows, fs:changes events carry native backslash paths from chokidar,
 * while renderer-held paths are built with forward-slash joins on top of
 * dialog-returned native paths (mixed separators). Raw startsWith/equality
 * comparisons between the two always fail, so normalize both sides first.
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Whether `filePath` is inside `folderPath` (or is it), separator-insensitive. */
export function isPathWithin(filePath: string, folderPath: string): boolean {
  const file = normalizePathSeparators(filePath)
  const folder = normalizePathSeparators(folderPath).replace(/\/+$/, '')
  return file === folder || file.startsWith(`${folder}/`)
}
