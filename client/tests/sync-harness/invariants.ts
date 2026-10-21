// The invariants every scenario and every soak round must keep. Each maps to
// the promise sync makes to a member who only knows "press the sync button".

import fs from 'node:fs'
import { blobId, type World } from './world'

/**
 * No member's committed work is ever lost. Every file content a member
 * wrote and a sync committed (its latest committed version per path) must be
 * at least one of:
 *  - on the server (reachable from a server ref) — byte for byte, or for
 *    text, every line the member added inside one server file (a clean
 *    three-way merge with a teammate's change), or
 *  - in that member's .backups/<folder>/ next to a _metadata.json (the
 *    documented "server wins" outcome of a conflict, or a protected-config
 *    restore), or
 *  - still on the member's disk, byte-identical, at a path git now ignores
 *    (local-only content: .personal/, an excluded nested repository).
 */
export function assertNoLostWork(world: World, options: { allowUnpushed?: boolean } = {}): void {
  const serverObjects = world.serverObjects()
  let texts: Array<Set<string>> | null = null
  const mergedOnServer = (added: string[]) => {
    texts ??= world.serverTexts().map(t => new Set(t.split('\n')))
    return texts.some(lines => added.every(l => lines.has(l)))
  }
  const lost: string[] = []
  for (const m of world.members) {
    const backups = m.backupBlobs()
    // Mid-run (e.g. a member is offline) committed work may still be waiting
    // in the member's own history for the next push.
    const local = options.allowUnpushed
      ? new Set(m.git(['rev-list', '--objects', '--missing=allow-promisor', 'HEAD']).split('\n').filter(Boolean).map(l => l.slice(0, 40)))
      : new Set<string>()
    let localTexts: Array<Set<string>> | null = null
    const mergedLocally = (added: string[]) => {
      localTexts ??= world.texts(m.dir, ['HEAD']).map(t => new Set(t.split('\n')))
      return localTexts.some(lines => added.every(l => lines.has(l)))
    }
    for (const [rel, ob] of m.obligations) {
      if (serverObjects.has(ob.blob)) continue
      if (backups.has(ob.blob)) continue
      if (local.has(ob.blob)) continue
      // A text change merged cleanly with a teammate's: every line the member
      // added is in one server file. (Nothing added = a pure deletion of lines.)
      if (ob.added && (ob.added.length === 0 || mergedOnServer(ob.added))) continue
      if (options.allowUnpushed && ob.added && mergedLocally(ob.added)) continue
      try {
        if (blobId(fs.readFileSync(m.path(rel))) === ob.blob && m.isIgnored(rel)) continue
      } catch { /* not on disk */ }
      lost.push(`${m.name}: ${rel} (${ob.blob.slice(0, 10)}, ${ob.bytes.length} bytes: ${JSON.stringify(ob.bytes.subarray(0, 60).toString('utf-8'))})`)
    }
  }
  if (lost.length > 0) {
    throw new Error(`committed work lost (not on the server, not in .backups/, not kept locally):\n  ${lost.join('\n  ')}`)
  }
}

/**
 * After everyone has synced (twice, no new edits), every member is at the
 * server's main commit with a clean working tree. Ignored, local-only paths
 * (.personal/, .backups/, .workspace/, .env, excluded nested repos) are
 * allowed to differ — `git status` does not report them.
 */
export function assertConverged(world: World): void {
  const head = world.serverHead()
  const problems: string[] = []
  for (const m of world.members) {
    if (m.head() !== head) problems.push(`${m.name}: HEAD ${m.head().slice(0, 10)} != server ${head.slice(0, 10)}`)
    const status = m.git(['status', '--porcelain', '--untracked-files=all']).trim()
    if (status) problems.push(`${m.name}: working tree not clean:\n${status}`)
    if (m.hasPendingPush()) problems.push(`${m.name}: PENDING_PUSH left behind`)
    m.assertNoOperationInProgress()
  }
  const branches = world.serverBranches()
  if (branches.length !== 1 || branches[0] !== 'refs/heads/main') {
    problems.push(`server has unexpected refs: ${branches.join(', ')}`)
  }
  if (problems.length > 0) throw new Error(`members did not converge:\n  ${problems.join('\n  ')}`)
}

/** Settle (everyone syncs twice) and check every invariant. */
export async function settleAndCheck(world: World): Promise<void> {
  await world.settle(2)
  assertConverged(world)
  assertNoLostWork(world)
}
