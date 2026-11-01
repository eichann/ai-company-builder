/**
 * The kinds of company files a business plugin's file action may be offered
 * for (contract 2 `ui.file_actions[].kinds`, design 節目5 §2-1 slot ④「ファイルの
 * 右クリックの項目」). The plugin names kinds, never extensions or paths; the core
 * decides which kind a file is, here, so the app's menu and the declaration
 * check agree. Pure.
 *
 * - `file`: any file (not a folder); `folder`: a folder.
 * - The rest narrow a file by its extension (lower-cased, A–Z only).
 */
export const PLUGIN_FILE_KINDS = ['file', 'folder', 'markdown', 'text', 'pdf', 'image', 'spreadsheet', 'document', 'slides'] as const
export type PluginFileKind = typeof PLUGIN_FILE_KINDS[number]

const BY_EXTENSION: Record<string, PluginFileKind> = {
  md: 'markdown', markdown: 'markdown',
  txt: 'text', csv: 'text', tsv: 'text', json: 'text', yaml: 'text', yml: 'text',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', heic: 'image',
  xlsx: 'spreadsheet', xls: 'spreadsheet', numbers: 'spreadsheet',
  docx: 'document', doc: 'document', pages: 'document',
  pptx: 'slides', ppt: 'slides', key: 'slides',
}

/** The kinds a company file or folder is (`file` plus its extension's kind, or `folder`). */
export function pluginFileKindsOf(path: string, isDirectory: boolean): PluginFileKind[] {
  if (isDirectory) return ['folder']
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[A-Z]/g, c => c.toLowerCase()) : ''
  const kind = Object.prototype.hasOwnProperty.call(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : undefined
  return kind ? ['file', kind] : ['file']
}

/** Whether an action declared for `kinds` is offered on this file or folder. */
export function fileActionApplies(kinds: readonly string[], path: string, isDirectory: boolean): boolean {
  const own = pluginFileKindsOf(path, isDirectory)
  return kinds.some(k => (own as string[]).includes(k))
}
