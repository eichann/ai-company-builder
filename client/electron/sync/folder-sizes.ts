// Folder listing with sizes for the settings panel's "ダウンロードするフォルダ"
// tree, one level at a time.
//
// Sizes come from the server (GET /api/companies/:id/folder-sizes): a partial
// clone has no blobs for what it did not download, and `git ls-tree -l` there
// would download every one of them just to report its size. When the server
// cannot be reached the folders are still listed from the local trees (every
// clone has all trees; reading them downloads nothing), without sizes.

import type { SimpleGit } from 'simple-git'

export interface FolderNode {
  name: string
  /** Repository-relative, as the repository spells it. */
  path: string
  size: number | null
  files: number | null
  hasChildren: boolean
}

export interface FolderSizesView {
  /** The folder listed ('' = the company root). */
  path: string
  size: number | null
  folders: FolderNode[]
  /** Sizes of the `measure` folders (null = unknown / not a folder). */
  measured: Record<string, number | null>
  /** True when the server could not be reached: names only, no sizes. */
  offline: boolean
}

export type FetchFolderSizes = (folder: string, measure: string[]) => Promise<Omit<FolderSizesView, 'offline'>>

/** The server's answer for one folder (throws when it cannot be had). */
export function serverFolderSizes(options: { baseUrl: string; companyId: string; cookies: string[]; fetchImpl?: typeof fetch; timeoutMs?: number }): FetchFolderSizes {
  return async (folder, measure) => {
    const params = new URLSearchParams()
    params.set('path', folder)
    for (const m of measure) params.append('measure', m)
    const res = await (options.fetchImpl ?? fetch)(
      `${options.baseUrl}/api/companies/${encodeURIComponent(options.companyId)}/folder-sizes?${params}`,
      { headers: { Cookie: options.cookies.join('; ') }, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) },
    )
    if (!res.ok) throw new Error(`folder-sizes: HTTP ${res.status}`)
    const body = await res.json() as { data?: { path: string; size: number; folders: Array<{ name: string; path: string; size: number; files: number; hasChildren: boolean }>; measured: Record<string, number | null> } }
    if (!body.data) throw new Error('folder-sizes: no data')
    return {
      path: body.data.path,
      size: body.data.size,
      folders: body.data.folders.map(f => ({ ...f })),
      measured: body.data.measured ?? {},
    }
  }
}

/** Sub-folders of `folder` on origin/main from the local trees (no blobs read). */
export async function localFolders(git: SimpleGit, folder: string): Promise<FolderNode[]> {
  const target = folder ? `origin/main:${folder}` : 'origin/main'
  const raw = await git.raw(['ls-tree', '-z', target])
  const out: FolderNode[] = []
  for (const record of raw.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const type = record.slice(0, tab).split(' ')[1]
    if (type !== 'tree' && type !== 'commit') continue
    const name = record.slice(tab + 1)
    out.push({ name, path: folder ? `${folder}/${name}` : name, size: null, files: null, hasChildren: type === 'tree' })
  }
  return out.sort((a, b) => a.name.normalize('NFC').localeCompare(b.name.normalize('NFC'), 'ja'))
}

/** The panel's view of one folder: the server's sizes, or the local listing when offline. */
export async function folderSizesView(git: SimpleGit, fetchSizes: FetchFolderSizes | null, folder: string, measure: string[]): Promise<FolderSizesView> {
  if (fetchSizes) {
    try {
      return { ...(await fetchSizes(folder, measure)), offline: false }
    } catch (error) {
      console.warn('[folder-sizes] server unavailable, listing local trees:', error instanceof Error ? error.message : error)
    }
  }
  return {
    path: folder,
    size: null,
    folders: await localFolders(git, folder),
    measured: Object.fromEntries(measure.map(m => [m, null])),
    offline: true,
  }
}
