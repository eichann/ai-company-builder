// Files created inside a folder the member excluded from their checkout
// (sparse exclusions: the settings panel, or the departments not picked at
// first setup) — a department, or any folder inside one. See the guards
// table in CLAUDE.md.
//
// The folder is absent on disk, so neither the member nor the chat AI can see
// what teammates keep there. A file written at e.g. 営業部/提案書.md lands on
// the path of a teammate's file this member never had: `git add --sparse .`
// staged it over the skip-worktree entry and sync silently replaced the
// teammate's file on the server — no conflict, no backup on either side.
// A file at a path the server does not have was shared, and the next sync's
// sparse reconcile then removed it from the member's disk (tracked, clean,
// outside the cone), so it vanished locally right after being "saved".
//
// Rule: before staging, every non-ignored file inside an excluded folder that
// differs from what the index already records (new, or different content) is
// moved to .backups/<timestamp>_outside_checkout/ with _metadata.json (reason
// `outside_checkout`) and reported. Nothing is shared from there, new paths
// included: sync cannot tell whether a teammate already has (or is about to
// push) the same path, and a shared file would disappear from the member's
// disk at the next sync anyway. The member downloads the folder in
// settings and saves the file again — inside the checkout everything is
// unchanged.

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { SimpleGit } from 'simple-git'
import { appliedExclusions } from './sparse'
import { pathKey } from '../../shared/sparse-paths'

export const OUTSIDE_CHECKOUT_REASON = 'outside_checkout'

export interface OutsideCheckoutResult {
  /** Repository-relative paths moved to the backup, sorted. */
  files: string[]
  /** The excluded root folders they were in. */
  folders: string[]
  /** Of `files`, the paths the server's main has (a teammate's file at the same path). */
  serverFiles: string[]
  backupPath: string
}

/** What the member is told (appended to the sync message). */
export function outsideCheckoutMessage(result: Pick<OutsideCheckoutResult, 'files' | 'folders'>): string {
  return `ダウンロードしていないフォルダ（${result.folders.join('、')}）にファイルが作られていたため、共有せずに .backups に保存しました（${result.files.length}件）。必要ならそのフォルダをダウンロードしてから保存し直してください。`
}

const CHUNK = 200
function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

/** Git's blob id of a symlink (its target), the way `git add` would store it. */
function symlinkBlobId(full: string): string {
  const target = Buffer.from(fs.readlinkSync(full))
  return createHash('sha1').update(`blob ${target.length}\0`).update(target).digest('hex')
}

/**
 * Put the index entries inside `folder` back to what HEAD has. Everything
 * below compares the disk with the index, so a file already staged there —
 * by an older app's preview, which ran `git add --sparse .`, or by a sync
 * that stopped between staging and committing — would read as unchanged and
 * be committed by the next `git add`. Sync never keeps anything staged
 * inside a folder that is not downloaded, so nothing is lost: the files stay
 * on disk and are judged like any other below. Index only; a path HEAD has
 * whose file is absent gets its skip-worktree bit back (never "deleted").
 */
