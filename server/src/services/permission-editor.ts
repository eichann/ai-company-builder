/**
 * The permission editor (routes/permission-rules.ts): who may edit which
 * scope, what may be stored, the outdated-app guard, and the views the
 * editor shows. The rules are documented on the route module; this is where
 * they run. Storage: ScopeRepository (adapters/sqlite/permission-store.ts).
 */
import type { AccountDirectory, AccountSummary } from '../ports/accounts'
import type { ClientActivityRepository, OutdatedMember } from '../ports/client-activity'
import type { MembershipRepository } from '../ports/memberships'
import type { CompanyDataSource } from '../ports/company-data'
import type { PushRejectionRepository } from '../ports/push-rejections'
import type { RepoStore } from '../ports/repo-store'
import type { NewRule, ScopeRecord } from '../ports/scopes'
import type { Transactions } from '../ports/transactions'
import { supportsWriteDeniedRecovery } from '../lib/client-version'
import { membersLosingWrite } from '../lib/write-loss'
import {
  applicableRules,
  findGoverningScope,
  findPrivateScope,
  isSameOrAncestorPath,
  resolveAccess,
  type PermissionRepository,
  type ScopeRule,
  type SubjectType,
} from '../../shared/core/permissions'
import { isValidFolderName } from '../../shared/core/names'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const READ_RESTRICTION_UNAVAILABLE =
  'Restricting read access is not available yet: every rule lets its subject read. Set canWrite only (read restriction comes in a later update).'

export const PRIVATE_RULES_REQUIRED = 'A private folder always keeps its own rules (who can see it); change them instead'

export const PRIVATE_SUBJECT_ERROR =
  'On a private folder, everyone and roles can neither read nor edit; add members as viewers or editors instead'

export const OUTDATED_CLIENTS_ERROR =
  'Some members who would lose edit access use a desktop app that cannot recover from a write restriction; ask them to update the app first'

const FULL_ACCESS_SUBJECT =
  'Owners and admins can always read and edit everything; a rule for them would have no effect'

const ROLE_LABELS: Record<string, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー' }

/** Where a path is relative to private folders. */
export interface PrivatePlace {
  /** The private folder at or above the path. */
  scopeId: string
  scopePath: string
  /** The path IS the private folder (read restriction allowed there). */
  root: boolean
}

/**
 * canRead must be absent or true, except on a private folder itself
 * (`readRestrictable`), where it may be false; canWrite a boolean.
 */
export function parseAccess(body: Record<string, unknown>, readRestrictable = false): { canRead: boolean; canWrite: boolean } | { error: string } {
  if ((body.canRead === false || body.read === false) && !readRestrictable) return { error: READ_RESTRICTION_UNAVAILABLE }
  const read = body.canRead ?? body.read
  if (read !== undefined && typeof read !== 'boolean') return { error: 'canRead must be a boolean when given' }
  const write = body.canWrite ?? body.write
  if (typeof write !== 'boolean') return { error: 'canWrite must be a boolean' }
  return { canRead: read !== false, canWrite: write }
}

/**
 * A rule on a private folder ITSELF: `everyone` and role rules must deny
 * both read and write — only user rules (viewers / editors) grant access,
 * exactly what PUT /private-folders/:id/members stores. Without this a
 * department manager could open their department's private folder to the
 * whole company from the permission editor. A user who may edit must also
 * read. Rules deeper inside need no check: resolveAccess lets them grant
 * nothing to anyone who cannot read the private folder itself (narrow only).
 */
export function privateRootRuleError(place: PrivatePlace | null, rule: { subjectType: SubjectType; canRead: boolean; canWrite: boolean }): string | null {
  if (!place?.root) return null
  if (rule.subjectType !== 'user') return rule.canRead || rule.canWrite ? PRIVATE_SUBJECT_ERROR : null
  return rule.canWrite && !rule.canRead ? 'An editor of a private folder must also be able to read it' : null
}

class OutdatedClientsBlock extends Error {
  constructor(readonly members: OutdatedMember[]) {
    super('OUTDATED_CLIENTS')
  }
}

function latestOf(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null
  for (const v of values) if (v && (!best || v > best)) best = v
  return best
}

