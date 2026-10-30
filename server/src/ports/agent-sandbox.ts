/**
 * Storage of the company's AI sandbox setting (「AI の囲い」), the per-member
 * mode overrides and the change history. Shapes on the wire:
 * shared/types/agent-sandbox.ts; rules: services/agent-sandbox.ts.
 */

export interface StoredAgentSandbox {
  /** JSON of AgentSandboxSettings as last saved (re-validated on read). */
  settings: string
  updatedAt: string
  updatedBy: string | null
}

export interface StoredAgentSandboxOverride {
  userId: string
  mode: string
  updatedAt: string
  updatedBy: string
}

export interface AgentSandboxChangeRow {
  id: string
  changedAt: string
  changedBy: string
  /** JSON of the change (company before/after, or one member's before/after). */
  change: string
}

export interface AgentSandboxRepository {
  /** null while the company never changed the defaults. */
  get(companyId: string): StoredAgentSandbox | null
  /** Write the setting and its history row together. */
  save(companyId: string, stored: StoredAgentSandbox, change: AgentSandboxChangeRow): void
  overrides(companyId: string): StoredAgentSandboxOverride[]
  override(companyId: string, userId: string): StoredAgentSandboxOverride | null
  /** Set (a value) or remove (null) one member's override, with its history row. */
  saveOverride(companyId: string, userId: string, value: StoredAgentSandboxOverride | null, change: AgentSandboxChangeRow): void
  /** Newest first. */
  history(companyId: string, limit: number): AgentSandboxChangeRow[]
}
