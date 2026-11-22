/**
 * The chat's ［見る］ (doc-frame.md "The chat's ［見る］ (A3)"): which HTML document a finished
 * 「ファイルに書きました／直しました」 row offers to show. Pure. The owner's decision: the viewer never
 * opens by itself when the AI makes or changes an HTML file; the member presses ［見る］.
 *
 * Offered only for a call that wrote and worked, naming an `.html` / `.htm` file as an absolute
 * path inside the company folder, with no `.` / `..` / empty segment. Main still checks everything
 * when the document is opened (`docView:open`): this only decides where a button is shown.
 */
import { isHtmlDocumentName } from '../../../shared/doc-frame'
import { isPathWithin, normalizePathSeparators } from '../../shared/lib/path'
import type { ToolRow } from './toolRows'

/** The agents' tools that write a file (Claude Code, the api-key mode's tools; Codex reports `Write` with `changes`). */
const WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'writeFile'])

function pathsOf(input: unknown): unknown[] {
  if (typeof input !== 'object' || input === null) return []
  const i = input as { file_path?: unknown; path?: unknown; changes?: unknown }
  const changed = Array.isArray(i.changes) ? i.changes.map(c => (c as { path?: unknown } | null)?.path) : []
  return [i.file_path, i.path, ...changed]
}

/** The absolute path of the HTML document a finished writing row can show, or null. */
export function documentToViewOf(row: Pick<ToolRow, 'toolName' | 'state' | 'input' | 'failure'>, rootPath: string | null | undefined): string | null {
  if (!rootPath || !WRITING_TOOLS.has(row.toolName) || row.state !== 'output-available' || row.failure) return null
  const root = normalizePathSeparators(rootPath).replace(/\/+$/, '')
  for (const value of pathsOf(row.input)) {
    if (typeof value !== 'string') continue
    const path = normalizePathSeparators(value.trim())
    const rest = path.slice(root.length + 1).split('/')
    if (path === root || !isPathWithin(path, root) || rest.some(s => s === '' || s === '.' || s === '..')) continue
    if (isHtmlDocumentName(rest[rest.length - 1])) return path
  }
  return null
}