function subjectLabel(r: Pick<ScopeRule, 'subjectType' | 'subjectId'>, users: Map<string, AccountSummary>): string {
  if (r.subjectType === 'everyone') return '全員'
  if (r.subjectType === 'role') return ROLE_LABELS[r.subjectId ?? ''] ?? r.subjectId ?? ''
  const u = r.subjectId ? users.get(r.subjectId) : undefined
  return u?.name || u?.email || r.subjectId || ''
}

export interface PermissionEditorDeps {
  companyData: CompanyDataSource
  memberships: MembershipRepository
  clientActivity: ClientActivityRepository
  pushRejections: PushRejectionRepository
  accounts: AccountDirectory
  repoStore: RepoStore
  transactions: Transactions
  /** Folders (NFC) of the departments the user manages (permission-views.ts). */
  managedFolders(companyId: string, userId: string): string[]
}

export function createPermissionEditorService(deps: PermissionEditorDeps) {
  const { companyData, memberships, clientActivity, pushRejections, accounts, repoStore, transactions, managedFolders } = deps
  // Company handles (ports/company-data.ts): the company is always the member's / the one just checked.
  const scopesOf = (companyId: string) => companyData.forCompany(companyId).scopes
  const privateFoldersOf = (companyId: string) => companyData.forCompany(companyId).privateFolders

  /** May the actor edit rules of the scope at `path`? */
  function canEditPath(actor: Member, path: string): boolean {
    if (hasFullAccess(actor.role)) return true
    if (path === '') return false
    return managedFolders(actor.companyId, actor.userId).some(folder => isSameOrAncestorPath(folder, path))
  }

  function privatePlaceOf(companyId: string, path: string): PrivatePlace | null {
    if (path === '') return null
    const priv = findPrivateScope(scopesOf(companyId).listWithRules(), path)
    return priv ? { scopeId: priv.id, scopePath: priv.path, root: priv.path === path } : null
  }

  function serializeRules(rules: ScopeRule[]) {
    const users = accounts.byIds(rules.filter(r => r.subjectType === 'user' && r.subjectId).map(r => r.subjectId!))
    return rules.map(r => ({
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectLabel: subjectLabel(r, users),
      canRead: r.canRead,
      canWrite: r.canWrite,
    }))
  }

  return {
    canEditPath,
    privatePlaceOf,

    /** Owner/admin, or a manager of at least one department. */
    canEditAnything(actor: Member): boolean {
      return hasFullAccess(actor.role) || managedFolders(actor.companyId, actor.userId).length > 0
    },

    /** The subject of a rule; a user must be a member and not owner/admin. */
    parseSubject(actor: Member, body: Record<string, unknown>): { subjectType: SubjectType; subjectId: string | null } | { error: string } {
      const type = body.subjectType
      const id = body.subjectId ?? null
      if (type === 'everyone') {
        if (id !== null) return { error: 'subjectId must be empty for everyone' }
        return { subjectType: 'everyone', subjectId: null }
      }
      if (type === 'role') {
        if (id === 'owner' || id === 'admin') return { error: FULL_ACCESS_SUBJECT }
        if (id !== 'member') return { error: 'Unknown role' }
        return { subjectType: 'role', subjectId: 'member' }
      }
      if (type === 'user') {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200) return { error: 'subjectId must be a user ID' }
        const role = memberships.roleOf(actor.companyId, id)
        if (!role) return { error: 'Not a member of this company' }
        if (hasFullAccess(role)) return { error: FULL_ACCESS_SUBJECT }
        return { subjectType: 'user', subjectId: id }
      }
      return { error: 'subjectType must be everyone, role or user' }
    },

    /** Does the folder exist — in the company repository, or inside its private folder's repository? */
    async folderExists(companyId: string, path: string, place: PrivatePlace | null): Promise<boolean> {
      if (path === '') return true
      if (!place) return (await repoStore.resolveFolder(companyId, path)) !== null
      if (place.root) return true
      const folder = privateFoldersOf(companyId).get(place.scopeId)
      return !!folder && (await repoStore.listPrivateSubfolders(companyId, folder, path)) !== null
    },

    /** A move must not involve a private folder (or anything inside / around one). */
    touchesPrivate(companyId: string, path: string): boolean {
      return scopesOf(companyId).listWithRules().some(s => s.repoId !== null && (isSameOrAncestorPath(path, s.path) || isSameOrAncestorPath(s.path, path)))
    },

    /** Does the folder (or one inside it) already have rules? */
    hasRulesAtOrBelow(companyId: string, path: string): boolean {
      return scopesOf(companyId).listWithRules().some(s => isSameOrAncestorPath(path, s.path) && s.rules.length > 0)
    },

    getScope: (companyId: string, scopeId: string) => scopesOf(companyId).getById(scopeId),
    getScopeByPath: (companyId: string, path: string) => scopesOf(companyId).getByPath(path),
    getRule: (companyId: string, ruleId: string) => scopesOf(companyId).ruleWithScope(ruleId),
    rulesOf: (actor: Member, scopeId: string) => scopesOf(actor.companyId).rulesOf(scopeId),

    replaceRules: (actor: Member, path: string, rules: NewRule[]) => scopesOf(actor.companyId).replaceRules(path, rules, actor.userId),
    upsertRule: (actor: Member, path: string, rule: NewRule) => scopesOf(actor.companyId).upsertRule(path, rule, actor.userId),
    updateRuleAccess: (actor: Member, ruleId: string, canRead: boolean, canWrite: boolean) => scopesOf(actor.companyId).updateRuleAccess(ruleId, canRead, canWrite),
    deleteRule: (actor: Member, ruleId: string, scope: ScopeRecord) => scopesOf(actor.companyId).deleteRule(ruleId, scope),
    clearRules: (actor: Member, scope: ScopeRecord) => scopesOf(actor.companyId).clearRules(scope),
    moveRules: (actor: Member, fromPath: string, toPath: string) => scopesOf(actor.companyId).moveRules(fromPath, toPath, actor.userId),

    /** The scope and its rules as the editor shows them. */
    scopeView(companyId: string, scopeId: string) {
      const scope = scopesOf(companyId).getById(scopeId)
      const rules = scope ? scopesOf(companyId).rulesOf(scope.id) : []
      return {
        scope: scope ? { id: scope.id, path: scope.path, kind: scope.kind, inherited: rules.length === 0 } : null,
        rules: serializeRules(rules),
      }
    },

    /**
     * Run `mutate` in a transaction and keep it only when nobody who loses
     * write access under `roots` is on an app that cannot recover from
     * [WRITE_DENIED] (or `force`). Otherwise roll back and refuse with 409
     * OUTDATED_CLIENTS. Other errors propagate (after the rollback).
     */
    guardWrite<T>(actor: Member, force: boolean, roots: string[], mutate: () => T): Outcome<T> {
      const companyId = actor.companyId
      try {
        return ok(transactions.run(() => {
          const before = scopesOf(companyId).listWithRules()
          const result = mutate()
          if (force) return result
          const members = memberships.listByCompany(companyId).map(m => ({ userId: m.user_id, role: m.role }))
          const losing = membersLosingWrite(companyId, members, before, scopesOf(companyId).listWithRules(), roots)
          if (losing.length === 0) return result
          const activity = clientActivity.forCompany(companyId)
          const blocked = losing.filter(id => !supportsWriteDeniedRecovery(activity.get(id)?.client_version))
          if (blocked.length === 0) return result
          const users = accounts.byIds(blocked)
          const roleOf = new Map(members.map(m => [m.userId, m.role]))
          throw new OutdatedClientsBlock(blocked.map(id => {
            const a = activity.get(id)
            return {
              userId: id,
              name: users.get(id)?.name ?? null,
              email: users.get(id)?.email ?? null,
              role: roleOf.get(id) ?? 'member',
              clientVersion: a?.client_version ?? null,
              version: a?.client_version ?? '不明',
              lastSeenAt: latestOf(a?.last_seen_at, a?.last_fetch_at, a?.last_push_at),
            }
          }))
        }))
      } catch (err) {
        if (!(err instanceof OutdatedClientsBlock)) throw err
        return refuse('conflict', OUTDATED_CLIENTS_ERROR, {
          code: 'OUTDATED_CLIENTS',
          members: err.members,
          canForce: hasFullAccess(actor.role),
        })
      }
    },

    /** Every member's access at a path, and which rule decided. */
    effective(companyId: string, path: string) {
      const all = scopesOf(companyId).listWithRules()
      const governing = findGoverningScope(all, path)
      const repo: PermissionRepository = {
        getMemberRole: (cid, uid) => memberships.roleOf(cid, uid),
        listScopes: cid => scopesOf(cid).listWithRules(),
      }
      const rows = memberships.listByCompany(companyId)
      const users = accounts.byIds([
        ...new Set([...rows.map(m => m.user_id), ...(governing?.rules ?? []).filter(r => r.subjectType === 'user' && r.subjectId).map(r => r.subjectId!)]),
      ])

      const members = rows.map(m => {
        const access = resolveAccess(companyId, m.user_id, path, repo)
        const decided = access.source.reason === 'role' || !governing ? [] : applicableRules(governing.rules, m.user_id, m.role)
        const u = users.get(m.user_id)
        return {
          userId: m.user_id,
          name: u?.name ?? null,
          email: u?.email ?? null,
          role: m.role,
          read: access.read,
          write: access.write,
          reason: access.source.reason,
          decidedBy: decided.length === 0 ? null : {
            scopeId: governing!.id,
            path: governing!.path,
            subjectType: decided[0].subjectType,
            subjectLabel: subjectLabel(decided[0], users),
          },
        }
      })

      return {
        path,
        governingScope: governing ? { id: governing.id, path: governing.path, inherited: governing.path !== path } : null,
        // Read restriction is real only for private folders (their own repository).
        readRestrictionEnforced: privatePlaceOf(companyId, path) !== null,
        members,
      }
    },

    /**
     * Sub-folders of a path to pick from. Inside a private folder: its own
     * repository. Elsewhere: the company repository, plus the private folders
     * directly under the path — only those the actor may edit rules of, so a
     * manager never sees another department's private folder names. null
     * when the folder does not exist.
     */
    async folders(actor: Member, path: string) {
      const place = privatePlaceOf(actor.companyId, path)
      const privateFolder = place ? privateFoldersOf(actor.companyId).get(place.scopeId) : null
      let names = privateFolder
        ? await repoStore.listPrivateSubfolders(actor.companyId, privateFolder, path)
        : await repoStore.listSubfolders(actor.companyId, path)
      if (names === null) return null
      if (!place) {
        const depth = path === '' ? 1 : path.split('/').length + 1
        const privateChildren = privateFoldersOf(actor.companyId).paths()
          .filter(p => p.split('/').length === depth && isSameOrAncestorPath(path, p) && canEditPath(actor, p))
          .map(p => p.split('/').pop()!)
        names = [...new Set([...names, ...privateChildren])].sort((a, b) => a.localeCompare(b, 'ja'))
      }
      const scoped = new Map(scopesOf(actor.companyId).listWithRules().map(s => [s.path, s]))
      return {
        path,
        folders: names
          .filter(name => isValidFolderName(name) || path !== '')
          .map(name => {
            const childPath = path ? `${path}/${name}` : name
            const scope = scoped.get(childPath)
            return { name, path: childPath, scopeId: scope?.id ?? null, hasRules: (scope?.rules.length ?? 0) > 0, private: scope?.repoId != null }
          }),
      }
    },

    /** Rejected pushes, filtered and paged, with every marker for the filter. */
    rejections(companyId: string, q: { userId?: string; marker?: string; limit: number; offset: number }) {
      const { rows, total } = pushRejections.query(companyId, q)
      const markers = pushRejections.markers(companyId)
      const users = accounts.byIds([...new Set(rows.map(r => r.userId))])
      return {
        total,
        markers,
        rejections: rows.map(r => ({
          ...r,
          name: users.get(r.userId)?.name ?? null,
          email: users.get(r.userId)?.email ?? null,
        })),
      }
    },
  }
}

export type PermissionEditorService = ReturnType<typeof createPermissionEditorService>
