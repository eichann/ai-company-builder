/**
 * Who may read which record of the company map (`.claude/rules/records.md`
 * "No leaks"): exactly who may read its file — or, for a record that lives
 * on the server only, its folder (none = everyone in the company). A record
 * in a private folder the member cannot read is a record that does not exist:
 * left out of answers, counts, link lists and traversals alike.
 *
 * Links: a record outside a private folder never shows or reaches a record
 * inside one (a public → private link is ignored for everyone, 4-1); inside
 * the same private folder they work as usual.
 */
import {
  canReadPrivateScope, findPrivateScope, resolveAccess, type PermissionRepository, type ScopeWithRules,
} from '../../shared/core/permissions'
import type { RecordAccessRow } from '../ports/records'
import type { Member } from './access'

export interface RecordReader {
  record(row: RecordAccessRow): boolean
  /** A file of the company folder (a file link's target). */
  file(path: string): boolean
}

export function recordReader(member: Member, scopes: ScopeWithRules[]): RecordReader {
  const perms: PermissionRepository = { getMemberRole: () => member.role, listScopes: () => scopes }
  const byId = new Map(scopes.map(s => [s.id, s]))
  const readable = (path: string) => resolveAccess(member.companyId, member.userId, path, perms).read
  const file = (path: string) => {
    const priv = findPrivateScope(scopes, path)
    if (priv && !canReadPrivateScope(priv, member.userId, member.role)) return false
    return readable(path)
  }
  return {
    record(r) {
      if (r.path === null) return r.scopeId === null && readable(r.folder ?? '')
      if (r.scopeId !== null) {
        const scope = byId.get(r.scopeId)
        // The folder is gone or no longer private: unreadable until the index catches up.
        if (!scope || scope.repoId === null) return false
        return canReadPrivateScope(scope, member.userId, member.role) && readable(r.path)
      }
      // A company-repository record is never inside a private folder (the path is reserved there).
      if (findPrivateScope(scopes, r.path)) return false
      return readable(r.path)
    },
    file,
  }
}

/** May a link from `source` to `target` be shown or followed at all (for anyone)? */
export function linkAllowed(source: { scopeId: string | null }, target: { scopeId: string | null }): boolean {
  return target.scopeId === null || target.scopeId === source.scopeId
}