async function unstageToHead(git: SimpleGit, repoPath: string, folder: string): Promise<void> {
  const head = (await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim()
  if (!head) return // nothing committed yet: nothing can be "not downloaded" either
  const staged = (await git.raw(['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD', '--', `:(literal,icase)${folder}/`]))
    .split('\0').filter(Boolean)
  if (staged.length === 0) return
  const inHead = new Map<string, { mode: string; oid: string }>()
  for (const group of chunks(staged)) {
    const listed = await git.raw(['ls-tree', '-r', '-z', head, '--', ...group])
    for (const entry of listed.split('\0')) {
      const tab = entry.indexOf('\t')
      if (tab === -1) continue
      const [mode, , oid] = entry.slice(0, tab).split(' ')
      inHead.set(entry.slice(tab + 1), { mode, oid })
    }
  }
  const added = staged.filter(f => !inHead.has(f))
  for (const group of chunks(added)) {
    await git.raw(['rm', '--cached', '--sparse', '--quiet', '--ignore-unmatch', '--', ...group])
  }
  const restored = staged.filter(f => inHead.has(f))
  for (const group of chunks(restored)) {
    await git.raw(['update-index', ...group.flatMap(f => {
      const { mode, oid } = inHead.get(f)!
      return ['--cacheinfo', `${mode},${oid},${f}`]
    })])
  }
  const absent = restored.filter(f => !fs.existsSync(path.join(repoPath, f)))
  for (const group of chunks(absent)) {
    await git.raw(['update-index', '--skip-worktree', '--', ...group])
  }
}

/**
 * Move the member's files inside excluded folders to the backup before
 * anything is staged. Returns null when there is nothing to hold back.
 */
export async function holdBackOutsideCheckout(options: {
  git: SimpleGit
  repoPath: string
  backupPath: string
  now: Date
  log: Pick<Console, 'log' | 'warn'>
}): Promise<OutsideCheckoutResult | null> {
  const { git, repoPath, backupPath, log } = options
  const folders = (await appliedExclusions(git, repoPath))
    .filter(f => fs.existsSync(path.join(repoPath, f)))
  if (folders.length === 0) return null

  const candidates = new Set<string>()
  const tracked: string[] = []
  for (const folder of folders) {
    await unstageToHead(git, repoPath, folder)

    // New files git would add (not ignored: .personal/, large files and
    // excluded nested repos stay where they are).
    const others = await git.raw(['ls-files', '-z', '--others', '--exclude-standard', '--', `:(literal,icase)${folder}/`])
    for (const f of others.split('\0')) if (f) candidates.add(f)

    // Tracked paths (skip-worktree entries for a teammate's files) that have
    // a file on disk with different content.
    const staged = await git.raw(['ls-files', '-z', '-s', '--', `:(literal,icase)${folder}/`])
    const presentRegular: Array<{ file: string; oid: string }> = []
    for (const entry of staged.split('\0')) {
      const tab = entry.indexOf('\t')
      if (tab === -1) continue
      const [mode, oid] = entry.slice(0, tab).split(' ')
      const file = entry.slice(tab + 1)
      if (mode === '160000') continue
      let st: fs.Stats
      try { st = fs.lstatSync(path.join(repoPath, file)) } catch { continue }
      if (st.isSymbolicLink()) {
        if (mode !== '120000' || symlinkBlobId(path.join(repoPath, file)) !== oid) candidates.add(file)
        tracked.push(file)
      } else if (st.isFile()) {
        if (mode === '120000') candidates.add(file)
        else presentRegular.push({ file, oid })
        tracked.push(file)
      }
    }
    // `hash-object` with the path applies the same filters `git add` would
    // (e.g. autocrlf), so an untouched copy is not mistaken for an edit.
    for (const group of chunks(presentRegular)) {
      const ids = (await git.raw(['hash-object', '--', ...group.map(g => g.file)])).split('\n').map(l => l.trim()).filter(Boolean)
      group.forEach((g, i) => { if (ids[i] !== g.oid) candidates.add(g.file) })
    }
  }
  const files = [...candidates].sort()
  if (files.length === 0) return null

  const onServer = new Set<string>()
  for (const group of chunks(files)) {
    const listed = await git.raw(['ls-tree', '-r', '-z', '--name-only', 'origin/main', '--', ...group]).catch(() => '')
    for (const f of listed.split('\0')) if (f) onServer.add(f)
  }
  const serverFiles = files.filter(f => onServer.has(f))
  const inFolder = (f: string, folder: string) => pathKey(f).startsWith(`${pathKey(folder)}/`)
  const heldFolders = folders.filter(folder => files.some(f => inFolder(f, folder)))

  // Metadata first: a crash halfway still leaves a listed, restorable backup.
  fs.mkdirSync(backupPath, { recursive: true })
  fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify({
    timestamp: options.now.toISOString(),
    reason: OUTSIDE_CHECKOUT_REASON,
    folders: heldFolders,
    files,
    serverFiles,
    note: 'created inside a folder that is not downloaded on this computer; not shared',
  }, null, 2))
  for (const file of files) {
    const src = path.join(repoPath, file)
    const dest = path.join(backupPath, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.renameSync(src, dest)
    } catch {
      fs.cpSync(src, dest, { verbatimSymlinks: true })
      fs.rmSync(src, { force: true })
    }
  }

  // The tracked paths are absent again: mark them skip-worktree as they were
  // before the file appeared (git clears the bit for a file present on disk),
  // so they read as "not checked out", never as deleted.
  const movedTracked = tracked.filter(f => !fs.existsSync(path.join(repoPath, f)))
  for (const group of chunks(movedTracked)) {
    await git.raw(['update-index', '--skip-worktree', '--', ...group])
  }

  // Drop the folders this left empty (the excluded folder was absent before).
  const pruneEmpty = (dir: string): boolean => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
    let empty = true
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink() && pruneEmpty(path.join(dir, e.name))) continue
      empty = false
    }
    if (empty) fs.rmdirSync(dir)
    return empty
  }
  // As spelled on disk (a file may have been written with another A–Z case).
  const onDisk = new Set<string>()
  for (const folder of heldFolders) {
    const depth = folder.split('/').length
    for (const f of files) if (inFolder(f, folder)) onDisk.add(f.split('/').slice(0, depth).join('/'))
  }
  for (const dir of onDisk) pruneEmpty(path.join(repoPath, dir))

  log.log(`Git sync: Held back ${files.length} file(s) created outside the checkout (${heldFolders.join(', ')}) in ${backupPath}`)
  return { files, folders: heldFolders, serverFiles, backupPath }
}
