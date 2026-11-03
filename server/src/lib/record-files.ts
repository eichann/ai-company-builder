/**
 * Reading record files and type definitions from a bare repository for the
 * company map's indexer (services/records.ts, `.claude/rules/records.md`).
 * Git only, asynchronous, nothing checked out; no database.
 *
 * - Since a known commit: the `.md` files the diff to the shared branch's tip
 *   adds, changes or deletes (deleted → text null; a renamed one is its old
 *   path deleted and its new path added), and every file the diff renames
 *   or moves (git's rename detection, any file type): links to a file follow
 *   it (services/record-index.ts). A folder that is gone at the tip and whose
 *   files moved together to one new folder (`folderMoves`) is reported as a
 *   rename too, so links to the folder follow it.
 * - In full (first run, after a reindex, or when the known commit is gone):
 *   the `.md` files that have both an `id:` and a `type:` line (`git grep`,
 *   which reads the tree in C — a 15k-file company is not read file by file
 *   in this process) plus the type definitions under `.acb/types/`.
 *
 * Files larger than MAX_RECORD_FILE_BYTES are not records (skipped).
 */
import { existsSync } from 'fs'
import { gitAsync, gitBufferAsync } from './git-exec'
import { resolveSharedBranch } from './repo-folders'
import { pathKinds } from './repo-paths'

export const MAX_RECORD_FILE_BYTES = 1024 * 1024
const BATCH = 500

export interface RecordFileChange {
  /** Path inside the repository. */
  path: string
  /** UTF-8 text; null when the file was deleted (or is too large / unreadable). */
  text: string | null
}

export interface RecordFileRename {
  /** Paths inside the repository. */
  from: string
  to: string
}

export interface RecordRepoRead {
  /** The shared branch's tip that was read; null when the repository has none. */
  tip: string | null
  /** true: `changes` are every candidate (anything not listed is gone). */
  full: boolean
  changes: RecordFileChange[]
  /** Files renamed or moved since the commit read last (none on a full read). */
  renames: RecordFileRename[]
}

/** At most this many folders are considered moved per read (a huge move still follows its top folders). */
export const MAX_FOLDER_MOVE_CANDIDATES = 5000

/**
 * Folders the renames moved as a whole (pure; the caller keeps only the ones
 * gone at the tip): for each folder P above a renamed file (never the
 * repository root), the Q every rename `P/x → Q/x` under it agrees on.
 * Renames under P that do not keep their path below P (`P/a → R/b`) say
 * nothing; at least one must agree, and two different Qs mean no move.
 */
export function folderMoves(renames: readonly RecordFileRename[]): RecordFileRename[] {
  const votes = new Map<string, string | null>()
  for (const { from, to } of renames) {
    const parts = from.split('/')
    for (let depth = parts.length - 1; depth >= 1; depth--) {
      const folder = parts.slice(0, depth).join('/')
      const rest = parts.slice(depth).join('/')
      if (!to.endsWith(`/${rest}`)) continue
      const target = to.slice(0, to.length - rest.length - 1)
      if (target === folder || target === '') continue
      if (!votes.has(folder)) {
        if (votes.size >= MAX_FOLDER_MOVE_CANDIDATES) continue
        votes.set(folder, target)
      } else if (votes.get(folder) !== target) {
        votes.set(folder, null)
      }
    }
  }
  return [...votes].flatMap(([from, to]) => (to === null ? [] : [{ from, to }]))
}

const isMarkdown = (p: string) => /\.md$/i.test(p) && !p.includes('\n')

