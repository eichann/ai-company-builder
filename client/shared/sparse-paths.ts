/**
 * Folders a member chose not to download ("not downloaded" / 未ダウンロード),
 * at any depth — pure path logic shared by sync (electron/sync/sparse.ts,
 * outside-checkout.ts), the app's file operations and chat write guard
 * (main process) and the renderer (settings tree, file-tree placeholders).
 *
 * Model: everything is downloaded except the member's EXCLUSION list, a set
 * of repository-relative folder paths ('営業部', 'コンテンツ/動画'). The
 * sparse checkout is non-cone:
 *
 *     /*
 *     !/営業部/
 *     !/コンテンツ/動画/
 *
 * so a folder a teammate creates later anywhere outside an excluded folder is
 * downloaded automatically, and a folder the member creates is never outside
 * the checkout. Re-including something inside an excluded folder is not
 * supported: an exclusion covers its whole subtree (normalizeExclusions drops
 * the redundant entries below another one).
 *
 * Paths are compared like the push check and the write guard
 * (shared/write-access.ts): NFC, '/'-separated, A–Z folded (macOS/Windows
 * default filesystems ignore case; git's ignorecase folds ASCII only).
 */
import { foldAsciiCase, normalizeRepoPath } from './write-access'

/** Comparison key of a repo-relative path: NFC + A–Z folded. */
export function pathKey(p: string): string {
  return foldAsciiCase(p.normalize('NFC'))
}

/**
 * Whether `p` may be an exclusion at all: a non-empty relative folder path
 * without '.' / '..' segments, never inside `.git`, without control
 * characters (a newline would break the pattern file).
 */
export function isValidExclusion(p: string): boolean {
  const n = normalizeRepoPath(p)
  if (!n) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return false
  return !n.split('/').some(seg => foldAsciiCase(seg) === '.git')
}

/**
 * Clean an exclusion list: '/'-separated, no trailing slash, valid paths only,
 * duplicates (by pathKey) and entries inside another excluded folder dropped.
 * The spelling kept is the first one given (the repository's, from the tree).
 */
export function normalizeExclusions(list: readonly string[]): string[] {
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (typeof raw !== 'string' || !isValidExclusion(raw)) continue
    const p = raw.replace(/\\/g, '/').split('/').filter(Boolean).join('/')
    const key = pathKey(p)
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push(p)
  }
  const keys = cleaned.map(pathKey)
  return cleaned.filter((_, i) => !keys.some((k, j) => j !== i && keys[i].startsWith(`${k}/`)))
}

/**
 * The excluded folder that contains `repoPath` (or is it), or null when the
 * path is downloaded. `repoPath` is repository-relative ('' = the root).
 */
export function excludedFolderOf(exclusions: readonly string[], repoPath: string): string | null {
  const n = normalizeRepoPath(repoPath)
  if (n === null || n === '') return null
  const key = pathKey(n)
  let best: string | null = null
  for (const e of exclusions) {
    const ek = pathKey(e)
    if (key === ek || key.startsWith(`${ek}/`)) {
      if (best === null || e.length < best.length) best = e
    }
  }
  return best
}

/** Whether `repoPath` lies inside a folder that is not downloaded. */
export function isNotDownloaded(exclusions: readonly string[], repoPath: string): boolean {
  return excludedFolderOf(exclusions, repoPath) !== null
}

/** Excluded folders strictly inside `repoPath` ('' = the root), e.g. for a partially downloaded department. */
export function exclusionsInside(exclusions: readonly string[], repoPath: string): string[] {
  const n = normalizeRepoPath(repoPath)
  if (n === null) return []
  const key = n === '' ? '' : `${pathKey(n)}/`
  return exclusions.filter(e => pathKey(e).startsWith(key) && pathKey(e) !== pathKey(n))
}

// --- The sparse-checkout pattern file -------------------------------------

/** Escape a path for a gitignore-style pattern (wildcards and backslash). */
function escapePattern(p: string): string {
  return p.replace(/[\\*?[\]]/g, c => `\\${c}`)
}

function unescapePattern(p: string): string {
  return p.replace(/\\(.)/g, '$1')
}

/**
 * The non-cone sparse-checkout patterns for an exclusion list. Each folder is
 * written as spelled and, when they differ, also in NFC and NFD: git matches
 * the index bytes, and a Mac client may have committed a Japanese name in
 * NFD. An empty list still yields `/*` (everything).
 */
export function sparsePatterns(exclusions: readonly string[]): string[] {
  const lines = ['/*']
  const seen = new Set<string>()
  for (const e of normalizeExclusions(exclusions)) {
    for (const variant of [e, e.normalize('NFC'), e.normalize('NFD')]) {
      if (seen.has(variant)) continue
      seen.add(variant)
      lines.push(`!/${escapePattern(variant)}/`)
    }
  }
  return lines
}

/**
 * The exclusions a pattern file written by sparsePatterns describes, or null
 * when the file is anything else (cone mode, hand-written patterns).
 */
export function parseSparsePatterns(text: string): string[] | null {
  const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l !== '' && !l.startsWith('#'))
  if (lines[0] !== '/*') return null
  const out: string[] = []
  for (const line of lines.slice(1)) {
    const m = /^!\/(.+)\/$/.exec(line)
    if (!m) return null
    out.push(unescapePattern(m[1]))
  }
  return normalizeExclusions(out.map(p => p.normalize('NFC')))
}

// --- Messages ---------------------------------------------------------------

/** What the chat AI is told when it tries to write into a folder that is not downloaded. */
export function notDownloadedAgentMessage(folder: string): string {
  return `このフォルダ（${folder}）はダウンロードしていないため、ここには保存できません。必要ならユーザーに設定でダウンロードしてもらってください。`
}

/** What the member is told when an app action would write into a folder that is not downloaded. */
export function notDownloadedUserMessage(folder: string): string {
  return `このフォルダ（${folder}）はダウンロードしていないため、ここには保存できません。設定の「ダウンロードするフォルダ」でダウンロードしてから保存してください。`
}
