/**
 * Write permission for a push: the policy snapshot and how it is evaluated.
 *
 * The checker runs as a child of `git receive-pack`, outside the API process,
 * and must also run where no API is (the client's sync harness pushes over
 * the local file transport). So it does not query the database: git-http —
 * the place that authenticated the pusher — writes a *snapshot* for the
 * request (the pusher and the company's scopes with their rules, read from
 * the same tables resolveAccess() reads) to a private temp file and passes
 * its path in ACB_PUSH_POLICY. The checker evaluates exactly that snapshot
 * with the same resolveAccess() the API uses.
 *
 * Which pushes are write-checked (decided in entry.ts from the environment;
 * see lib/git-server for who sets what):
 *   ACB_PUSH_POLICY set     a member's push through git-http → checked;
 *                           an unreadable/invalid snapshot rejects the push
 *                           ([HOOK_ERROR], retried by the next sync)
 *   ACB_INTERNAL_PUSH=1     the server's own pushes (department folders,
 *                           company creation) → not write-checked
 *   neither                 the local transport on the server host (tests,
 *                           an operator) → not write-checked, as before
 * git-http strips both variables from what it inherits before setting its
 * own, so a client can never select the unchecked modes.
 */
import {
  FULL_ACCESS_ROLES,
  applicableRules,
  findPrivateScope,
  isSameOrAncestorPath,
  resolveAccess,
  type PermissionRepository,
  type ScopeRule,
  type ScopeWithRules,
  type SubjectType,
} from '../permissions'
import { foldAsciiCase } from './rules'

export const PUSH_POLICY_VERSION = 1

export interface PushPolicy {
  version: typeof PUSH_POLICY_VERSION
  companyId: string
  /** The authenticated pusher; null when git-http could not resolve one. */
  pusher: { id: string; role: string | null } | null
  scopes: ScopeWithRules[]
  /**
   * Absent: the push goes to the company repository. Set: it goes to the
   * scope repository of the private folder at this company path (NFC), and
   * every pushed path is checked as `<scopePath>/<path>`.
   */
  scopePath?: string
  /**
   * Company paths (NFC) of the department folders the pusher manages: they
   * may change instruction files (CLAUDE.md, AGENTS.md ...) inside them.
   * Absent = none.
   */
  managedFolders?: string[]
}

export type WriteGate =
  /** Nothing to check (owner/admin, everyone may write everywhere, or an unchecked mode). */
  | { kind: 'allow-all' }
  /** Every changed path is denied (no pusher while some rule restricts writing). */
  | { kind: 'deny-all' }
  | { kind: 'check'; canWrite: (path: string) => boolean }

const SUBJECT_TYPES: ReadonlySet<string> = new Set<SubjectType>(['everyone', 'role', 'user'])

function invalid(what: string): never {
  throw new Error(`invalid push policy: ${what}`)
}

