// [RESERVED_PATH] — a private folder's path used in the company repository.
//
// The server reserves every private folder's path in the company repository
// for everyone (stage 3a): a push adding or changing anything at or under one
// is rejected with [RESERVED_PATH], each path followed by a reason line that
// names the folder exactly as the pusher typed it:
//
//     [RESERVED_PATH] 使えない名前のフォルダが含まれています
//       - 人事/評価/メモ.md
//           （『人事/評価』というフォルダ名は使えません。別の名前にしてください。）
//
// It happens when a member who cannot see a private folder (or their chat
// AI) creates a folder of the same name. Sync resolves it without a dialog,
// like PERSONAL_PATH, but the files do NOT stay where they are: a file left
// in place would be staged again by the next sync and rejected again (the
// "permanently unable to sync" shape), and silently ignoring it instead would
// mean the member's files never reach anyone (plan §1.3 C). So they go to
// .backups/<ts>_reserved_path/ (with _metadata.json), the member is shown the
// server's reason verbatim, and saves them again under another folder name.
//
// Two ways in, one outcome:
//  - holdBackReservedPaths: BEFORE staging, the app tests every new path
//    with the server's path check (POST …/paths/check, ./path-check.ts);
//  - untrackReservedPaths: the push was rejected anyway (the check could not answer or
//    stale): squash the unpushed commits (the hook checks every commit),
//    back up and remove the listed paths, undo exact moves into the folder,
//    commit the rest; the caller pushes once more — never in a loop.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { ProtectedConfigRecoveryError } from '../protected-config'
import { reservedPathMessage } from '../../../shared/types/private-folders'
import { moveInto, pruneEmptyUp } from './private-folders'
import { pathPrefixes } from './path-check'
import { pathKey } from '../../shared/sparse-paths'

export const RESERVED_PATH_MARKER = '[RESERVED_PATH]'
export const RESERVED_PATH_REASON = 'reserved_path'

export function isReservedPathRejection(errorMessage: string): boolean {
  return errorMessage.includes(RESERVED_PATH_MARKER)
}

export interface ReservedRejection {
  /** Repository-relative paths, as the server listed them. */
  paths: string[]
  /** The reason lines, verbatim (trimmed), deduplicated in order. */
  reasons: string[]
  /** Folder (pusher's spelling) per path, from the reason line ('' when none). */
  folderOf: Record<string, string>
}

/** The [RESERVED_PATH] section of a push error: "  - <path>" lines, each followed by its reason line. */
export function parseReservedPathRejection(errorMessage: string): ReservedRejection {
  const lines = errorMessage.split(/\r?\n/).map(line => line.replace(/^remote:\s?/, '').trimEnd())
  const start = lines.findIndex(line => line.includes(RESERVED_PATH_MARKER))
  const out: ReservedRejection = { paths: [], reasons: [], folderOf: {} }
  if (start === -1) return out
  let separators = 0
  let last: string | null = null
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    const section = /^\[[A-Z_]+\]/.exec(trimmed)
    if (section && section[0] !== RESERVED_PATH_MARKER) break
    if (/^=+$/.test(trimmed)) {
      if (++separators === 2) break
      continue
    }
    if (trimmed.startsWith('- ')) {
      const p = trimmed.slice(2)
      last = p
      if (p && !out.paths.includes(p)) out.paths.push(p)
      continue
    }
    const m = /^（『(.*)』というフォルダ名は使えません。.*）$/.exec(trimmed)
    if (m && last !== null) {
      out.folderOf[last] = m[1]
      if (!out.reasons.includes(trimmed)) out.reasons.push(trimmed)
    }
  }
  return out
}

/** What the member is told: the files were moved, and why (the server's reason lines verbatim, or ours). */
export function reservedPathNote(options: { files: string[]; folders: string[]; reasons?: string[] }): string {
  const reasons = options.reasons && options.reasons.length > 0
    ? options.reasons
    : options.folders.map(f => reservedPathMessage(f))
  return `使えない名前のフォルダに作られたファイル（${options.files.length}件）は共有せずに .backups に移しました。別の名前のフォルダに保存し直してから同期してください。\n${reasons.join('\n')}`
}

export interface ReservedHoldBack {
  /** Repository-relative files (or nested-repository folders) moved, sorted. */
  files: string[]
  /** The reserved folders, as the member spelled them. */
  folders: string[]
  backupPath: string
  /** Server reason lines (push-rejection path only). */
  reasons?: string[]
}

