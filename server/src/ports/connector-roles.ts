/**
 * The core roles' seam on the server (stage 3 B0, `.claude/rules/connector-roles.md`):
 * what role resolution needs from the outside. The core connectors register
 * from `composition/connectors.ts`; the admin's choice lives behind the company
 * handle (`connector_role_choices`).
 *
 * The core app asks for a role (`shared/core/connector-roles.ts`), never for a
 * service by name; the connector that serves it stays behind this seam.
 */
import type { ConnectorRole, RoleServing } from '../../shared/core/connector-roles'

/** A core connector (Google, Microsoft 365, Slack) as it registers for roles. */
export interface RoleConnector {
  /** `google`, `slack`, … (the core connector's id). */
  id: string
  /** The roles it serves, with their operations and optional capabilities (checked at registration). */
  servings: readonly RoleServing[]
  /**
   * Whether the company can use it now: set up, switched on, not stopped by
   * the operator. A member's own grant is not part of this: the connector's
   * client refuses a member without one, call by call.
   */
  usable(companyId: string): Promise<boolean>
}

/** The admin's choice per role, when two core connectors could serve it (spec §10-1: asked once). */
export interface ConnectorRoleChoiceRepository {
  /** The chosen connector's id for the role in the company, null when none was chosen. */
  choice(companyId: string, role: ConnectorRole): string | null
  /** Sets (or with null, clears) the choice; `by` and `at` go to its history. */
  setChoice(companyId: string, role: ConnectorRole, connectorId: string | null, by: string, at: string): void
}