/** Parse and validate a snapshot. Throws on anything unexpected (the push is then rejected). */
export function parsePushPolicy(text: string): PushPolicy {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null) invalid('not an object')
  const d = data as Record<string, unknown>
  if (d.version !== PUSH_POLICY_VERSION) invalid('version')
  if (typeof d.companyId !== 'string') invalid('companyId')
  let pusher: PushPolicy['pusher'] = null
  if (d.pusher !== null) {
    const p = d.pusher as Record<string, unknown> | undefined
    if (typeof p !== 'object' || p === null || typeof p.id !== 'string') invalid('pusher')
    if (p.role !== null && typeof p.role !== 'string') invalid('pusher.role')
    pusher = { id: p.id as string, role: (p.role as string | null) }
  }
  if (!Array.isArray(d.scopes)) invalid('scopes')
  const scopes: ScopeWithRules[] = (d.scopes as unknown[]).map((s, i) => {
    const o = s as Record<string, unknown>
    if (typeof o !== 'object' || o === null || typeof o.id !== 'string' || typeof o.path !== 'string' || !Array.isArray(o.rules)) {
      invalid(`scopes[${i}]`)
    }
    const rules: ScopeRule[] = (o.rules as unknown[]).map((r, j) => {
      const x = r as Record<string, unknown>
      if (typeof x !== 'object' || x === null || typeof x.subjectType !== 'string' || !SUBJECT_TYPES.has(x.subjectType)
        || (x.subjectId !== null && typeof x.subjectId !== 'string')
        || typeof x.canRead !== 'boolean' || typeof x.canWrite !== 'boolean') {
        invalid(`scopes[${i}].rules[${j}]`)
      }
      return {
        id: typeof x.id === 'string' ? x.id : '',
        subjectType: x.subjectType as SubjectType,
        subjectId: x.subjectId as string | null,
        canRead: x.canRead as boolean,
        canWrite: x.canWrite as boolean,
      }
    })
    return {
      id: o.id as string,
      path: o.path as string,
      kind: (o.kind as ScopeWithRules['kind']) ?? 'folder',
      departmentId: typeof o.departmentId === 'string' ? o.departmentId : null,
      repoId: typeof o.repoId === 'string' ? o.repoId : null,
      rules,
    }
  })
  let scopePath: string | undefined
  if (d.scopePath !== undefined) {
    if (typeof d.scopePath !== 'string' || d.scopePath === '' || !scopes.some(s => s.path === d.scopePath && s.repoId !== null)) {
      invalid('scopePath')
    }
    scopePath = d.scopePath as string
  }
  let managedFolders: string[] | undefined
  if (d.managedFolders !== undefined) {
    if (!Array.isArray(d.managedFolders) || !d.managedFolders.every(f => typeof f === 'string' && f !== '')) invalid('managedFolders')
    managedFolders = d.managedFolders as string[]
  }
  return {
    version: PUSH_POLICY_VERSION,
    companyId: d.companyId as string,
    pusher,
    scopes,
    ...(scopePath !== undefined ? { scopePath } : {}),
    ...(managedFolders !== undefined ? { managedFolders } : {}),
  }
}

/**
 * May the pusher change the instruction file at `path` (as pushed, UTF-8;
 * relative to `scopePath` in a scope repository)? Only when it lies inside a
 * department folder they manage — any depth, NFC + A–Z folded. Root-level
 * ones never (owner/admin are decided before this is asked).
 */
export function instructionFileAllowed(path: string, managedFolders: string[], scopePath?: string): boolean {
  if (managedFolders.length === 0) return false
  const key = reservedKey(scopePath !== undefined ? `${scopePath}/${path}` : path)
  return managedFolders.some((f) => {
    const folder = reservedKey(f)
    return folder !== '' && key.startsWith(`${folder}/`)
  })
}

/**
 * When `path` (UTF-8, as pushed — a blob, symlink or gitlink, never a
 * folder: diff-tree -r lists no trees) is a strict ancestor of a reserved
 * private-folder path, the pusher's spelling of it; else null. A file or
 * symlink there would put the private folder's checkout on readers'
 * machines under — or through — something else.
 */
export function reservedAncestorOf(path: string, reserved: string[]): string | null {
  if (reserved.length === 0) return null
  const key = reservedKey(path)
  if (key === '') return null
  return reserved.some(r => r.startsWith(`${key}/`)) ? path : null
}

/** NFC with A–Z folded: how reserved paths are compared (as the rest of the checker folds case). */
export function reservedKey(path: string): string {
  return foldAsciiCase(path.normalize('NFC').split('/').filter(s => s.length > 0).join('/'))
}

/**
 * The reserved paths of a push to the COMPANY repository — every private
 * folder's path, as reservedKey()s. Nothing is reserved inside a scope
 * repository (private folders do not nest).
 */
export function reservedPathsFor(policy: PushPolicy): string[] {
  if (policy.scopePath !== undefined) return []
  return policy.scopes.filter(s => s.repoId !== null && s.path !== '').map(s => reservedKey(s.path))
}

/**
 * The reserved folder `path` (UTF-8, as pushed) is at or under — returned as
 * the pusher's own spelling of that prefix — or null.
 */
