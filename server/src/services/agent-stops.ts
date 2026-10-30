/**
 * The emergency stop (monitoring M2, 「AI の緊急停止」; .claude/rules/agent-stop.md).
 *
 * - Owner/admin stop the AI for the whole company or one member, either all of
 *   it or one kind of tool (command / write / web / external MCP), with a
 *   reason; every stop and release is kept (who, when, why).
 * - `policyFor` is the stop part of each member's policy (`/me/agent-policy`).
 * - Which members' apps follow the stop: an app that does sends
 *   X-ACB-Agent-Stop and is recorded by `seen`; members who use the desktop app
 *   (client_activity has their build) but are not recorded with that build are
 *   「停止に対応していないアプリ」.
 * - `onChange(companyId)` runs after every stop and release (the push channel
 *   announces the new policy version to that company's members).
 */
import {
  AGENT_STOP_REASON_MAX,
  AGENT_STOP_TOOL_KINDS,
  isAgentStopToolKind,
  type AgentStopEntry,
  type AgentStopPolicy,
  type AgentStopToolKind,
  type AgentStopView,
} from '../../shared/types/agent-stop'
import type { AccountDirectory } from '../ports/accounts'
import type { AgentStopRepository, StoredAgentStop } from '../ports/agent-stops'
import type { ClientActivityRepository } from '../ports/client-activity'
import type { Clock, IdGenerator } from '../ports/clock'
import type { BrokerKeyRepository } from '../ports/key-broker'
import type { MembershipRepository } from '../ports/memberships'
import { requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const AGENT_STOP_FORBIDDEN = 'Only owners and admins can stop the AI'
const HISTORY_LIMIT = 50

export interface AgentStopDeps {
  agentStops: AgentStopRepository
  memberships: MembershipRepository
  clientActivity: ClientActivityRepository
  accounts: AccountDirectory
  brokerKeys: BrokerKeyRepository
  /** Whether the key broker runs (its KEK is loaded). */
  brokerEnabled: () => boolean
  clock: Clock
  ids: IdGenerator
  /** After a stop or release in this company. Must not throw into the request. */
  onChange?: (companyId: string) => void
}

const toolOf = (value: string | null): AgentStopToolKind | null => (isAgentStopToolKind(value) ? value : null)

export function createAgentStopService(deps: AgentStopDeps) {
  const { agentStops, memberships, clientActivity, accounts, brokerKeys, clock, ids } = deps

  const changed = (companyId: string) => {
    try { deps.onChange?.(companyId) } catch (error) {
      console.warn('[agent-stop] announcing the change failed:', error instanceof Error ? error.message : 'unknown')
    }
  }

  function entries(rows: StoredAgentStop[]): AgentStopEntry[] {
    const people = accounts.byIds([...new Set(rows.flatMap(r => [r.userId, r.stoppedBy, r.releasedBy].filter((v): v is string => !!v)))])
    return rows
      // A row with a tool this build does not know would read as "the whole AI": leave it out.
      .filter(r => r.tool === null || isAgentStopToolKind(r.tool))
      .map(r => ({
        id: r.id,
        userId: r.userId,
        userName: r.userId ? people.get(r.userId)?.name ?? null : null,
        userEmail: r.userId ? people.get(r.userId)?.email ?? null : null,
        tool: toolOf(r.tool),
        reason: r.reason,
        stoppedAt: r.stoppedAt,
        stoppedBy: r.stoppedBy,
        stoppedByName: people.get(r.stoppedBy)?.name ?? null,
        releasedAt: r.releasedAt,
        releasedBy: r.releasedBy,
        releasedByName: r.releasedBy ? people.get(r.releasedBy)?.name ?? null : null,
      }))
  }

  function unsupported(companyId: string): AgentStopView['unsupported'] {
    const members = memberships.listByCompany(companyId)
    const activity = clientActivity.forCompany(companyId)
    const following = agentStops.clients(companyId)
    const missing = members.filter(m => {
      const used = activity.get(m.user_id)?.client_version
      // Never used the desktop app (or an app too old to say its build): nothing runs AI for them here.
      if (!used) return false
      return following.get(m.user_id)?.clientVersion !== used
    })
    const people = accounts.byIds(missing.map(m => m.user_id))
    return missing.map(m => ({
      userId: m.user_id,
      name: people.get(m.user_id)?.name ?? null,
      email: people.get(m.user_id)?.email ?? null,
      clientVersion: activity.get(m.user_id)?.client_version ?? null,
    }))
  }

  function view(companyId: string): AgentStopView {
    const keys = brokerKeys.list(companyId)
    return {
      active: entries(agentStops.active(companyId)),
      history: entries(agentStops.history(companyId, HISTORY_LIMIT)),
      unsupported: unsupported(companyId),
      keys: {
        enabled: deps.brokerEnabled(),
        active: keys.filter(k => k.status === 'active').length,
        stopped: keys.filter(k => k.status !== 'active').length,
      },
    }
  }

  return {
    /** GET …/agent-stops (owner/admin). */
    get(member: Member): Outcome<AgentStopView> {
      const allowed = requireFullAccess(member, AGENT_STOP_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(view(member.companyId))
    },

    /**
     * POST …/agent-stops `{ userId?, tool?, reason? }` (owner/admin). The same
     * scope already in force → nothing new (the answer is the same view).
     */
    stop(member: Member, body: unknown): Outcome<AgentStopView> {
      const allowed = requireFullAccess(member, AGENT_STOP_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('bad-request', 'A JSON object is required')
      const { userId = null, tool = null, reason = '' } = body as { userId?: unknown; tool?: unknown; reason?: unknown }
      if (userId !== null && (typeof userId !== 'string' || !userId)) return refuse('bad-request', 'userId must be a member id or null')
      if (tool !== null && !isAgentStopToolKind(tool)) return refuse('bad-request', `tool must be one of ${AGENT_STOP_TOOL_KINDS.join(', ')} or null`)
      if (typeof reason !== 'string' || reason.length > AGENT_STOP_REASON_MAX) return refuse('bad-request', `reason must be text of at most ${AGENT_STOP_REASON_MAX} characters`)
      if (userId !== null && memberships.roleOf(member.companyId, userId) === null) return refuse('not-found', 'Member not found')
      const same = agentStops.active(member.companyId).some(s => s.userId === userId && s.tool === tool)
      if (!same) {
        agentStops.insert(member.companyId, {
          id: ids.newId(), userId, tool, reason: reason.trim(),
          stoppedAt: clock.now(), stoppedBy: member.userId, releasedAt: null, releasedBy: null,
        })
        console.log(`[agent-stop] ${member.companyId}: stop added (${userId === null ? 'everyone' : 'one member'}, ${tool ?? 'all'})`)
        changed(member.companyId)
      }
      return ok(view(member.companyId))
    },

    /** DELETE …/agent-stops/:stopId (owner/admin): release one stop (a released one stays released). */
    release(member: Member, stopId: string): Outcome<AgentStopView> {
      const allowed = requireFullAccess(member, AGENT_STOP_FORBIDDEN)
      if (!allowed.ok) return allowed
      const row = agentStops.find(member.companyId, stopId)
      if (!row) return refuse('not-found', 'Stop not found')
      if (row.releasedAt === null) {
        agentStops.release(member.companyId, stopId, clock.now(), member.userId)
        console.log(`[agent-stop] ${member.companyId}: stop released`)
        changed(member.companyId)
      }
      return ok(view(member.companyId))
    },

    /** The stop part of this member's policy: everyone's stops and their own, merged. */
    policyFor(member: Member): AgentStopPolicy {
      const rows = agentStops.activeFor(member.companyId, member.userId)
      const all = rows.some(r => r.tool === null)
      const tools = AGENT_STOP_TOOL_KINDS.filter(kind => rows.some(r => r.tool === kind))
      return { all, tools }
    },

    /** A company-wide stop of the whole AI is in force (the key broker's relay refuses every call). */
    companyStopped(companyId: string): boolean {
      return agentStops.active(companyId).some(r => r.userId === null && r.tool === null)
    },

    /** The member's app said it follows the stop (X-ACB-Agent-Stop), with its build. */
    seen(member: Member, clientVersion: string | null): void {
      agentStops.seen(member.companyId, member.userId, clientVersion, clock.now())
    },
  }
}

export type AgentStopService = ReturnType<typeof createAgentStopService>
