/**
 * Business roles (役割, plan C3, `.claude/rules/plugin-roles.md`).
 *
 * A contract-2 business plugin declares the roles its work needs; the company
 * assigns members to each (the FDE's admin screen, owner / admin); a
 * まとまり (a record whose type implements `bundle`) may override a role for
 * its own work (owner / admin, or a manager of the まとまり's department).
 * Every change is kept in the append-only history.
 *
 * This service is the server's ONE resolution of role holders (`RoleHolders`),
 * handed to the engine's `who` (`role:<name>`, record-engine/act.ts), the
 * approvers (`approver_rule: role`, services/approvals.ts) — bound once in
 * composition/plugins.ts. Absence needs nothing of its own here: the engine
 * and approvals already ask "does the absentee hold it?" for whom a delegate
 * covers (`actsFor`), so a delegate stands in for a role holder too.
 *
 * Resolution fails closed: a role of a plugin whose installed version is not
 * on the shelf, a type no installed business plugin owns, a role never
 * assigned, a member who left — none of them holds anything.
 */
import { holdersOf, parseRoleHolders, ROLE_NAME_RE } from '../../shared/core/plugin-roles'
import type { PluginManifest } from '../../shared/core/plugins'
import type { PluginRolesView } from '../../shared/types/plugins'
import type { CompanyDataSource } from '../ports/company-data'
import type { Clock } from '../ports/clock'
import { isSameOrAncestorPath } from '../../shared/core/paths'
import { RECORD_ID_RE } from '../../shared/core/records'
import { requireFullAccess, hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { PluginShelf } from './plugin-shelf'
import { PLUGIN_NOT_FOUND, PLUGINS_FORBIDDEN } from './plugin-service-common'
import { recordReader } from './record-access'
import { currentTypes } from './record-index'

export const ROLE_NOT_FOUND = { error: 'この役割はありません', code: 'ROLE_NOT_FOUND' } as const
export const ROLE_HOLDERS_INVALID = 'この会社のメンバーを20人まで選んでください'
const HISTORY_SHOWN = 50

/** Who holds a business role, for the engine and the approvers. */
export interface RoleHolders {
  /** The members holding `role` of `pluginId` for this まとまり (null: the company's assignment). */
  holders(companyId: string, pluginId: string, role: string, bundleId: string | null): string[]
  /** For a type's `role:<name>`: does `userId` hold it on this record (its plugin = the type's owner, its まとまり)? */
  holdsOnRecord(companyId: string, type: string, recordId: string, role: string, userId: string): boolean
  /** The role's label as the installed plugin declares it, or null. */
  label(companyId: string, pluginId: string, role: string): string | null
}

export interface PluginRoleDeps {
  companyData: CompanyDataSource
  clock: Clock
  shelf: PluginShelf
  isMember: (companyId: string, userId: string) => boolean
  /** Department folders the member manages (a まとまり's override). */
  managedFolders: (companyId: string, userId: string) => string[]
}

export function createPluginRoleService(deps: PluginRoleDeps) {
  const { companyData, shelf } = deps

  /** The installed business plugin's declaration (any switch position), or null. */
  function installed(companyId: string, pluginId: string): PluginManifest | null {
    if (typeof pluginId !== 'string' || pluginId.length > 40) return null
    const install = companyData.forCompany(companyId).plugins.install(pluginId)
    const m = install ? shelf.find(companyId, pluginId, install.version)?.pkg.manifest : undefined
    return m && m.role === 'business' ? m : null
  }

  /** The installed business plugin owning a type (one owner per type name in a company), or null. */
  function ownerOfType(companyId: string, type: string): string | null {
    for (const i of companyData.forCompany(companyId).plugins.installs()) {
      const m = installed(companyId, i.pluginId)
      if (m?.types.includes(type)) return i.pluginId
    }
    return null
  }

  /** The まとまり of a record: itself when its type implements `bundle`, else its `bundle` link's target. */
  function bundleOf(companyId: string, recordId: string): string | null {
    const records = companyData.forCompany(companyId).records
    const row = records.byIds([recordId])[0]
    if (!row) return null
    if (currentTypes(records).get(row.type)?.definition.implements.includes('bundle')) return row.id
    return records.linksFrom([row.id]).find(l => l.name === 'bundle' && l.targetId !== null)?.targetId ?? null
  }

  const holders: RoleHolders['holders'] = (companyId, pluginId, role, bundleId) => {
    const m = installed(companyId, pluginId)
    if (!m || !Object.prototype.hasOwnProperty.call(m.roles, role)) return []
    const repo = companyData.forCompany(companyId).pluginRoles
    const override = bundleId !== null ? repo.override(pluginId, role, bundleId) : null
    return holdersOf(repo.assignment(pluginId, role), override).filter(u => deps.isMember(companyId, u))
  }

  const resolver: RoleHolders = {
    holders,
    holdsOnRecord(companyId, type, recordId, role, userId) {
      const pluginId = ownerOfType(companyId, type)
      return pluginId !== null && holders(companyId, pluginId, role, bundleOf(companyId, recordId)).includes(userId)
    },
    label(companyId, pluginId, role) {
      const m = installed(companyId, pluginId)
      return m && Object.prototype.hasOwnProperty.call(m.roles, role) ? m.roles[role].label : null
    },
  }

  const notFound = () => refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
  const roleNotFound = () => refuse('not-found', ROLE_NOT_FOUND.error, { code: ROLE_NOT_FOUND.code })
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

  function view(member: Member, pluginId: string, m: PluginManifest): PluginRolesView {
    const handle = companyData.forCompany(member.companyId)
    const repo = handle.pluginRoles
    const assigned = repo.assignments(pluginId)
    const reader = recordReader(member, handle.scopes.listWithRules())
    const overrides = repo.overrides(pluginId)
    const rows = new Map(handle.records.byIds([...new Set(overrides.map(o => o.bundleId))]).map(r => [r.id, r]))
    return {
      pluginId,
      label: m.label,
      roles: Object.entries(m.roles).map(([name, r]) => ({ name, label: r.label, description: r.description, userIds: assigned[name] ?? [] })),
      overrides: overrides.map(o => {
        const row = rows.get(o.bundleId)
        return { role: o.role, bundleId: o.bundleId, title: row && row.removedAt === null && reader.record(row) ? row.title : null, userIds: o.userIds }
      }),
      history: repo.history(pluginId, HISTORY_SHOWN).map(h => ({ role: h.role, bundleId: h.bundleId, action: h.action, userIds: h.userIds, at: h.at, by: h.by })),
    }
  }

  /** Member ids of this company, else null. */
  function holdersFrom(companyId: string, body: unknown, allowNull: boolean): string[] | null | undefined {
    if (!isObject(body)) return undefined
    if (allowNull && body.userIds === null) return null
    const ids = parseRoleHolders(body.userIds)
    if (!ids || ids.some(u => !deps.isMember(companyId, u))) return undefined
    return ids
  }

  return {
    ...resolver,
    resolver,

    /** GET /plugins/:pluginId/roles — owner / admin. */
    roles(member: Member, pluginId: string): Outcome<PluginRolesView> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const m = installed(member.companyId, pluginId)
      if (!m) return notFound()
      return ok(view(member, pluginId, m))
    },

    /** PUT /plugins/:pluginId/roles/:role { userIds } — the company's assignment (owner / admin; empty = nobody). */
    assign(member: Member, pluginId: string, role: string, body: unknown): Outcome<PluginRolesView> {
      const allowed = requireFullAccess(member, PLUGINS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const m = installed(member.companyId, pluginId)
      if (!m) return notFound()
      if (!ROLE_NAME_RE.test(role) || !Object.prototype.hasOwnProperty.call(m.roles, role)) return roleNotFound()
      const ids = holdersFrom(member.companyId, body, false)
      if (!ids) return refuse('bad-request', ROLE_HOLDERS_INVALID, { code: 'ROLE_HOLDERS_INVALID' })
      companyData.forCompany(member.companyId).pluginRoles.assign(pluginId, role, ids, deps.clock.now(), member.userId)
      return ok(view(member, pluginId, m))
    },

    /**
     * PUT /plugins/:pluginId/roles/:role/bundles/:recordId { userIds | null } —
     * a まとまり's own holders (null: back to the company's). Owner / admin, or
     * a manager of the まとまり's department; the まとまり must be readable and
     * of a type this plugin owns.
     */
    setBundleOverride(member: Member, pluginId: string, role: string, recordId: string, body: unknown): Outcome<PluginRolesView> {
      const m = installed(member.companyId, pluginId)
      if (!m) return notFound()
      if (!ROLE_NAME_RE.test(role) || !Object.prototype.hasOwnProperty.call(m.roles, role)) return roleNotFound()
      const handle = companyData.forCompany(member.companyId)
      const row = RECORD_ID_RE.test(recordId) ? handle.records.byIds([recordId])[0] : undefined
      const readable = !!row && row.removedAt === null && recordReader(member, handle.scopes.listWithRules()).record(row)
      const isBundle = readable && m.types.includes(row.type) && currentTypes(handle.records).get(row.type)?.definition.implements.includes('bundle') === true
      if (!row || !isBundle) return refuse('not-found', 'このまとまりはありません', { code: 'BUNDLE_NOT_FOUND' })
      const manages = row.folder !== null && deps.managedFolders(member.companyId, member.userId).some(f => isSameOrAncestorPath(f, row.folder!.normalize('NFC')))
      if (!hasFullAccess(member.role) && !manages) return refuse('forbidden', 'まとまりの役割を変えられるのは、オーナー・管理者と部署の責任者だけです')
      const ids = holdersFrom(member.companyId, body, true)
      if (ids === undefined) return refuse('bad-request', ROLE_HOLDERS_INVALID, { code: 'ROLE_HOLDERS_INVALID' })
      handle.pluginRoles.setOverride(pluginId, role, row.id, ids, deps.clock.now(), member.userId)
      return ok(view(member, pluginId, m))
    },
  }
}

export type PluginRoleService = ReturnType<typeof createPluginRoleService>