async function commitExists(repo: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return false
  try {
    await gitAsync(['-C', repo, 'cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** Blob texts of `paths` at `tip`, skipping missing / non-blob / too large ones. */
async function readTexts(repo: string, tip: string, paths: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>()
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH)
    const check = await gitAsync(['-C', repo, 'cat-file', '--batch-check'], { input: chunk.map(p => `${tip}:${p}`).join('\n') + '\n' })
    const wanted: Array<{ path: string; oid: string }> = []
    check.split('\n').slice(0, chunk.length).forEach((line, idx) => {
      const [oid, type, size] = line.split(' ')
      if (type === 'blob' && Number(size) <= MAX_RECORD_FILE_BYTES) wanted.push({ path: chunk[idx], oid })
    })
    if (wanted.length === 0) continue
    const out = await gitBufferAsync(['-C', repo, 'cat-file', '--batch'], wanted.map(w => w.oid).join('\n') + '\n')
    let pos = 0
    for (const w of wanted) {
      const nl = out.indexOf(10, pos)
      if (nl === -1) break
      const [oid, type, sizeText] = out.toString('latin1', pos, nl).split(' ')
      const size = Number(sizeText)
      if (oid !== w.oid || type !== 'blob' || !Number.isFinite(size)) break
      texts.set(w.path, out.toString('utf8', nl + 1, nl + 1 + size))
      pos = nl + 1 + size + 1
    }
  }
  return texts
}

async function candidatePaths(repo: string, tip: string): Promise<string[]> {
  let grep = ''
  try {
    grep = await gitAsync(['-C', repo, 'grep', '-l', '-z', '-I', '--all-match', '-e', '^id:', '-e', '^type:', tip, '--', '*.md'])
  } catch (err) {
    if ((err as { code?: number }).code !== 1) throw err // 1 = nothing matched
  }
  const prefix = `${tip}:`
  const records = grep.split('\0').filter(Boolean).map(p => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
  let types: string[] = []
  try {
    types = (await gitAsync(['-C', repo, 'ls-tree', '-z', '--name-only', tip, '.acb/types/'])).split('\0').filter(Boolean)
  } catch {
    types = []
  }
  return [...new Set([...records, ...types])].filter(isMarkdown)
}

/** What changed in `repo` since `since` (null → read in full). */
export async function readRecordFiles(repo: string, since: string | null): Promise<RecordRepoRead> {
  if (!existsSync(repo)) return { tip: null, full: true, changes: [], renames: [] }
  const ref = await resolveSharedBranch(repo)
  if (!ref) return { tip: null, full: true, changes: [], renames: [] }
  const tip = (await gitAsync(['-C', repo, 'rev-parse', ref])).trim()
  if (since === tip) return { tip, full: false, changes: [], renames: [] }
  if (since !== null && await commitExists(repo, since)) {
    // Rename detection (-M): `R<score>\0<old>\0<new>\0`, every other status `<s>\0<path>\0`.
    const diff = await gitAsync(['-C', repo, 'diff-tree', '-r', '-z', '-M', '--name-status', since, tip])
    const parts = diff.split('\0')
    const present: string[] = []
    const changes: RecordFileChange[] = []
    const renames: RecordFileRename[] = []
    const touch = (status: string, path: string) => {
      if (!isMarkdown(path)) return
      if (status === 'D') changes.push({ path, text: null })
      else present.push(path)
    }
    for (let i = 0; i + 1 < parts.length;) {
      const status = parts[i]
      if (status.startsWith('R') && i + 2 < parts.length) {
        const from = parts[i + 1]
        const to = parts[i + 2]
        if (!from.includes('\n') && !to.includes('\n')) renames.push({ from, to })
        touch('D', from)
        touch('A', to)
        i += 3
      } else {
        touch(status, parts[i + 1])
        i += 2
      }
    }
    const texts = await readTexts(repo, tip, present)
    for (const p of present) changes.push({ path: p, text: texts.get(p) ?? null })
    // A folder moved or renamed as a whole (gone at the tip): links to it follow like a file's.
    const moved = folderMoves(renames)
    if (moved.length > 0) {
      const still = await pathKinds(repo, tip, moved.map(m => m.from))
      for (const m of moved) if (!still.has(m.from)) renames.push(m)
    }
    return { tip, full: false, changes, renames }
  }
  const paths = await candidatePaths(repo, tip)
  const texts = await readTexts(repo, tip, paths)
  return { tip, full: true, changes: paths.filter(p => texts.has(p)).map(p => ({ path: p, text: texts.get(p) as string })), renames: [] }
}
