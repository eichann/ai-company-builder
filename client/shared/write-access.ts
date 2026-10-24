/**
 * Where the signed-in member may write in a company, and how to evaluate it
 * for one path — the same answer the server's push check gives (so the AI is
 * stopped BEFORE it edits a folder whose changes the push would reject with
 * [WRITE_DENIED] and sync would move to .backups/).
 *
 * Data: GET /api/companies/:companyId/me/write-access. The evaluation is the
 * server's own copy (shared/core/write-access.ts: evaluateWrite, built on the
 * permission model in shared/core/permissions.ts); this module adds what only
 * the app needs — turning an absolute path into a company-relative one, and
 * the message the AI sees.
 *
 * Pure (no Node, no Electron): used by the main process (chat guard) and the
 * renderer (閲覧のみ badges).
 */
import { foldAsciiCase } from '../../shared/core/paths'

export { foldAsciiCase, normalizeRepoPath } from '../../shared/core/paths'
export {
  evaluateWrite,
  isWriteAccess,
  type WriteAccess,
  type WriteAccessScope,
  type WriteDecision,
} from '../../shared/core/write-access'

/**
 * Lexically resolve `target` (absolute, or relative to `cwd`) and express it
 * relative to `root`. No filesystem access, so no symlink resolution: a path
 * is judged by how it is spelled, which is also how the edit reaches git.
 * Returns null when it is outside the root. Accepts '/' and '\\' and Windows
 * drive letters; the root prefix is compared after NFC and, failing that,
 * with A–Z folded (macOS/Windows default filesystems ignore case).
 */
export function repoRelativePath(root: string, target: string, cwd?: string): string | null {
  const isAbs = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
  const joined = isAbs(target) ? target : `${cwd && isAbs(cwd) ? cwd : root}/${target}`
  const resolve = (p: string): string[] | null => {
    const out: string[] = []
    for (const seg of p.normalize('NFC').replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        if (out.length === 0) return null
        out.pop()
      } else out.push(seg)
    }
    return out
  }
  const r = resolve(root)
  const t = resolve(joined)
  if (!r || !t || t.length < r.length) return null
  const same = (a: string, b: string) => a === b || foldAsciiCase(a) === foldAsciiCase(b)
  for (let i = 0; i < r.length; i++) if (!same(r[i], t[i])) return null
  return t.slice(r.length).join('/')
}

/** The message the AI sees when an edit is refused (it should tell the member, not retry). */
export function readOnlyMessage(folder: string): string {
  const label = folder === '' ? '会社フォルダのトップ' : folder
  return `このフォルダ（${label}）は閲覧のみのため、編集できません。編集が必要な場合はフォルダの管理者に依頼してください。別の場所に保存する場合は、ユーザーに確認してください。`
}