export function reservedPrefixOf(path: string, reserved: string[]): string | null {
  if (reserved.length === 0) return null
  const segments = path.split('/')
  const key = reservedKey(path).split('/')
  for (const r of reserved) {
    const rs = r.split('/')
    if (rs.length > key.length) continue
    if (rs.every((seg, i) => seg === key[i])) return segments.slice(0, rs.length).join('/')
  }
  return null
}

/**
 * True when the rules let every member write every path: the company scope
 * has rules, and in every scope that has rules, `everyone` may write and no
 * role/user rule there takes writing away. (The default seed — one company
 * scope with `everyone: read + write` — is the common case.)
 */
export function everyoneWritesEverywhere(scopes: ScopeWithRules[]): boolean {
  const root = scopes.find(s => s.path === '')
  if (!root || root.rules.length === 0) return false
  return scopes.every(s => s.rules.length === 0
    || (s.rules.some(r => r.subjectType === 'everyone' && r.canWrite) && s.rules.every(r => r.canWrite)))
}

/** True when this pusher may write every path (so no path needs to be listed). */
function pusherWritesEverywhere(scopes: ScopeWithRules[], userId: string, role: string): boolean {
  const root = scopes.find(s => s.path === '')
  if (!root || root.rules.length === 0) return false
  return scopes.every(s => s.rules.length === 0 || applicableRules(s.rules, userId, role).some(r => r.canWrite))
}

export function writeGateFor(policy: PushPolicy): WriteGate {
  const { pusher, companyId, scopePath } = policy
  // Company repository: private folders are not in it (their paths are
  // reserved — a separate rule), so their scopes take no part in its write
  // check. A scope repository: every scope counts, paths are prefixed.
  const scopes = scopePath === undefined
    ? policy.scopes.filter(s => !policy.scopes.some(p => p.repoId !== null && isSameOrAncestorPath(p.path, s.path)))
    : policy.scopes
  if (scopePath !== undefined) return scopeRepoGate(policy, scopePath)
  if (!pusher || pusher.role === null) {
    // git-http could not tell who is pushing: fail closed, unless writing is
    // open to everyone anyway (then this is today's behaviour).
    return everyoneWritesEverywhere(scopes) ? { kind: 'allow-all' } : { kind: 'deny-all' }
  }
  const role = pusher.role
  if (FULL_ACCESS_ROLES.has(role)) return { kind: 'allow-all' }
  if (pusherWritesEverywhere(scopes, pusher.id, role)) return { kind: 'allow-all' }

  const exact: PermissionRepository = { getMemberRole: () => role, listScopes: () => scopes }
  // macOS and Windows check out "Sales/x.md" into an existing "sales/"
  // folder, so a path must also be writable when compared without A–Z case
  // (the bytewise A–Z folding of the case-collision check).
  const foldedScopes = scopes.map(s => ({ ...s, path: foldAsciiCase(s.path) }))
  const folded: PermissionRepository = { getMemberRole: () => role, listScopes: () => foldedScopes }
  return {
    kind: 'check',
    canWrite: (path: string) =>
      resolveAccess(companyId, pusher.id, path, exact).write
      && resolveAccess(companyId, pusher.id, foldAsciiCase(path), folded).write,
  }
}

/** Write gate for a push to the scope repository of the private folder at `scopePath`. */
function scopeRepoGate(policy: PushPolicy, scopePath: string): WriteGate {
  const { pusher, scopes, companyId } = policy
  if (!pusher || pusher.role === null) return { kind: 'deny-all' }
  const role = pusher.role
  if (FULL_ACCESS_ROLES.has(role)) return { kind: 'allow-all' }
  if (!findPrivateScope(scopes, scopePath)) return { kind: 'deny-all' }
  const exact: PermissionRepository = { getMemberRole: () => role, listScopes: () => scopes }
  const foldedScopes = scopes.map(s => ({ ...s, path: foldAsciiCase(s.path) }))
  const folded: PermissionRepository = { getMemberRole: () => role, listScopes: () => foldedScopes }
  return {
    kind: 'check',
    canWrite: (path: string) => {
      const full = `${scopePath}/${path}`
      return resolveAccess(companyId, pusher.id, full, exact).write
        && resolveAccess(companyId, pusher.id, foldAsciiCase(full), folded).write
    },
  }
}
