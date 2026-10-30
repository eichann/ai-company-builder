// Is a skill folder already shared with the company? (skills:makePrivate)
// Tracked here (the index) or present on the server's branch (origin/main,
// as of the last fetch: a teammate's skill of the same name that this
// computer has not pulled yet). Read-only; never downloads a blob.

import type { SimpleGit } from 'simple-git'

export async function skillIsShared(git: SimpleGit, relFolder: string): Promise<boolean> {
  const spec = `:(literal)${relFolder}`
  try {
    if ((await git.raw(['ls-files', '--', spec])).trim() !== '') return true
  } catch {
    return false // not a repository: nothing is shared
  }
  try {
    return (await git.raw(['ls-tree', '-r', '--name-only', 'origin/main', '--', spec])).trim() !== ''
  } catch {
    return false // no origin/main yet
  }
}
