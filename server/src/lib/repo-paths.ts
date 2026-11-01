/**
 * Which paths exist on a bare repository's shared branch (the records
 * detail's broken links, services/records.ts). Git only, asynchronous.
 */
import { existsSync } from 'fs'
import { gitAsync } from './git-exec'
import { resolveSharedBranch } from './repo-folders'

const BATCH = 500

/**
 * Which of `paths` (inside the repository) are on the shared branch's tip, as
 * a file or a folder. Null when the repository or its branch cannot be read
 * (the caller then says nothing about them).
 */
export async function existingPaths(repo: string, paths: string[]): Promise<Set<string> | null> {
  if (!existsSync(repo)) return null
  const ref = await resolveSharedBranch(repo)
  if (!ref) return null
  const tip = (await gitAsync(['-C', repo, 'rev-parse', ref])).trim()
  const found = new Set<string>()
  const usable = [...new Set(paths)].filter(p => p !== '' && !p.includes('\n'))
  for (let i = 0; i < usable.length; i += BATCH) {
    const chunk = usable.slice(i, i + BATCH)
    const check = await gitAsync(['-C', repo, 'cat-file', '--batch-check'], { input: chunk.map(p => `${tip}:${p}`).join('\n') + '\n' })
    check.split('\n').slice(0, chunk.length).forEach((line, idx) => {
      if (!line.endsWith(' missing')) found.add(chunk[idx])
    })
  }
  return found
}
