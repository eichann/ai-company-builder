/**
 * The core connectors in the admin console (「つないでいるサービス」, stage 3 A1,
 * `.claude/rules/connector-roles.md` "Built-in connectors"): every connector
 * built into ACB (`shared/core/builtin-connectors.ts`) with its state in the
 * company — set up, the company's on / off, the operator's stop — the roles it
 * serves, and which connector serves each role now (with the admin's choice
 * when two could).
 *
 * On / off and the operator's stop are the connectors' existing switches: each
 * connector hands in its own `state` and `setEnabled` (Google: its client's
 * switch and `<PLUGINS_DIR>/stopped`), so this module names no service.
 * Owners and admins only.
 */
import { BUILTIN_CONNECTORS, isBuiltinConnectorId, type BuiltinConnectorId } from '../../shared/core/builtin-connectors'
import { CONNECTOR_ROLES } from '../../shared/core/connector-roles'
import type { CoreConnectorStatus, CoreConnectorView, CoreConnectorsView, CoreRoleView } from '../../shared/types/core-connectors'
import { requireFullAccess, type Member } from './access'
import type { ConnectorRoles } from './connector-roles'
import { ok, refuse, type Outcome } from './outcome'

export const CORE_CONNECTORS_FORBIDDEN = 'Only owners and admins can manage the connected services'

export interface CoreConnectorSwitches {
  state(companyId: string): Promise<{ configured: boolean; enabled: boolean; operatorStopped: boolean }>
  /** The connector's own on / off (its own checks and history). */
  setEnabled(member: Member, body: unknown): Promise<Outcome<unknown>>
}

export interface CoreConnectorsDeps {
  roles: Pick<ConnectorRoles, 'views' | 'choose'>
  switches: Partial<Record<BuiltinConnectorId, CoreConnectorSwitches>>
}

function statusOf(s: { configured: boolean; enabled: boolean; operatorStopped: boolean }): CoreConnectorStatus {
  if (s.operatorStopped) return 'operator-stopped'
  if (!s.configured) return 'not-configured'
  return s.enabled ? 'on' : 'off'
}

export function createCoreConnectors(deps: CoreConnectorsDeps) {
  async function view(companyId: string): Promise<CoreConnectorsView> {
    const connectors: CoreConnectorView[] = []
    for (const [id, sw] of Object.entries(deps.switches) as Array<[BuiltinConnectorId, CoreConnectorSwitches]>) {
      const d = BUILTIN_CONNECTORS[id]
      const s = await sw.state(companyId)
      connectors.push({
        id, label: d.label, summary: d.summary, status: statusOf(s), ...s,
        roles: d.servings.map(r => ({ role: r.role, label: CONNECTOR_ROLES[r.role].label, operations: [...r.operations], capabilities: [...r.capabilities] })),
        capabilities: d.capabilities.map(c => ({ ...c })),
      })
    }
    const roles: CoreRoleView[] = (await deps.roles.views(companyId)).map(v => ({
      role: v.role,
      label: CONNECTOR_ROLES[v.role].label,
      candidates: v.candidates,
      choice: v.choice,
      servedBy: v.resolution.ok ? v.resolution.connectorId : null,
      choiceNeeded: !v.resolution.ok && v.resolution.reason === 'choice-needed',
    }))
    return { connectors, roles }
  }

  return {
    /** GET …/connectors (owner/admin). */
    async view(member: Member): Promise<Outcome<CoreConnectorsView>> {
      const allowed = requireFullAccess(member, CORE_CONNECTORS_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(await view(member.companyId))
    },

    /** PUT …/connector-roles/:role { connectorId } (owner/admin): which connector serves the role when two could. */
    async chooseRole(member: Member, role: string, body: unknown): Promise<Outcome<CoreConnectorsView>> {
      const allowed = requireFullAccess(member, CORE_CONNECTORS_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('connectorId' in body)) return refuse('bad-request', 'connectorId: a connector id or null')
      const connectorId = (body as { connectorId: unknown }).connectorId
      if (connectorId !== null && typeof connectorId !== 'string') return refuse('bad-request', 'connectorId: a connector id or null')
      const chosen = deps.roles.choose(member.companyId, role, connectorId, member.userId)
      if (!chosen.ok) return chosen
      return ok(await view(member.companyId))
    },

    /** PUT …/connectors/:connectorId/enabled { enabled } (owner/admin): the connector's own switch. */
    async setEnabled(member: Member, connectorId: string, body: unknown): Promise<Outcome<CoreConnectorsView>> {
      const allowed = requireFullAccess(member, CORE_CONNECTORS_FORBIDDEN)
      if (!allowed.ok) return allowed
      const sw = isBuiltinConnectorId(connectorId) ? deps.switches[connectorId] : undefined
      if (!sw) return refuse('not-found', 'Connector not found')
      const r = await sw.setEnabled(member, body)
      if (!r.ok) return r
      return ok(await view(member.companyId))
    },
  }
}

export type CoreConnectors = ReturnType<typeof createCoreConnectors>