function writeMetadata(backupPath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(backupPath, { recursive: true })
  fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({ reason: RESERVED_PATH_REASON, ...data }, null, 2))
}

/**
 * At most this many paths are checked per sync — one request; the server
 * allows 60 paths per member per minute. More new folders than that are left
 * to the server's [RESERVED_PATH] check and the recovery below.
 */
export const MAX_CHECKED_PATHS = 50

/**
 * Before staging: move every new path (untracked, not ignored; a nested
 * repository counts as one entry) that lies at or under a folder name the
 * member may not use to `backupPath`. `checkUsable` asks the server
 * (./path-check.ts): every prefix of a new path that the company repository
 * does not already have — the first one answered "not usable" is the folder
 * to name. Unknown answers never hold anything back. Returns null when
 * nothing matched.
 */
export async function holdBackReservedPaths(options: {
  git: SimpleGit
  repoPath: string
  backupPath: string
  now: Date
  checkUsable: (paths: string[]) => Promise<Map<string, boolean>>
  log: Pick<Console, 'log' | 'warn'>
}): Promise<ReservedHoldBack | null> {
  const { git, repoPath, backupPath, checkUsable, log } = options
  const raw = await git.raw(['ls-files', '-z', '--others', '--exclude-standard'])
  const entries = raw.split('\0').filter(Boolean).map(e => e.replace(/\/$/, ''))
  if (entries.length === 0) return null
  // What the company repository already has (files and their folders) is
  // never at or under a private folder: the server refuses that.
  const known = new Set<string>()
  for (const f of (await git.raw(['ls-files', '-z']).catch(() => '')).split('\0')) {
    if (!f) continue
    const segs = f.split('/')
    for (let i = 1; i <= segs.length; i++) known.add(pathKey(segs.slice(0, i).join('/').normalize('NFC')))
  }
  // New folders only: a private folder is a folder, so anything at or under
  // one has a new folder prefix at or under it (a file named exactly like
  // the folder is left to the server's check). A nested repository's entry
  // is a folder itself.
  const prefixesOf = (entry: string, isDir: boolean) => {
    const all = pathPrefixes(entry)
    return (isDir ? all : all.slice(0, -1)).filter(p => !known.has(pathKey(p)))
  }
  const dirEntries = new Set(raw.split('\0').filter(e => e.endsWith('/')).map(e => e.slice(0, -1)))
  const candidates = [...new Set(entries.flatMap(e => prefixesOf(e, dirEntries.has(e))))].slice(0, MAX_CHECKED_PATHS)
  if (candidates.length === 0) return null
  const answers = await checkUsable(candidates)
  const matched: Array<{ entry: string; folder: string }> = []
  for (const entry of entries) {
    const folder = prefixesOf(entry, dirEntries.has(entry)).find(p => answers.get(p) === false)
    if (folder) matched.push({ entry, folder })
  }
  if (matched.length === 0) return null
  const files = matched.map(m => m.entry).sort()
  const folders = [...new Set(matched.map(m => m.folder))].sort()
  // Metadata first: a crash halfway still leaves a listed, restorable backup.
  writeMetadata(backupPath, { timestamp: options.now.toISOString(), folders, files, note: 'a folder name that cannot be used in the company folder; not shared — save these under another name' })
  for (const { entry } of matched) {
    moveInto(path.join(repoPath, entry), path.join(backupPath, entry))
    pruneEmptyUp(path.dirname(path.join(repoPath, entry)), repoPath)
  }
  log.log(`Git sync: Moved ${files.length} file(s) in a reserved folder name (${folders.join(', ')}) to ${backupPath}`)
  return { files, folders, backupPath }
}

/**
 * After a [RESERVED_PATH] rejection: squash the unpushed commits, back up
 * the listed paths from the member's latest commit, remove them from the
 * commit and from disk, put back a file the member had only moved there
 * (exact move, the server still has the old path), and commit the rest.
 */
