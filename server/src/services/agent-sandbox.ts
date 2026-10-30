/**
 * The AI sandbox setting (「AI の囲い」): the company's mode, allowed hosts,
 * denied places and what to do when a computer cannot start the sandbox,
 * plus per-member mode overrides for the staged rollout (owner's PC → a
 * department → everyone). Validation is shared/core/agent-sandbox.ts.
 *
 * - The setting and the overrides: owner/admin only; every change is recorded.
 * - The caller's own policy (`/me/agent-policy`): any member; the override
 *   replaces only the mode.
 */
import {
  AGENT_SANDBOX_MODES,
  DEFAULT_AGENT_SANDBOX_SETTINGS,
  DEFAULT_SANDBOX_ALLOWED_DOMAINS,
  parseAgentSandboxSettings,
  type AgentSandboxMode,
  type AgentSandboxSettings,
} from '../../shared/core/agent-sandbox'
import type { AgentSandboxChange, AgentSandboxPolicy, AgentSandboxView } from '../../shared/types/agent-sandbox'
import type { AccountDirectory } from '../ports/accounts'
import type { AgentSandboxRepository } from '../ports/agent-sandbox'
import type { Clock, IdGenerator } from '../ports/clock'
import type { MembershipRepository } from '../ports/memberships'
import { requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const AGENT_SANDBOX_FORBIDDEN = 'Only owners and admins can manage the AI sandbox'
const HISTORY_LIMIT = 20

export interface AgentSandboxDeps {
  agentSandbox: AgentSandboxRepository
  memberships: MembershipRepository
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
}

const defaults = (): AgentSandboxSettings => ({ ...DEFAULT_AGENT_SANDBOX_SETTINGS, allowedDomains: [...DEFAULT_AGENT_SANDBOX_SETTINGS.allowedDomains], deniedReadPaths: [] })

function sameSettings(a: AgentSandboxSettings, b: AgentSandboxSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const isMode = (value: unknown): value is AgentSandboxMode => (AGENT_SANDBOX_MODES as readonly unknown[]).includes(value)

export function createAgentSandboxService(deps: AgentSandboxDeps) {
  const { agentSandbox, memberships, accounts, clock, ids } = deps

  /** The stored setting, re-validated (a row that no longer validates falls back to the defaults). */
  function settingsOf(companyId: string): AgentSandboxSettings & { updatedAt: string | null; updatedBy: string | null } {
    const stored = agentSandbox.get(companyId)
    if (!stored) return { ...defaults(), updatedAt: null, updatedBy: null }
    let parsed: unknown
    try { parsed = JSON.parse(stored.settings) } catch { parsed = null }
    const result = parseAgentSandboxSettings(parsed)
    if ('error' in result) {
      console.warn(`[agent-sandbox] stored setting for ${companyId} is invalid; using the defaults`)
      return { ...defaults(), updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }
    }
    return { ...result.value, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }
  }

  /** The setting alone (without who changed it last). */
  function valuesOf(companyId: string): AgentSandboxSettings {
    const { mode, allowedDomains, deniedReadPaths, onUnavailable } = settingsOf(companyId)
    return { mode, allowedDomains, deniedReadPaths, onUnavailable }
  }

  function view(companyId: string): AgentSandboxView {
    const { updatedAt, updatedBy } = settingsOf(companyId)
    const settings = valuesOf(companyId)
    const members = new Set(memberships.listByCompany(companyId).map(m => m.user_id))
    const overrides = agentSandbox.overrides(companyId).filter(o => members.has(o.userId) && isMode(o.mode))
    const history = agentSandbox.history(companyId, HISTORY_LIMIT)
    const parsedHistory = history.map(h => {
      try { return { row: h, change: JSON.parse(h.change) as AgentSandboxChange['change'] } } catch { return null }
    }).filter((h): h is { row: typeof history[number]; change: AgentSandboxChange['change'] } => h !== null)
    const people = accounts.byIds([...new Set([
      ...overrides.map(o => o.userId),
      ...parsedHistory.map(h => h.row.changedBy),
      ...parsedHistory.flatMap(h => h.change.target === 'member' ? [h.change.userId] : []),
    ])])
    return {
      settings,
      defaultAllowedDomains: [...DEFAULT_SANDBOX_ALLOWED_DOMAINS],
      overrides: overrides.map(o => ({
        userId: o.userId,
        name: people.get(o.userId)?.name ?? null,
        email: people.get(o.userId)?.email ?? null,
        mode: o.mode as AgentSandboxMode,
        updatedAt: o.updatedAt,
      })),
      updatedAt,
      updatedBy,
      history: parsedHistory.map(({ row, change }) => ({
        id: row.id,
        changedAt: row.changedAt,
        changedBy: row.changedBy,
        name: people.get(row.changedBy)?.name ?? null,
        email: people.get(row.changedBy)?.email ?? null,
        change: change.target === 'member' ? { ...change, memberName: people.get(change.userId)?.name ?? null } : change,
      })),
    }
  }

  return {
    /** GET …/agent-sandbox (owner/admin). */
    get(member: Member): Outcome<AgentSandboxView> {
      const allowed = requireFullAccess(member, AGENT_SANDBOX_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(view(member.companyId))
    },

    /** PUT …/agent-sandbox (owner/admin): the whole setting; recorded when it changes. */
    update(member: Member, body: unknown): Outcome<AgentSandboxView> {
      const allowed = requireFullAccess(member, AGENT_SANDBOX_FORBIDDEN)
      if (!allowed.ok) return allowed
      const parsed = parseAgentSandboxSettings(body)
      if ('error' in parsed) return refuse('bad-request', parsed.error)
      const before = valuesOf(member.companyId)
      const after = parsed.value
      if (!sameSettings(before, after)) {
        const at = clock.now()
        agentSandbox.save(
          member.companyId,
          { settings: JSON.stringify(after), updatedAt: at, updatedBy: member.userId },
          { id: ids.newId(), changedAt: at, changedBy: member.userId, change: JSON.stringify({ target: 'company', before, after }) },
        )
      }
      return ok(view(member.companyId))
    },

    /**
     * PUT …/agent-sandbox/overrides/:userId `{ mode }` (a mode, or null to
     * follow the company again) — owner/admin; the user must be a member.
     */
    setOverride(member: Member, userId: string, body: unknown): Outcome<AgentSandboxView> {
      const allowed = requireFullAccess(member, AGENT_SANDBOX_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('mode' in body)) return refuse('bad-request', 'mode is required (off, observe, enforce or null)')
      const mode = (body as { mode: unknown }).mode
      if (mode !== null && !isMode(mode)) return refuse('bad-request', 'mode must be off, observe, enforce or null')
      if (memberships.roleOf(member.companyId, userId) === null) return refuse('not-found', 'Member not found')
      const current = agentSandbox.override(member.companyId, userId)
      const before = current && isMode(current.mode) ? current.mode : null
      if (before !== mode) {
        const at = clock.now()
        agentSandbox.saveOverride(
          member.companyId,
          userId,
          mode === null ? null : { userId, mode, updatedAt: at, updatedBy: member.userId },
          { id: ids.newId(), changedAt: at, changedBy: member.userId, change: JSON.stringify({ target: 'member', userId, before, after: mode }) },
        )
      }
      return ok(view(member.companyId))
    },

    /** The caller's sandbox policy: the company setting with their own override's mode. */
    policyFor(member: Member): AgentSandboxPolicy {
      const settings = valuesOf(member.companyId)
      const own = agentSandbox.override(member.companyId, member.userId)
      if (own && isMode(own.mode)) return { ...settings, mode: own.mode, source: 'member' }
      return { ...settings, source: 'company' }
    },
  }
}

export type AgentSandboxService = ReturnType<typeof createAgentSandboxService>
