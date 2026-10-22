// The invariants every scenario and every soak round must keep. Each maps to
// the promise sync makes to a member who only knows "press the sync button".

import fs from 'node:fs'
import path from 'node:path'
import { blobId, privateMarker, NO_LAZY_FETCH, type World } from './world'
import { pathKey } from '../../shared/sparse-paths'
import { readSparseConfig } from '../../electron/sync/sparse'
import { isNotDownloaded } from '../../shared/sparse-paths'

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
    const local = new Set<string>()
    if (options.allowUnpushed) {
      // The company checkout and every private folder's clone.
      for (const dir of [m.dir, ...m.privateClones().map(f => m.path(f.path))]) {
        for (const l of world.git(dir, ['rev-list', '--objects', '--missing=allow-promisor', 'HEAD'], NO_LAZY_FETCH).split('\n')) {
          if (l) local.add(l.slice(0, 40))
        }
      }
    }
    let localTexts: Array<Set<string>> | null = null
    const mergedLocally = (added: string[]) => {
      localTexts ??= [m.dir, ...m.privateClones().map(f => m.path(f.path))].flatMap(dir => world.texts(dir, ['HEAD'])).map(t => new Set(t.split('\n')))
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
    // A private folder's clone shows as untracked when a shared .gitignore
    // negation re-includes it (it outranks .git/info/exclude); sync never
    // stages it — not a difference from the server.
    const clones = m.privateClones().map(f => pathKey(f.path))
    const status = m.git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']).split('\n')
      .filter(l => l.trim() && !(l.startsWith('?? ') && clones.some(c => pathKey(l.slice(3).replace(/\/$/, '')).startsWith(c))))
      .join('\n')
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

/** Every file under `dir` (relative, '/'-separated), .git directories included or not. */
function walk(dir: string, options: { skipGit: boolean }, base = dir, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (options.skipGit && e.name === '.git') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, options, base, out)
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

/**
 * Private folders stay private (plan §1.3, decision B):
 *  - the company repository on the server never holds anything at or under
 *    a private folder's path, nor any private content (the marker scenarios
 *    write into it), in any commit;
 *  - a member who may not read a private folder has none of its content on
 *    disk — not in the working tree, not in .backups/, not in any object of
 *    their company repository — and no clone of it;
 *  - a member who may read it has a clone at its path (unless they left it
 *    out in settings) at the server's commit, with a clean working tree.
 * Folders made public are exempt from the content checks: their content
 * belongs to the company repository now.
 */
export function assertPrivacy(world: World, options: { converged?: boolean } = {}): void {
  const problems: string[] = []
  const folders = [...world.privateFolders.values()]
  if (folders.length === 0 && world.madePublic.size === 0) return
  const serverPaths = [...world.serverTree().keys()]
  for (const f of folders) {
    const k = pathKey(f.path)
    const hit = serverPaths.filter(p => pathKey(p) === k || pathKey(p).startsWith(`${k}/`))
    if (hit.length > 0) problems.push(`company repository has paths in private folder ${f.path}: ${hit.join(', ')}`)
  }
  // No commit message and no .gitignore of the company repository names a
  // private folder (decision B): sync never writes one there — not the
  // large-file scan, not the nested-repository exclusion. A folder made
  // public is named by the server's own commit, legitimately.
  const names = folders.map(f => f.path.normalize('NFC'))
  if (names.length > 0) {
    const messages = world.git(world.bare, ['log', '--all', '--format=%B']).normalize('NFC')
    const ignores = [...world.serverTree().keys()].filter(p => p === '.gitignore' || p.endsWith('/.gitignore'))
      .map(p => world.serverFile(p)?.toString('utf-8').normalize('NFC') ?? '')
    for (const name of names) {
      const last = name.split('/').pop() as string
      if (messages.includes(name)) problems.push(`a company commit message names private folder ${name}`)
      if (ignores.some(text => text.includes(name) || text.split('\n').some(l => l.replace(/^\/|\/$/g, '') === last))) {
        problems.push(`a company .gitignore names private folder ${name}`)
      }
    }
  }
  const markers = folders.map(f => privateMarker(f))
  if (markers.length > 0) {
    for (const text of world.companyTexts()) {
      for (const marker of markers) if (text.includes(marker)) problems.push(`company repository holds private content (${marker})`)
    }
  }
  for (const m of world.members) {
    const unreadable = folders.filter(f => !world.canRead(f, m.name))
    if (unreadable.length > 0) {
      const unreadableMarkers = unreadable.map(f => privateMarker(f))
      for (const rel of walk(m.dir, { skipGit: true })) {
        const text = fs.readFileSync(m.path(rel)).toString('utf-8')
        for (const marker of unreadableMarkers) if (text.includes(marker)) problems.push(`${m.name} cannot read but has private content on disk: ${rel} (${marker})`)
      }
      for (const text of world.texts(m.dir, ['--all'])) {
        for (const marker of unreadableMarkers) if (text.includes(marker)) problems.push(`${m.name} cannot read but has private content in the company .git (${marker})`)
      }
      for (const f of unreadable) {
        if (fs.existsSync(path.join(m.path(f.path), '.git'))) problems.push(`${m.name} cannot read ${f.path} but has a clone of it`)
      }
    }
    if (!options.converged) continue
    const excluded = readSparseConfig(m.dir).excluded
    for (const f of folders.filter(x => world.canRead(x, m.name))) {
      const dir = m.path(f.path)
      if (isNotDownloaded(excluded, f.path)) {
        if (fs.existsSync(path.join(dir, '.git'))) problems.push(`${m.name} left ${f.path} out but still has its clone`)
        continue
      }
      if (!fs.existsSync(path.join(dir, '.git'))) {
        problems.push(`${m.name} can read ${f.path} but has no clone of it`)
        continue
      }
      const head = world.git(dir, ['rev-parse', 'HEAD']).trim()
      if (head !== world.scopeHead(f.path)) problems.push(`${m.name}: ${f.path} HEAD ${head.slice(0, 10)} != scope server ${world.scopeHead(f.path).slice(0, 10)}`)
      const status = world.git(dir, ['status', '--porcelain', '--untracked-files=all']).trim()
      if (status) problems.push(`${m.name}: ${f.path} working tree not clean:\n${status}`)
      if (fs.existsSync(path.join(dir, '.git', 'PENDING_PUSH'))) problems.push(`${m.name}: ${f.path} PENDING_PUSH left behind`)
      for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'index.lock']) {
        if (fs.existsSync(path.join(dir, '.git', marker))) problems.push(`${m.name}: ${f.path} sync left .git/${marker} behind`)
      }
    }
  }
  if (problems.length > 0) throw new Error(`private folders:\n  ${problems.join('\n  ')}`)
}

/** Settle (everyone syncs twice) and check every invariant. */
export async function settleAndCheck(world: World): Promise<void> {
  await world.settle(2)
  assertConverged(world)
  assertNoLostWork(world)
  assertPrivacy(world, { converged: true })
}
