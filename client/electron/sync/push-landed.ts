// A `git push` that throws has not necessarily failed. The server may have
// received and accepted the pack and only the client side died afterwards:
// the git watchdog (sync/git-factory.ts) killed a push whose pre-receive hook
// ran past five minutes without output, or the connection dropped before the
// final status reached the client. Reporting that as "プッシュに失敗しました"
// and writing PENDING_PUSH tells the member their work did not reach the team
// when it did (observed in production, 2026-10-21).
//
// So before treating a push error as a failure, sync asks the server: fetch,
// and if HEAD is already contained in origin/main the push landed. A
// recognised rejection is never second-guessed — the server said no — and a
// fetch that fails keeps the failure (nothing is known).

import type { SimpleGit } from 'simple-git'
import type { SyncLogger } from './types'
import { PERSONAL_PATH_MARKER, PROTECTED_CONFIG_MARKER } from '../protected-config'

/** Markers of a push the server (or its auth) refused: it definitely did not land. */
const REJECTION_MARKERS = [
  'SECRET_DETECTED',
  PROTECTED_CONFIG_MARKER,
  PERSONAL_PATH_MARKER,
  'WINPATH_DETECTED',
  '[rejected]',
  '[remote rejected]',
  'non-fast-forward',
  'pre-receive hook declined',
  'Authentication failed',
  'could not read Username',
  'returned error: 401',
  'returned error: 403',
]

export function isServerRejection(errorMessage: string): boolean {
  return REJECTION_MARKERS.some(marker => errorMessage.includes(marker))
}

/**
 * True when the push that threw `pushError` reached the server anyway: the
 * error is not a server rejection, a fresh fetch succeeds, and no commit of
 * HEAD is missing from origin/main.
 */
export async function pushLandedDespiteError(git: SimpleGit, log: SyncLogger, pushError: unknown): Promise<boolean> {
  const message = pushError instanceof Error ? pushError.message : String(pushError)
  if (isServerRejection(message)) return false
  try {
    await git.fetch(['--progress', 'origin'])
    const missing = (await git.raw(['rev-list', '--count', 'origin/main..HEAD'])).trim()
    if (missing !== '0') return false
  } catch {
    return false
  }
  log.warn('Git sync: Push reported an error, but the server already has every local commit — treating it as pushed:', message)
  return true
}
