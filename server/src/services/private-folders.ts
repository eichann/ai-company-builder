/**
 * Private folders (routes/private-folders.ts documents the API and the
 * rules): who may create / manage them, viewers and editors, the version
 * gate for the company's first one, and the views for the admin panel and
 * the desktop app. Storage, scope repositories and the race protections:
 * PrivateFolderRepository (lib/private-folders.ts).
 *
 * Names never reach members who may not read a folder: anything that is not
 * theirs to see answers exactly as if nothing were there.
 */
import type { AccountDirectory } from '../ports/accounts'
import type { ClientActivityRepository, OutdatedMember } from '../ports/client-activity'
import type { DepartmentRepository } from '../ports/departments'
import type { MembershipRepository } from '../ports/memberships'
import type { PrivateFolderRecord, PrivateFolderRepository, PrivateRuleSet } from '../ports/private-folders'
import type { RepoStore } from '../ports/repo-store'
import type { ScopeRepository } from '../ports/scopes'
import type { CompanyLock } from '../ports/transactions'
import { supportsPrivateFolders } from '../lib/client-version'
import {
  canReadPrivateScope,
  canWriteInPrivateFolder,
  findPrivateScope,
  FULL_ACCESS_ROLES,
  isSameOrAncestorPath,
  type ScopeWithRules,
} from '../../shared/core/permissions'
import { isPathUsable } from '../../shared/core/reserved-paths'
import {
  MY_PRIVATE_FOLDER_VIEWERS_LIMIT,
  normalizeReservedPath,
  reservedPathMessage,
  type MyPrivateFolder,
  type PrivateFolderDetail,
  type PrivateFolderSummary,
} from '../../shared/types/private-folders'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

const MAX_MEMBERS = 500

export const PRIVATE_FOLDERS_OUTDATED_ERROR =
  'Some members use a desktop app that cannot handle private folders yet; ask them to update the app first'

interface DepartmentFolder { id: string; folder: string }

export interface PrivateFolderServiceDeps {
  privateFolders: PrivateFolderRepository
  scopes: ScopeRepository
  departments: DepartmentRepository
  memberships: MembershipRepository
  clientActivity: ClientActivityRepository
  accounts: AccountDirectory
  repoStore: RepoStore
  companyLock: CompanyLock
}

