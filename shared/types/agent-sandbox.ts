/**
 * Wire shapes of the AI sandbox setting (「AI の囲い」) and of the policy the
 * desktop app fetches (`GET /api/companies/:id/me/agent-policy`). The rules
 * (validation, defaults) are in shared/core/agent-sandbox.ts.
 */
import type { AgentSandboxMode, AgentSandboxSettings } from '../core/agent-sandbox'
import type { AgentStopPolicy } from './agent-stop'

/** A member whose mode differs from the company's (rollout: owner's PC → a department → everyone). */
export interface AgentSandboxOverride {
  userId: string
  name: string | null
  email: string | null
  mode: AgentSandboxMode
  updatedAt: string
}

/** One change: the company setting (before → after) or one member's override (null = none). */
export interface AgentSandboxChange {
  id: string
  changedAt: string
  changedBy: string
  name: string | null
  email: string | null
  change:
    | { target: 'company'; before: AgentSandboxSettings; after: AgentSandboxSettings }
    | { target: 'member'; userId: string; memberName: string | null; before: AgentSandboxMode | null; after: AgentSandboxMode | null }
}

/** GET|PUT …/agent-sandbox (owner/admin). */
export interface AgentSandboxView {
  settings: AgentSandboxSettings
  /** The starting host list (for 「初期の一覧に戻す」). */
  defaultAllowedDomains: string[]
  overrides: AgentSandboxOverride[]
  updatedAt: string | null
  updatedBy: string | null
  /** Newest first, at most 20. */
  history: AgentSandboxChange[]
}

/** The sandbox part of the caller's policy: the company setting with their override applied. */
export interface AgentSandboxPolicy extends AgentSandboxSettings {
  /** Where `mode` came from. */
  source: 'company' | 'member'
}

/**
 * GET …/me/agent-policy (any member): what the app's AI must follow. `version`
 * (also the ETag) changes whenever the answer changes; the push channel
 * (`/me/events`) announces new versions.
 */
export interface AgentPolicy {
  version: string
  sandbox: AgentSandboxPolicy
  /**
   * The emergency stop (monitoring M2, agent-stop.ts). Absent from an older
   * server: the app then stops nothing.
   */
  stop?: AgentStopPolicy
}
