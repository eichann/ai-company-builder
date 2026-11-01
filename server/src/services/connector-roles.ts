/**
 * Role resolution (stage 3 B0, `.claude/rules/connector-roles.md`): which core
 * connector serves a role (予定を読む, メールを読む・送る, 会議の記録を読む,
 * チャットの連絡を受け取る・返す) in a company now. The core app's services ask
 * here and never name a service; the answer's connector id picks the
 * connector's own implementation of the role.
 *
 * The rule itself is `resolveRole` in `shared/core/connector-roles.ts` (the
 * admin console shows the same answer); this module gathers its inputs: the
 * registered connectors, whether each is usable in the company now (from the
 * next call: a switch off or an operator stop counts at once), and the admin's
 * choice when two could serve the role.
 *
 * Not wired yet: `composition/connectors.ts` (after S2) creates it and the
 * core connectors register (A1 Google, A3 Slack).
 */
import {
  CONNECTOR_ROLE_NAMES, resolveRole, roleServingProblems,
  type ConnectorRole, type RoleCandidate, type RoleResolution,
} from '../../shared/core/connector-roles'
import type { Clock } from '../ports/clock'
import type { ConnectorRoleChoiceRepository, RoleConnector } from '../ports/connector-roles'
import { ok, refuse, type Outcome } from './outcome'

export interface ConnectorRolesDeps {
  choices: ConnectorRoleChoiceRepository
  clock: Clock
}

/** One role as the admin's 「つないでいるサービス」 shows it. */
export interface RoleView {
  role: ConnectorRole
  /** Usable connectors that serve the role now. */
  candidates: string[]
  choice: string | null
  resolution: RoleResolution
}

export function createConnectorRoles(deps: ConnectorRolesDeps) {
  const connectors = new Map<string, RoleConnector>()

  async function candidatesIn(companyId: string): Promise<RoleCandidate[]> {
    const out: RoleCandidate[] = []
    for (const c of connectors.values()) {
      let usable = false
      try {
        usable = await c.usable(companyId)
      } catch {
        usable = false
      }
      out.push({ connectorId: c.id, servings: c.servings, usable })
    }
    return out
  }

  return {
    /** A core connector registers once at start-up; a wrong declaration stops the start. */
    register(connector: RoleConnector): void {
      const problems = roleServingProblems(connector.servings)
      if (problems.length > 0) throw new Error(`Role declaration of ${connector.id} refused: ${problems.join(' / ')}`)
      if (connectors.has(connector.id)) throw new Error(`Core connector registered twice: ${connector.id}`)
      connectors.set(connector.id, connector)
    },

    /**
     * Which connector serves `role` (for `operation`, when given) in the
     * company now. `none` and `choice-needed` are answers, not errors: the
     * caller shows its own plain sentence (「つないでいるサービスがありません」).
     */
    async resolve(companyId: string, role: ConnectorRole, operation: string | null = null): Promise<RoleResolution> {
      return resolveRole(role, operation, await candidatesIn(companyId), deps.choices.choice(companyId, role))
    },

    /** Every role with its candidates and the admin's choice (the admin screen, A1). */
    async views(companyId: string): Promise<RoleView[]> {
      const candidates = await candidatesIn(companyId)
      return CONNECTOR_ROLE_NAMES.map(role => {
        const choice = deps.choices.choice(companyId, role)
        return {
          role,
          candidates: candidates.filter(c => c.usable && c.servings.some(s => s.role === role)).map(c => c.connectorId).sort(),
          choice,
          resolution: resolveRole(role, null, candidates, choice),
        }
      })
    },

    /**
     * The admin chooses which connector serves a role (null clears it). The
     * caller has checked the role (owner / admin). Only a registered connector
     * that declares the role can be chosen; it need not be on now (the admin
     * may choose before switching it on).
     */
    choose(companyId: string, role: string, connectorId: string | null, by: string): Outcome<{ role: ConnectorRole; choice: string | null }> {
      if (!CONNECTOR_ROLE_NAMES.includes(role as ConnectorRole)) return refuse('bad-request', '知らない役目です')
      const r = role as ConnectorRole
      if (connectorId !== null) {
        const c = connectors.get(connectorId)
        if (!c || !c.servings.some(s => s.role === r)) return refuse('bad-request', 'このサービスはこの役目を受け持てません')
      }
      deps.choices.setChoice(companyId, r, connectorId, by, deps.clock.now())
      return ok({ role: r, choice: connectorId })
    },
  }
}

export type ConnectorRoles = ReturnType<typeof createConnectorRoles>
