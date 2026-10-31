/**
 * Reading record files and type definitions from a bare repository for the
 * company map's indexer (services/records.ts, `.claude/rules/records.md`).
 * Git only, asynchronous, nothing checked out; no database.
 *
 * - Since a known commit: the `.md` files the diff to the shared branch's tip
 *   adds, changes or deletes (deleted → text null).
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

export const MAX_RECORD_FILE_BYTES = 1024 * 1024
const BATCH = 500

export interface RecordFileChange {
  /** Path inside the repository. */
  path: string
  /** UTF-8 text; null when the file was deleted (or is too large / unreadable). */
  text: string | null
}

export interface RecordRepoRead {
  /** The shared branch's tip that was read; null when the repository has none. */
  tip: string | null
  /** true: `changes` are every candidate (anything not listed is gone). */
  full: boolean
  changes: RecordFileChange[]
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
  if (!existsSync(repo)) return { tip: null, full: true, changes: [] }
  const ref = await resolveSharedBranch(repo)
  if (!ref) return { tip: null, full: true, changes: [] }
  const tip = (await gitAsync(['-C', repo, 'rev-parse', ref])).trim()
  if (since === tip) return { tip, full: false, changes: [] }
  if (since !== null && await commitExists(repo, since)) {
    const diff = await gitAsync(['-C', repo, 'diff-tree', '-r', '-z', '--no-renames', '--name-status', since, tip])
    const parts = diff.split('\0')
    const present: string[] = []
    const changes: RecordFileChange[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]
      const path = parts[i + 1]
      if (!isMarkdown(path)) continue
      if (status === 'D') changes.push({ path, text: null })
      else present.push(path)
    }
    const texts = await readTexts(repo, tip, present)
    for (const p of present) changes.push({ path: p, text: texts.get(p) ?? null })
    return { tip, full: false, changes }
  }
  const paths = await candidatePaths(repo, tip)
  const texts = await readTexts(repo, tip, paths)
  return { tip, full: true, changes: paths.filter(p => texts.has(p)).map(p => ({ path: p, text: texts.get(p) as string })) }
}
