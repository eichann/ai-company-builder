/**
 * Folder sizes on the shared branch, for the desktop app's "ダウンロードする
 * フォルダ" settings (which folders to download, and how big each is).
 *
 * Why the server: a member who set the company up with only some departments
 * has a partial clone (trees, no blobs outside what they downloaded). Tree
 * entries carry no sizes, and `git ls-tree -l` in such a clone fetches every
 * missing blob just to report its size — the download the member chose not
 * to make. The bare repository has every blob.
 *
 * One `ls-tree -r -l -z` of the branch's commit, parsed once and cached per
 * commit (a few thousand entries); every folder of that commit is answered
 * from memory. Sizes are the blobs' (uncompressed) sizes; gitlinks count as
 * folders of size 0. Asynchronous only: this runs in the process that also
 * serves git-http (no execFileSync, see tests/security/no-exec-sync.test.ts).
 */
import { existsSync } from 'fs'
import { companyRepoPath } from './config'
import { gitAsync } from './git-exec'

async function sharedBranchCommit(bare: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    try {
      return (await gitAsync(['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).trim()
    } catch {
      // next name
    }
  }
  return null
}

interface Entry { path: string; size: number; isFolder: boolean }

const cache = new Map<string, Entry[]>()
const CACHE_LIMIT = 16

async function entriesOf(bare: string, commit: string): Promise<Entry[]> {
  const key = `${bare}\0${commit}`
  const hit = cache.get(key)
  if (hit) return hit
  const out = await gitAsync(['-C', bare, 'ls-tree', '-r', '-l', '-z', commit])
  const entries: Entry[] = []
  for (const record of out.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [, type, , size] = record.slice(0, tab).split(/\s+/)
    entries.push({ path: record.slice(tab + 1), size: type === 'blob' ? Number(size) || 0 : 0, isFolder: type === 'commit' })
  }
  cache.set(key, entries)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return entries
}

export interface FolderSize {
  /** Name as the repository spells it. */
  name: string
  /** Repository-relative path as the repository spells it. */
  path: string
  /** Total size in bytes of every file below it. */
  size: number
  /** Number of files below it. */
  files: number
  /** Whether it has sub-folders. */
  hasChildren: boolean
}

export interface FolderSizesResult {
  commit: string
  /** The folder asked for, as the repository spells it ('' = the root). */
  path: string
  size: number
  files: number
  /** Its immediate sub-folders, sorted by name. */
  folders: FolderSize[]
  /** Sizes of the other folders asked for (`measure`), keyed as asked; null = not a folder. */
  measured: Record<string, number | null>
}

const nfc = (s: string) => s.normalize('NFC')

/**
 * `folder` as the tree spells it, comparing in NFC (a Mac may have committed
 * a Japanese name in NFD); '' for the root, null when it is not a folder.
 */
function resolveFolder(entries: Entry[], folder: string): string | null {
  const want = nfc(folder.split('/').filter(Boolean).join('/'))
  if (want === '') return ''
  const depth = want.split('/').length
  for (const e of entries) {
    const segments = e.path.split('/')
    if (segments.length < depth || (segments.length === depth && !e.isFolder)) continue
    const candidate = segments.slice(0, depth).join('/')
    if (nfc(candidate) === want) return candidate
  }
  return null
}

/**
 * Sizes of `folder` ('' = the root) and its immediate sub-folders on the
 * shared branch of the company's bare repository. null when the repository,
 * the branch or the folder does not exist. `measure` lists more folders whose
 * total size the caller needs (the ones a member left out).
 */
export async function folderSizes(companyId: string, folder: string, measure: string[] = []): Promise<FolderSizesResult | null> {
  const bare = companyRepoPath(companyId)
  if (!existsSync(bare)) return null
  const commit = await sharedBranchCommit(bare)
  if (!commit) return null
  const entries = await entriesOf(bare, commit)
  const stored = resolveFolder(entries, folder)
  if (stored === null) return null
  const prefix = stored === '' ? '' : `${stored}/`
  let size = 0
  let files = 0
  const children = new Map<string, FolderSize>()
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue
    const rest = e.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (!e.isFolder) { size += e.size; files++ }
    if (slash === -1 && !e.isFolder) continue
    const name = slash === -1 ? rest : rest.slice(0, slash)
    let child = children.get(name)
    if (!child) {
      child = { name, path: `${prefix}${name}`, size: 0, files: 0, hasChildren: false }
      children.set(name, child)
    }
    if (slash === -1) continue // a gitlink: a folder with nothing below it here
    const below = rest.slice(slash + 1)
    if (below.includes('/') || e.isFolder) child.hasChildren = true
    if (!e.isFolder) { child.size += e.size; child.files++ }
  }
  const measured: Record<string, number | null> = {}
  for (const m of measure) {
    const s = resolveFolder(entries, m)
    if (s === null || s === '') { measured[m] = null; continue }
    let total = 0
    for (const e of entries) if (!e.isFolder && e.path.startsWith(`${s}/`)) total += e.size
    measured[m] = total
  }
  return {
    commit,
    path: stored,
    size,
    files,
    folders: [...children.values()].sort((a, b) => nfc(a.name).localeCompare(nfc(b.name), 'ja')),
    measured,
  }
}
