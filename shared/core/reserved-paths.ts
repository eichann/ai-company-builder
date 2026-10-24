/**
 * Reserved paths: a private folder's path in the COMPANY repository.
 *
 * A private folder lives in its own scope repository; in the company
 * repository its path is reserved for everyone (owner/admin included): a
 * push adding or changing anything at or under it, or a file / symlink /
 * gitlink at one of its ancestors, is refused with [RESERVED_PATH]
 * (server/src/lib/push-check). POST …/paths/check answers the same question
 * for a member ahead of time without naming anything (isPathUsable).
 *
 * Paths are compared as pathKey()s (NFC + A–Z folded, paths.ts).
 *
 * Pure: no Node, Electron, React, Hono, database or git.
 */
import { canReadPrivateScope, type ScopeWithRules } from './permissions'
import { isSameOrAncestorPath, pathKey } from './paths'

/**
 * The reserved folder `path` (UTF-8, as pushed or typed) is at or under —
 * returned as the caller's own spelling of that prefix — or null.
 * `reserved`: pathKey()s of the private folders.
 */
export function reservedPrefixOf(path: string, reserved: string[]): string | null {
  if (reserved.length === 0) return null
  const segments = path.split('/')
  const key = pathKey(path).split('/')
  for (const r of reserved) {
    const rs = r.split('/')
    if (rs.length > key.length) continue
    if (rs.every((seg, i) => seg === key[i])) return segments.slice(0, rs.length).join('/')
  }
  return null
}

/**
 * When `path` (a file, symlink or gitlink — never a folder) is a strict
 * ancestor of a reserved private-folder path, the caller's spelling of it;
 * else null. A file there would put the private folder's checkout on
 * readers' machines under — or through — something else.
 */
export function reservedAncestorOf(path: string, reserved: string[]): string | null {
  if (reserved.length === 0) return null
  const key = pathKey(path)
  if (key === '') return null
  return reserved.some(r => r.startsWith(`${key}/`)) ? path : null
}

/**
 * May this member put something at `path` (POST /paths/check)? false when
 * the path is at or under a private folder they cannot read — what a push
 * of theirs there would be refused with ([RESERVED_PATH]). A reader's paths
 * inside a private folder are usable (they go to its own repository).
 *
 * `asFile`: the path will be a file (or symlink), not a folder. It is then
 * also unusable when it is a strict ancestor of ANY private folder, readable
 * or not — the push check refuses a file there for everyone
 * (reservedAncestorOf). As a folder such a path is fine.
 *
 * Every private folder is compared, whatever the outcome, so the answer
 * takes the same work for every path.
 */
export function isPathUsable(
  scopes: ScopeWithRules[],
  userId: string,
  role: string,
  path: string,
  options: { asFile?: boolean } = {},
): boolean {
  const key = pathKey(path)
  let usable = true
  for (const s of scopes) {
    if (s.repoId === null) continue
    const folder = pathKey(s.path)
    const inside = isSameOrAncestorPath(folder, key)
    const readable = canReadPrivateScope(s, userId, role)
    if (inside && !readable) usable = false
    if (options.asFile === true && key !== '' && folder.startsWith(`${key}/`)) usable = false
  }
  return usable
}
