/**
 * The browser-operation setting (「ブラウザ操作」, .claude/rules/agent-browser.md): whether the
 * chat AI may operate sites at all, which sites (one operated host, the hosts its pages load
 * parts from, a level), plus per-member mode overrides (try it with one person first).
 * Validation is shared/core/browser-operation.ts.
 *
 * - The setting and the overrides: owner/admin only; every change is recorded.
 * - The caller's own policy (`/me/agent-policy`): any member; the override replaces only
 *   the mode, and only one set while the person is a member this time — an override from
 *   before they left the company never comes back with them.
 */
import {
  BROWSER_OPERATION_MODES,
  DEFAULT_BROWSER_OPERATION_SETTINGS,
  parseBrowserOperationSettings,
  type BrowserOperationMode,
  type BrowserOperationSettings,
} from '../../shared/core/browser-operation'
import type { AgentBrowserChange, AgentBrowserPolicy, AgentBrowserView } from '../../shared/types/agent-browser'
import type { AccountDirectory } from '../ports/accounts'
import type { AgentBrowserRepository, StoredAgentBrowserOverride } from '../ports/agent-browser'
import type { Clock, IdGenerator } from '../ports/clock'
import type { MembershipRepository } from '../ports/memberships'
import { requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const AGENT_BROWSER_FORBIDDEN = 'Only owners and admins can manage browser operation'
const HISTORY_LIMIT = 20

export interface AgentBrowserDeps {
  agentBrowser: AgentBrowserRepository
  memberships: MembershipRepository
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  log?: Pick<Console, 'warn'>
}

const defaults = (): BrowserOperationSettings => ({ ...DEFAULT_BROWSER_OPERATION_SETTINGS, sites: [] })

const isMode = (value: unknown): value is BrowserOperationMode => (BROWSER_OPERATION_MODES as readonly unknown[]).includes(value)

export function createAgentBrowserService(deps: AgentBrowserDeps) {
  const { agentBrowser, memberships, accounts, clock, ids } = deps
  const log = deps.log ?? console

  /** The stored setting, re-validated (a row that no longer validates falls back to the defaults). */
  function settingsOf(companyId: string): { settings: BrowserOperationSettings; updatedAt: string | null; updatedBy: string | null } {
    const stored = agentBrowser.get(companyId)
    if (!stored) return { settings: defaults(), updatedAt: null, updatedBy: null }
    let parsed: unknown
    try { parsed = JSON.parse(stored.settings) } catch { parsed = null }
    const result = parseBrowserOperationSettings(parsed)
    if ('error' in result) {
      log.warn(`[agent-browser] stored setting for ${companyId} is invalid; using the defaults`)
      return { settings: defaults(), updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }
    }
    return { settings: result.value, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }
  }

  /**
   * Whether an override still applies: its mode is known and it was set while the person is a
   * member this time (memberships' created_at; a member who left and came back starts over).
   */
  function applies(override: StoredAgentBrowserOverride, joinedAt: string | undefined): boolean {
    return isMode(override.mode) && joinedAt !== undefined && override.updatedAt >= joinedAt
  }

  function view(companyId: string): AgentBrowserView {
    const { settings, updatedAt, updatedBy } = settingsOf(companyId)
    const joined = new Map(memberships.listByCompany(companyId).map(m => [m.user_id, m.created_at]))
    const overrides = agentBrowser.overrides(companyId).filter(o => applies(o, joined.get(o.userId)))
    const history = agentBrowser.history(companyId, HISTORY_LIMIT)
    const parsedHistory = history.map(h => {
      try { return { row: h, change: JSON.parse(h.change) as AgentBrowserChange['change'] } } catch { return null }
    }).filter((h): h is { row: typeof history[number]; change: AgentBrowserChange['change'] } => h !== null)
    const people = accounts.byIds([...new Set([
      ...overrides.map(o => o.userId),
      ...parsedHistory.map(h => h.row.changedBy),
      ...parsedHistory.flatMap(h => h.change.target === 'member' ? [h.change.userId] : []),
    ])])
    return {
      settings,
      overrides: overrides.map(o => ({
        userId: o.userId,
        name: people.get(o.userId)?.name ?? null,
        email: people.get(o.userId)?.email ?? null,
        mode: o.mode as BrowserOperationMode,
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

  /** The override in force for this member, or null. */
  function overrideOf(companyId: string, userId: string): BrowserOperationMode | null {
    const own = agentBrowser.override(companyId, userId)
    if (!own) return null
    const joinedAt = memberships.listByCompany(companyId).find(m => m.user_id === userId)?.created_at
    return applies(own, joinedAt) ? own.mode as BrowserOperationMode : null
  }

  return {
    /** GET …/agent-browser (owner/admin). */
    get(member: Member): Outcome<AgentBrowserView> {
      const allowed = requireFullAccess(member, AGENT_BROWSER_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(view(member.companyId))
    },

    /** PUT …/agent-browser (owner/admin): the whole setting; recorded when it changes. */
    update(member: Member, body: unknown): Outcome<AgentBrowserView> {
      const allowed = requireFullAccess(member, AGENT_BROWSER_FORBIDDEN)
      if (!allowed.ok) return allowed
      const parsed = parseBrowserOperationSettings(body)
      if ('error' in parsed) return refuse('bad-request', parsed.error)
      const before = settingsOf(member.companyId).settings
      const after = parsed.value
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const at = clock.now()
        agentBrowser.save(
          member.companyId,
          { settings: JSON.stringify(after), updatedAt: at, updatedBy: member.userId },
          { id: ids.newId(), changedAt: at, changedBy: member.userId, change: JSON.stringify({ target: 'company', before, after }) },
        )
      }
      return ok(view(member.companyId))
    },

    /**
     * PUT …/agent-browser/overrides/:userId `{ mode }` (off / on, or null to follow the
     * company again) — owner/admin; the user must be a member.
     */
    setOverride(member: Member, userId: string, body: unknown): Outcome<AgentBrowserView> {
      const allowed = requireFullAccess(member, AGENT_BROWSER_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('mode' in body)) return refuse('bad-request', 'mode is required (off, on or null)')
      const mode = (body as { mode: unknown }).mode
      if (mode !== null && !isMode(mode)) return refuse('bad-request', 'mode must be off, on or null')
      if (memberships.roleOf(member.companyId, userId) === null) return refuse('not-found', 'Member not found')
      const before = overrideOf(member.companyId, userId)
      // A stale row (from before the person left) is replaced or removed even when `before` reads null.
      const stale = before === null && agentBrowser.override(member.companyId, userId) !== null
      if (before !== mode || stale) {
        const at = clock.now()
        agentBrowser.saveOverride(
          member.companyId,
          userId,
          mode === null ? null : { userId, mode, updatedAt: at, updatedBy: member.userId },
          { id: ids.newId(), changedAt: at, changedBy: member.userId, change: JSON.stringify({ target: 'member', userId, before, after: mode }) },
        )
      }
      return ok(view(member.companyId))
    },

    /** The caller's browser policy: the company setting with their own override's mode. */
    policyFor(member: Pick<Member, 'companyId' | 'userId'>): AgentBrowserPolicy {
      const { settings } = settingsOf(member.companyId)
      const own = overrideOf(member.companyId, member.userId)
      if (own) return { ...settings, mode: own, source: 'member' }
      return { ...settings, source: 'company' }
    },
  }
}

export type AgentBrowserService = ReturnType<typeof createAgentBrowserService>
