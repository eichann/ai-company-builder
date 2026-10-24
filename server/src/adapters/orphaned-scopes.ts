import type { OrphanedScopeReader } from '../ports/orphaned-scopes'
import { findOrphanedScopes } from '../lib/orphaned-scopes'

/** lib/orphaned-scopes.ts (the shared branch's tree against the scopes, cached per commit). */
export function gitOrphanedScopeReader(): OrphanedScopeReader {
  return {
    find: companyId => findOrphanedScopes(companyId),
  }
}
