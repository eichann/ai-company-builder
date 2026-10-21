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
  return { version: PUSH_POLICY_VERSION, companyId: d.companyId as string, pusher, scopes }
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
  const { pusher, scopes, companyId } = policy
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
