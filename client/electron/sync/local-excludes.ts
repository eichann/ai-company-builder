// Managed blocks of a repository's .git/info/exclude: ignore rules that stay
// on this computer (never committed, never shown to a teammate). Each owner
// (private folders, nested repositories) has its own block between its own
// marker lines; a writer replaces only its block, in place, and keeps every
// other line — the member's own, git's template, the other blocks.

import fs from 'fs'
import path from 'path'

export interface ExcludeBlock {
  begin: string
  end: string
}

function excludeFile(repoPath: string): string {
  return path.join(repoPath, '.git', 'info', 'exclude')
}

/** A path as a literal gitignore pattern (glob characters and a leading `!` / `#` escaped). */
function escapePattern(p: string): string {
  return p.replace(/[\\*?[\]!#]/g, c => `\\${c}`)
}

/** The exclude lines for these folders: each anchored, in NFC and NFD (git matches the bytes it reads from disk). */
export function folderExcludeLines(paths: readonly string[]): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    for (const variant of [p, p.normalize('NFC'), p.normalize('NFD')]) {
      const line = `/${escapePattern(variant)}/`
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  return lines
}

/**
 * Make `block` list exactly `paths` (as anchored folder patterns). An
 * existing block is replaced where it stands; a new one is appended. No
 * paths removes the block. Returns true when the file changed.
 */
export function writeExcludeBlock(repoPath: string, block: ExcludeBlock, paths: readonly string[]): boolean {
  const file = excludeFile(repoPath)
  let text = ''
  try { text = fs.readFileSync(file, 'utf-8') } catch { /* none yet */ }
  const lines = text === '' ? [] : text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const begin = lines.indexOf(block.begin)
  const end = begin >= 0 ? lines.indexOf(block.end, begin) : -1
  const body = paths.length > 0 ? [block.begin, ...folderExcludeLines(paths), block.end] : []
  let next: string[]
  if (begin >= 0 && end >= 0) {
    next = [...lines.slice(0, begin), ...body, ...lines.slice(end + 1)]
  } else {
    if (body.length === 0) return false
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    next = [...lines, ...body]
  }
  const out = next.length > 0 ? next.join('\n') + '\n' : ''
  if (out === text) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, out)
  return true
}

/** The folders listed in `block` (NFC, deduplicated). */
export function readExcludeBlock(repoPath: string, block: ExcludeBlock): string[] {
  let text = ''
  try { text = fs.readFileSync(excludeFile(repoPath), 'utf-8') } catch { return [] }
  const lines = text.split('\n')
  const begin = lines.indexOf(block.begin)
  const end = begin >= 0 ? lines.indexOf(block.end, begin) : -1
  if (begin < 0 || end < 0) return []
  const out = new Set<string>()
  for (const line of lines.slice(begin + 1, end)) {
    const m = /^\/(.+)\/$/.exec(line)
    if (m) out.add(m[1].replace(/\\(.)/g, '$1').normalize('NFC'))
  }
  return [...out]
}
