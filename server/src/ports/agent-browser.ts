/**
 * Storage of the company's browser-operation setting (「ブラウザ操作」), the
 * per-member mode overrides and the change history. Shapes on the wire:
 * shared/types/agent-browser.ts; rules: services/agent-browser.ts.
 */

export interface StoredAgentBrowser {
  /** JSON of BrowserOperationSettings as last saved (re-validated on read). */
  settings: string
  updatedAt: string
  updatedBy: string | null
}

export interface StoredAgentBrowserOverride {
  userId: string
  mode: string
  updatedAt: string
  updatedBy: string
}

export interface AgentBrowserChangeRow {
  id: string
  changedAt: string
  changedBy: string
  /** JSON of the change (company before/after, or one member's before/after). */
  change: string
}

export interface AgentBrowserRepository {
  /** null while the company never changed the defaults. */
  get(companyId: string): StoredAgentBrowser | null
  /** Write the setting and its history row together. */
  save(companyId: string, stored: StoredAgentBrowser, change: AgentBrowserChangeRow): void
  overrides(companyId: string): StoredAgentBrowserOverride[]
  override(companyId: string, userId: string): StoredAgentBrowserOverride | null
  /** Set (a value) or remove (null) one member's override, with its history row. */
  saveOverride(companyId: string, userId: string, value: StoredAgentBrowserOverride | null, change: AgentBrowserChangeRow): void
  /** Newest first. */
  history(companyId: string, limit: number): AgentBrowserChangeRow[]
}
