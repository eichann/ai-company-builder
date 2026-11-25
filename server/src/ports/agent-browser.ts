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

/** A registered domain's 「詳しい設定」 as stored (re-validated on read). */
export interface StoredAgentBrowserSiteParts {
  host: string
  /** JSON of BrowserSiteParts. */
  parts: string
  updatedAt: string
  updatedBy: string
}

export interface AgentBrowserRepository {
  /** null while the company never changed the defaults. */
  get(companyId: string): StoredAgentBrowser | null
  /** Write the setting and its history row together. */
  save(companyId: string, stored: StoredAgentBrowser, change: AgentBrowserChangeRow): void
  overrides(companyId: string): StoredAgentBrowserOverride[]
  override(companyId: string, userId: string): StoredAgentBrowserOverride | null
  /**
   * Set (a value) or remove (null) one member's override, with its history row (null only when
   * removing a row that no longer applied: nothing changed for anyone).
   */
  saveOverride(companyId: string, userId: string, value: StoredAgentBrowserOverride | null, change: AgentBrowserChangeRow | null): void
  /** Newest first. */
  history(companyId: string, limit: number): AgentBrowserChangeRow[]
  /** Every domain's 「詳しい設定」 the company stored, by host. */
  siteParts(companyId: string): StoredAgentBrowserSiteParts[]
  /** Set (a value) or remove (null) one domain's 「詳しい設定」, with its history row, in one transaction. */
  saveSiteParts(companyId: string, host: string, value: StoredAgentBrowserSiteParts | null, change: AgentBrowserChangeRow): void
}
