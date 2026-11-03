// Is a skill folder already shared with the company? (skills:makePrivate)
// Tracked here (the index) or present on the server's branch (origin/main,
// as of the last fetch: a teammate's skill of the same name that this
// computer has not pulled yet). Read-only; never downloads a blob. Sync asks
// the same before it moves a private-skill line (sync/local-ignores.ts).

import type { SimpleGit } from 'simple-git'
import { trackedOrOnServer } from '../../sync/local-ignores'

export function skillIsShared(git: SimpleGit, relFolder: string): Promise<boolean> {
  return trackedOrOnServer(git, relFolder)
}