export function createPrivateFolderService(deps: PrivateFolderServiceDeps) {
  const { privateFolders, scopes, departments, memberships, clientActivity, accounts, repoStore, companyLock } = deps

  function departmentFolders(companyId: string): DepartmentFolder[] {
    return departments.folders(companyId).map(d => ({ id: d.id, folder: d.folder.normalize('NFC') }))
  }

  /** The department whose folder contains `path` (deepest), or null. */
  function departmentOf(companyId: string, path: string): DepartmentFolder | null {
    let best: DepartmentFolder | null = null
    for (const d of departmentFolders(companyId)) {
      if (isSameOrAncestorPath(d.folder, path) && (!best || d.folder.length > best.folder.length)) best = d
    }
    return best
  }

  /** Owner/admin anywhere; a manager inside (not at) the folder of a department they manage. */
  function canManagePath(actor: Member, path: string): boolean {
    if (FULL_ACCESS_ROLES.has(actor.role)) return true
    const managed = new Set(scopes.managedDepartmentIds(actor.companyId, actor.userId))
    return departmentFolders(actor.companyId).some(d => managed.has(d.id) && isSameOrAncestorPath(d.folder, path) && d.folder !== path)
  }

  function summarize(companyId: string, p: PrivateFolderRecord, all: ScopeWithRules[], users: Map<string, { name: string | null; email: string }>): PrivateFolderSummary {
    const access = privateFolders.access(companyId, p.scope.path, all)
    return {
      scopeId: p.scope.id,
      path: p.scope.path,
      departmentId: departmentOf(companyId, p.scope.path)?.id ?? null,
      viewerCount: access.filter(a => a.read).length,
      editorCount: access.filter(a => a.write).length,
      createdAt: p.createdAt,
      createdBy: p.createdBy,
      createdByName: p.createdBy ? (users.get(p.createdBy)?.name ?? users.get(p.createdBy)?.email ?? null) : null,
    }
  }

  function detail(companyId: string, p: PrivateFolderRecord): PrivateFolderDetail {
    const all = scopes.listWithRules(companyId)
    const access = privateFolders.access(companyId, p.scope.path, all).filter(a => a.read)
    const users = accounts.byIds([...new Set([...access.map(a => a.userId), ...(p.createdBy ? [p.createdBy] : [])])])
    return {
      ...summarize(companyId, p, all, users),
      members: access.map(a => ({
        userId: a.userId,
        name: users.get(a.userId)?.name ?? null,
        email: users.get(a.userId)?.email ?? null,
        role: a.role,
        canWrite: a.write,
        via: FULL_ACCESS_ROLES.has(a.role) ? 'role' as const : 'rule' as const,
      })),
    }
  }

  /** Members whose app cannot handle private folders (for the first one). */
  function notReadyMembers(companyId: string): OutdatedMember[] {
    const rows = memberships.listByCompany(companyId)
    const activity = clientActivity.forCompany(companyId)
    const blocked = rows.filter(m => !supportsPrivateFolders(activity.get(m.user_id)?.client_version))
    const users = accounts.byIds(blocked.map(m => m.user_id))
    return blocked.map(m => {
      const a = activity.get(m.user_id)
      const seen = [a?.last_seen_at, a?.last_fetch_at, a?.last_push_at].filter((v): v is string => !!v).sort().pop() ?? null
      return {
        userId: m.user_id,
        name: users.get(m.user_id)?.name ?? null,
        email: users.get(m.user_id)?.email ?? null,
        role: m.role,
        clientVersion: a?.client_version ?? null,
        version: a?.client_version ?? '不明',
        lastSeenAt: seen,
      }
    })
  }

  const notFound = () => refuse('not-found', 'Not found')

  function refusalOf(r: { reason: string; message?: string }): Refusal {
    return refuse(r.reason === 'BUSY' ? 'unavailable' : 'conflict', r.message ?? '', { code: r.reason })
  }

  return {
    canManagePath,

    managesAnyDepartment(actor: Member): boolean {
      return scopes.managedDepartmentIds(actor.companyId, actor.userId).length > 0
    },

    /**
     * viewers / editors from a request. Owners/admins are dropped (they
     * always read and write); `always` (the creator) is added to both.
     * Returns an error message for non-members, an editor who is not a
     * viewer, bad types.
     */
    parseMembers(companyId: string, rawViewers: unknown, rawEditors: unknown, always: string[]): PrivateRuleSet | { error: string } {
      if (!Array.isArray(rawViewers) || rawViewers.length > MAX_MEMBERS || !rawViewers.every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) {
        return { error: 'viewers must be an array of user IDs' }
      }
      if (rawEditors !== undefined && (!Array.isArray(rawEditors) || rawEditors.length > MAX_MEMBERS || !rawEditors.every(v => typeof v === 'string'))) {
        return { error: 'editors must be an array of user IDs' }
      }
      const roles = new Map(memberships.listByCompany(companyId).map(m => [m.user_id, m.role]))
      const viewers = new Set<string>()
      for (const id of [...(rawViewers as string[]), ...always]) {
        const role = roles.get(id)
        if (!role) return { error: 'Not a member of this company' }
        if (!FULL_ACCESS_ROLES.has(role)) viewers.add(id)
      }
      const editors = new Set<string>()
      for (const id of rawEditors === undefined ? [...viewers] : [...(rawEditors as string[]), ...always]) {
        const role = roles.get(id)
        if (!role) return { error: 'Not a member of this company' }
        if (FULL_ACCESS_ROLES.has(role)) continue
        if (!viewers.has(id)) return { error: 'Every editor must also be a viewer' }
        editors.add(id)
      }
      return { viewers: [...viewers], editors: [...editors] }
    },

    /**
     * The parent of a new private folder: inside a private folder → already
     * private (or, for someone who cannot read it, simply not there);
     * otherwise it must exist in the company repository.
     */
    async checkParent(actor: Member, parentPath: string): Promise<Outcome<void>> {
      if (parentPath === '') return ok(undefined)
      const all = scopes.listWithRules(actor.companyId)
      const priv = findPrivateScope(all, parentPath)
      if (priv) {
        const readable = hasFullAccess(actor.role) || privateFolders.access(actor.companyId, priv.path, all).some(a => a.userId === actor.userId && a.read)
        return readable
          ? refuse('bad-request', 'Folders inside a private folder are private already; create an ordinary folder there', { code: 'ALREADY_PRIVATE' })
          : refuse('bad-request', 'Parent folder not found', { code: 'PARENT_NOT_FOUND' })
      }
      if ((await repoStore.resolveFolder(actor.companyId, parentPath)) === null) {
        return refuse('bad-request', 'Parent folder not found', { code: 'PARENT_NOT_FOUND' })
      }
      return ok(undefined)
    },

    /** Default viewers of a new folder: the managers of the department it is in. */
    defaultViewers(companyId: string, path: string): string[] {
      const dept = departmentOf(companyId, path)
      return dept ? scopes.departmentManagerIds(dept.id) : []
    },

    /**
     * Create it under the company lock. The company's first private folder
     * is refused while any member's app cannot handle private folders, unless
     * `force`. Other errors propagate (the route answers 500).
     */
    async create(actor: Member, path: string, rules: PrivateRuleSet, force: boolean): Promise<Outcome<PrivateFolderDetail>> {
      const created = await companyLock.run(actor.companyId, async () => {
        if (privateFolders.list(actor.companyId).length === 0 && !force) {
          const blocked = notReadyMembers(actor.companyId)
          if (blocked.length > 0) return { blocked }
        }
        return privateFolders.create({ companyId: actor.companyId, path, rules, createdBy: actor.userId })
      })
      if ('blocked' in created) {
        return refuse('conflict', PRIVATE_FOLDERS_OUTDATED_ERROR, { code: 'OUTDATED_CLIENTS', members: created.blocked, canForce: hasFullAccess(actor.role) })
      }
      if (!created.ok) {
        return created.reason === 'unavailable'
          ? refuse('conflict', reservedPathMessage(path), { code: 'FOLDER_NAME_UNAVAILABLE' })
          : refusalOf(created)
      }
      return ok(detail(actor.companyId, privateFolders.get(actor.companyId, created.scopeId)!))
    },

    /** The private folder if the actor may manage it; otherwise a 404 that reveals nothing. */
    managed(actor: Member, scopeId: string): Outcome<PrivateFolderRecord> {
      const folder = privateFolders.get(actor.companyId, scopeId)
      return folder && canManagePath(actor, folder.scope.path) ? ok(folder) : notFound()
    },

    /** Any private folder of the company (owner/admin endpoints). */
    find(actor: Member, scopeId: string): Outcome<PrivateFolderRecord> {
      const folder = privateFolders.get(actor.companyId, scopeId)
      return folder ? ok(folder) : notFound()
    },

    detail: (actor: Member, folder: PrivateFolderRecord) => detail(actor.companyId, folder),

    /** The ones the actor may manage, with viewer counts. */
    list(actor: Member): PrivateFolderSummary[] {
      const all = scopes.listWithRules(actor.companyId)
      const folders = privateFolders.list(actor.companyId, all).filter(p => canManagePath(actor, p.scope.path))
      const users = accounts.byIds([...new Set(folders.map(f => f.createdBy).filter((v): v is string => !!v))])
      return folders.map(f => summarize(actor.companyId, f, all, users))
    },

    replaceMembers(actor: Member, folder: PrivateFolderRecord, rules: PrivateRuleSet): PrivateFolderDetail {
      privateFolders.replaceRules(folder.scope.id, rules, actor.userId)
      return detail(actor.companyId, privateFolders.get(actor.companyId, folder.scope.id)!)
    },

    /** 公開に戻す, under the company lock (re-read there: it may be gone). */
    async makePublic(actor: Member, folder: PrivateFolderRecord): Promise<Outcome<{ path: string; commit: string }>> {
      const result = await companyLock.run(actor.companyId, async () => {
        const current = privateFolders.get(actor.companyId, folder.scope.id)
        if (!current) return null
        return privateFolders.makePublic(actor.companyId, current, actor.userId)
      })
      if (!result) return notFound()
      return result.ok ? ok(result.value) : refusalOf(result)
    },

    /** Delete (archived first), under the company lock (re-read there: it may be gone). */
    async delete(actor: Member, folder: PrivateFolderRecord): Promise<Outcome<{ path: string }>> {
      const result = await companyLock.run(actor.companyId, async () => {
        const current = privateFolders.get(actor.companyId, folder.scope.id)
        if (!current) return null
        return privateFolders.delete(actor.companyId, current, actor.userId)
      })
      if (!result) return notFound()
      return result.ok ? ok(result.value) : refusalOf(result)
    },

    /** The private folders the member may read, with who else can (named viewers first). */
    mine(actor: Member): MyPrivateFolder[] {
      const all = scopes.listWithRules(actor.companyId)
      const readable = privateFolders.list(actor.companyId, all).filter(p => canReadPrivateScope(p.scope, actor.userId, actor.role))
      const access = new Map(readable.map(p => [p.scope.id, privateFolders.access(actor.companyId, p.scope.path, all).filter(a => a.read)]))
      const users = accounts.byIds([...new Set([...access.values()].flat().map(a => a.userId))])
      return readable.map(p => {
        const readers = access.get(p.scope.id) ?? []
        // Named viewers first: owners/admins read everything and say little here.
        const ordered = [...readers.filter(a => !FULL_ACCESS_ROLES.has(a.role)), ...readers.filter(a => FULL_ACCESS_ROLES.has(a.role))]
        return {
          scopeId: p.scope.id,
          path: p.scope.path,
          canWrite: canWriteInPrivateFolder(all, p.scope, actor.companyId, actor.userId, actor.role),
          viewerCount: readers.length,
          viewers: ordered.slice(0, MY_PRIVATE_FOLDER_VIEWERS_LIMIT).map(a => ({
            userId: a.userId,
            name: users.get(a.userId)?.name ?? users.get(a.userId)?.email ?? null,
            role: a.role,
          })),
        }
      })
    },

    /**
     * The private folders the member may read, with their clone URLs —
     * nothing about the others (not even a salted hash of the path).
     */
    myScopes(actor: Member, baseUrl: string) {
      const all = scopes.listWithRules(actor.companyId)
      return privateFolders.list(actor.companyId, all)
        .filter(p => canReadPrivateScope(p.scope, actor.userId, actor.role))
        .map(p => {
          const clonePath = `/api/git-http/${actor.companyId}/scopes/${p.scope.id}.git`
          return {
            scopeId: p.scope.id,
            path: p.scope.path,
            cloneUrl: `${baseUrl}${clonePath}`,
            clonePath,
            canWrite: canWriteInPrivateFolder(all, p.scope, actor.companyId, actor.userId, actor.role),
          }
        })
    },

    /** May the member put something at each path (shared/core isPathUsable)? */
    pathsUsable(actor: Member, paths: string[], files: Set<string>) {
      const all = scopes.listWithRules(actor.companyId)
      return paths.map(path => ({
        path,
        usable: isPathUsable(all, actor.userId, actor.role, normalizeReservedPath(path), { asFile: files.has(path) }),
      }))
    },
  }
}

export type PrivateFolderService = ReturnType<typeof createPrivateFolderService>
