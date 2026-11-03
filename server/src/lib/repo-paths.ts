/**
 * Which paths exist on a bare repository's shared branch (the records
 * detail's broken links, services/records.ts). Git only, asynchronous.
 */
import { existsSync } from 'fs'
import { gitAsync } from './git-exec'
import { resolveSharedBranch } from './repo-folders'

const BATCH = 500

/**
 * Which of `paths` (inside the repository) are on the shared branch's tip, and
 * whether each is a file or a folder (a git tree). Null when the repository or
 * its branch cannot be read (the caller then says nothing about them).
 */
export async function existingPaths(repo: string, paths: string[]): Promise<Map<string, 'file' | 'folder'> | null> {
  if (!existsSync(repo)) return null
  const ref = await resolveSharedBranch(repo)
  if (!ref) return null
  const tip = (await gitAsync(['-C', repo, 'rev-parse', ref])).trim()
  return pathKinds(repo, tip, paths)
}

/** `existingPaths` at a given commit (`tip`). */
export async function pathKinds(repo: string, tip: string, paths: string[]): Promise<Map<string, 'file' | 'folder'>> {
  const found = new Map<string, 'file' | 'folder'>()
  const usable = [...new Set(paths)].filter(p => p !== '' && !p.includes('\n'))
  for (let i = 0; i < usable.length; i += BATCH) {
    const chunk = usable.slice(i, i + BATCH)
    const check = await gitAsync(['-C', repo, 'cat-file', '--batch-check'], { input: chunk.map(p => `${tip}:${p}`).join('\n') + '\n' })
    check.split('\n').slice(0, chunk.length).forEach((line, idx) => {
      // `<sha> <type> <size>`, or `<object> missing`.
      if (!line.endsWith(' missing')) found.set(chunk[idx], line.split(' ')[1] === 'tree' ? 'folder' : 'file')
    })
  }
  return found
}
