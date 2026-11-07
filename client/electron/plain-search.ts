// 探す and Cmd+P in the working folder of a company without the shared company folder
// (services/working-folders.ts): no git runs there, so file names and content are read from
// the disk directly, with git-search.ts's limits and answer shapes. No Electron import.
//
// What is searched: the files on this computer under the folder, never inside `.git`,
// `.backups`, `.workspace` or `node_modules` (any depth), never through a symbolic link.

import fs from 'node:fs'
import path from 'node:path'
import { GREP_MAX_PER_FILE, GREP_MAX_TOTAL, GREP_TIMEOUT_MS, LIST_MAX_FILES, normalizeSearchFolder, trimMatchLine, type GrepResult } from './git-search'

const SKIPPED_FOLDERS = new Set(['.git', '.backups', '.workspace', 'node_modules'])
/** Larger files are not searched for content (a log, a video); their names are still listed. */
const MAX_SEARCHED_BYTES = 4 * 1024 * 1024

/** Every file under `folder` ('' = the whole working folder), working-folder-relative, '/'-separated. */
export async function listPlainFiles(root: string, folder: string, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
  const start = normalizeSearchFolder(folder)
  const files: string[] = []
  const pending = [start]
  while (pending.length > 0) {
    if (signal?.aborted) break
    const rel = pending.shift()!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name.toLowerCase())) pending.push(child)
      } else if (entry.isFile()) {
        if (files.length >= LIST_MAX_FILES) return { files, truncated: true }
        files.push(child.normalize('NFC'))
      }
    }
  }
  return { files, truncated: false }
}

/** A–Z folded (as `git grep -i` under LC_ALL=C), NFC. */
const fold = (s: string) => s.normalize('NFC').replace(/[A-Z]/g, c => c.toLowerCase())

/** Content search, fixed string, A–Z case-insensitive, with git-search.ts's caps. */
export async function grepPlainFiles(root: string, folder: string, query: string, signal?: AbortSignal): Promise<GrepResult> {
  const result: GrepResult = { matches: [], truncated: false, timedOut: false }
  if (!query) return result
  const needle = fold(query)
  const deadline = Date.now() + GREP_TIMEOUT_MS
  const { files, truncated } = await listPlainFiles(root, folder, signal)
  for (const file of files) {
    if (signal?.aborted) break
    if (Date.now() > deadline) return { ...result, truncated: true, timedOut: true }
    let content: Buffer
    try {
      const full = path.join(root, ...file.split('/'))
      if ((await fs.promises.stat(full)).size > MAX_SEARCHED_BYTES) continue
      content = await fs.promises.readFile(full)
    } catch {
      continue
    }
    // Binary files (a NUL near the start) are skipped, as `git grep -I` does.
    if (content.subarray(0, 8000).includes(0)) continue
    const lines = content.toString('utf8').split('\n')
    let inFile = 0
    for (let i = 0; i < lines.length && inFile < GREP_MAX_PER_FILE; i++) {
      const line = lines[i].normalize('NFC')
      const at = fold(line).indexOf(needle)
      if (at < 0) continue
      if (result.matches.length >= GREP_MAX_TOTAL) return { ...result, truncated: true }
      const { text, column } = trimMatchLine(Buffer.from(line, 'utf8'), Buffer.byteLength(line.slice(0, at), 'utf8') + 1)
      result.matches.push({ file, line: i + 1, text, column })
      inFile++
    }
  }
  return { ...result, truncated: result.truncated || truncated }
}
