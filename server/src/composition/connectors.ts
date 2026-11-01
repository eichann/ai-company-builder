/**
 * Lane A (connectors) wiring: the services this lane adds, built here so the
 * lane does not edit the shared body of src/composition.ts
 * (.claude/rules/server.md "Lane markers"). Like composition.ts, this module
 * may import adapters.
 *
 * - `wireCoreConnectors` (called once from the Google block of composition.ts,
 *   before the core services that use the roles): the core roles
 *   (connector-roles.md) — the role resolver with the admin's choice, Google
 *   registered as a built-in core connector (shared/core/builtin-connectors.ts)
 *   and its role implementations, and the routed role ports the core services
 *   take (calendar, minutes, outbound mail; the inbox later).
 * - `wireConnectorsLane` (the lane's line under `// lane A ▼`): what the lane
 *   adds to `services`.
 */
import type Database from 'better-sqlite3'
import { BUILTIN_CONNECTORS } from '../../shared/core/builtin-connectors'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { ConnectorRoleChoiceRepository } from '../ports/connector-roles'
import { createConnectorRoles } from '../services/connector-roles'
import { createRoleProviders } from '../services/connector-role-providers'
import { createCoreConnectors } from '../services/core-connectors'
import { createGoogleCalendar } from '../services/google-calendar'
import type { GoogleClient } from '../services/google-client'
import type { GoogleConnector } from '../services/google-connector'
import { createGoogleMail } from '../services/google-mail'
import { createGoogleMeetings, type GoogleRequester } from '../services/google-meetings'

export interface CoreConnectorsWiringDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  googleClient: GoogleClient
  googleConnector: GoogleConnector
}

export function wireCoreConnectors(deps: CoreConnectorsWiringDeps) {
  const { companyData, clock, ids, googleClient, googleConnector } = deps
  // The admin's choice per role lives behind the company handle (connectors repository).
  const choices: ConnectorRoleChoiceRepository = {
    choice: (companyId, role) => companyData.forCompany(companyId).connectors.roleChoice(role),
    setChoice: (companyId, role, connectorId, by, at) => companyData.forCompany(companyId).connectors.setRoleChoice(role, connectorId, at, by, ids.newId()),
  }
  const connectorRoles = createConnectorRoles({ choices, clock })

  // Google: a built-in core connector (its code stays where it is: google-*.ts).
  connectorRoles.register({ id: BUILTIN_CONNECTORS.google.id, servings: BUILTIN_CONNECTORS.google.servings, usable: companyId => googleConnector.usable(companyId) })
  const request: GoogleRequester = (companyId, userId, req) => googleClient.request(companyId, userId, req)
  const googleMail = createGoogleMail({ request, companyData })
  const roleProviders = createRoleProviders(connectorRoles, {
    google: {
      calendar: createGoogleCalendar({ request, internalDomain: companyId => companyData.forCompany(companyId).connectors.client()?.domain ?? null }),
      meetings: createGoogleMeetings(request),
      mailReader: googleMail,
      mailSender: googleMail,
    },
  })

  // 「つないでいるサービス」: each built-in connector's own switches (Google: its client's on / off, the operator's stop file).
  const coreConnectors = createCoreConnectors({
    roles: connectorRoles,
    switches: {
      google: { state: companyId => googleConnector.state(companyId), setEnabled: (member, body) => googleConnector.setEnabled(member, body) },
    },
  })

  return { connectorRoles, roleProviders, coreConnectors }
}

export type CoreConnectorsWiring = ReturnType<typeof wireCoreConnectors>

export interface ConnectorsLaneDeps {
  conn: Database.Database
  core: CoreConnectorsWiring
}

export function wireConnectorsLane(deps: ConnectorsLaneDeps) {
  return {
    connectorRoles: deps.core.connectorRoles,
    coreConnectors: deps.core.coreConnectors,
    /** メールを読む (the role, routed): the inbox (lane B) reads mail through this, never through Gmail. */
    mailReader: deps.core.roleProviders.mailReader,
  }
}