export async function untrackReservedPaths(options: {
  git: SimpleGit
  repoPath: string
  rejection: ReservedRejection
  backupPath: string
  now: Date
  upstream?: string
  /**
   * Paths that must never be deleted from disk here, only backed up (when the
   * commit has a file there) and taken out of the commit: inside a readable
   * private folder the disk holds its clone — deleting would lose the
   * member's unsynced private work.
   */
  keepOnDisk?: (relPath: string) => boolean
}): Promise<ReservedHoldBack & { committed: boolean; restoredMoves: string[] }> {
  const keepOnDisk = options.keepOnDisk ?? (() => false)
  const { git, repoPath, rejection, backupPath } = options
  const upstream = options.upstream ?? 'origin/main'
  const paths = rejection.paths
  if (paths.length === 0) throw new ProtectedConfigRecoveryError('対象のファイルが特定できませんでした')
  const root = path.resolve(repoPath)
  for (const p of paths) {
    const full = path.resolve(root, p)
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..') || !full.startsWith(root + path.sep)) {
      throw new ProtectedConfigRecoveryError(`不正なパスです: ${p}`)
    }
  }
  const localHead = (await git.revparse(['HEAD'])).trim()
  const upstreamHash = (await git.revparse([upstream])).trim()
  const mergeBase = (await git.raw(['merge-base', upstreamHash, localHead]).catch(() => '')).trim()
  if (mergeBase !== upstreamHash) {
    throw new ProtectedConfigRecoveryError('サーバーの最新状態を取り込めていないため、自動で外せませんでした。もう一度同期してください。')
  }

  // 1. Back up the member's version (binary-safe, from the commit).
  const backedUp: string[] = []
  const movedOids = new Set<string>()
  for (const file of paths) {
    const entry = (await git.raw(['ls-tree', '-z', localHead, '--', file]).catch(() => '')).split('\0')[0]
    if (!entry) continue // only an intermediate commit had it: the squash drops it
    const [mode, type, oid] = entry.slice(0, entry.indexOf('\t')).split(' ')
    if (type !== 'blob') continue
    const dest = path.join(backupPath, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const content: Buffer = await git.binaryCatFile(['-p', oid])
    if (mode === '120000') {
      try { fs.symlinkSync(content.toString('utf-8'), dest) } catch { fs.writeFileSync(dest, content) }
    } else {
      fs.writeFileSync(dest, content)
    }
    backedUp.push(file)
    movedOids.add(oid)
  }
  const folders = [...new Set(paths.map(p => rejection.folderOf[p]).filter((f): f is string => !!f))].sort()
  writeMetadata(backupPath, {
    timestamp: options.now.toISOString(),
    folders,
    files: backedUp,
    rejectedFiles: paths,
    reasons: rejection.reasons,
    localHead,
    note: 'rejected by the server: a folder name that cannot be used in the company folder; not shared — save these under another name',
  })

  const squashedMessages = (await git.raw(['log', '--format=%s', `${upstreamHash}..${localHead}`]))
    .split('\n').map(s => s.trim()).filter(Boolean)

  // 2. Squash, 3. drop the paths from the commit and from disk.
  await git.raw(['reset', '--soft', upstreamHash])
  for (const file of paths) {
    await git.raw(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--sparse', '--', file])
    if (keepOnDisk(file)) continue
    const full = path.join(repoPath, file)
    fs.rmSync(full, { recursive: true, force: true })
    pruneEmptyUp(path.dirname(full), repoPath)
  }

  // 4. An exact move into the folder: put the file back where it was.
  const restoredMoves: string[] = []
  if (movedOids.size > 0) {
    const deleted = (await git.raw(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D', '-z', upstreamHash]))
      .split('\0').filter(Boolean)
    for (const file of deleted) {
      if (paths.includes(file)) continue
      const entry = (await git.raw(['ls-tree', '-z', upstreamHash, '--', file]).catch(() => '')).split('\0')[0]
      const oid = entry ? entry.slice(0, entry.indexOf('\t')).split(' ')[2] : ''
      if (oid && movedOids.has(oid) && !fs.existsSync(path.join(repoPath, file))) {
        await git.raw(['checkout', upstreamHash, '--', file])
        movedOids.delete(oid)
        restoredMoves.push(file)
      }
    }
  }

  // 5. Commit what is left.
  let committed = false
  const remaining = (await git.raw(['diff', '--cached', '--name-only', '-z', upstreamHash])).replace(/\0/g, '')
  if (remaining) {
    const subject = squashedMessages.length === 1 ? squashedMessages[0] : 'Sync from AI Company Builder'
    const body = squashedMessages.length > 1 ? `\n\n${squashedMessages.map(m => `- ${m}`).join('\n')}` : ''
    await git.commit(`${subject}${body}\n\n（使えない名前のフォルダのファイルは共有対象から外しました）`)
    committed = true
  }
  return { files: backedUp, folders, backupPath, reasons: rejection.reasons, committed, restoredMoves }
}
