/**
 * The core connectors as the admin console shows them (「つないでいるサービス」,
 * stage 3 A1, `.claude/rules/connector-roles.md` "Built-in connectors").
 */
import type { BuiltinConnectorId } from '../core/builtin-connectors'
import type { ConnectorRole } from '../core/connector-roles'

export type CoreConnectorStatus = 'not-configured' | 'off' | 'operator-stopped' | 'on'

export interface CoreConnectorView {
  id: BuiltinConnectorId
  label: string
  summary: string
  /** not-configured: never set up; off: the company's switch; operator-stopped: the operator stopped it for every company; on: in use. */
  status: CoreConnectorStatus
  configured: boolean
  enabled: boolean
  operatorStopped: boolean
  /** The roles it serves (their labels as the core names them). */
  roles: Array<{ role: ConnectorRole; label: string; operations: string[]; capabilities: string[] }>
  /** Its own capabilities beyond the roles (e.g. Google Drive). */
  capabilities: Array<{ id: string; label: string }>
}

export interface CoreRoleView {
  role: ConnectorRole
  label: string
  /** Usable connectors that serve it now. */
  candidates: string[]
  /** The admin's choice (asked only when two could serve it). */
  choice: string | null
  /** The connector that serves it now, null when none or a choice is needed. */
  servedBy: string | null
  /** True when two or more could serve it and the admin has not chosen. */
  choiceNeeded: boolean
}

/** GET /api/companies/:id/connectors (owner/admin). */
export interface CoreConnectorsView {
  connectors: CoreConnectorView[]
  roles: CoreRoleView[]
}

/** PUT /api/companies/:id/connector-roles/:role */
export interface CoreRoleChoiceSave {
  connectorId: string | null
}

/** PUT /api/companies/:id/connectors/:connectorId/enabled */
export interface CoreConnectorEnabledSave {
  enabled: boolean
}
