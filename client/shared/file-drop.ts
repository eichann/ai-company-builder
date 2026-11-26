/**
 * What a Finder drop may bring into the company folder (files-and-editor.md "File tree"): the one
 * rule, asked by the file tree for its per-file warning and by main's `fs:copyFromExternal`, which
 * decides. HTML is shown in the sandboxed document view (doc-frame.md), so it is allowed like any
 * other document. A video may be as large as sync still shares (`LARGE_FILE_THRESHOLD`, sync.md
 * step 4), so nothing a drop takes in is then silently kept on this computer only.
 */
import { LARGE_FILE_THRESHOLD } from './large-file-limit'
import { isVideoFileName, VIDEO_EXTENSIONS } from './video-files'

export const DROP_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'md', 'txt', 'csv', 'pdf', 'docx', 'xlsx', 'pptx', 'html', 'htm',
  'json', 'yaml', 'yml',
  ...VIDEO_EXTENSIONS,
])
export const MAX_DROP_FILE_SIZE = 20 * 1024 * 1024 // 20MB

export const DROP_WORDS = {
  type: '非対応の形式',
  size: '20MBを超えています',
  video: '100MBを超える動画はほかの人と共有できないため、入れられません',
} as const

/**
 * Why `name` (as it will be named in the company folder) is refused, or null. A file with no
 * extension is held to the size alone; a folder only when it is named like a video (the preview
 * and 「ほかのアプリで開く」 take such a name for a file).
 */
export function dropRefusal(name: string, entry: { isDirectory: boolean; size: number }): string | null {
  if (entry.isDirectory) return isVideoFileName(name) ? DROP_WORDS.type : null
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext && !DROP_EXTENSIONS.has(ext)) return DROP_WORDS.type
  if (isVideoFileName(name)) return entry.size > LARGE_FILE_THRESHOLD ? DROP_WORDS.video : null
  return entry.size > MAX_DROP_FILE_SIZE ? DROP_WORDS.size : null
}
