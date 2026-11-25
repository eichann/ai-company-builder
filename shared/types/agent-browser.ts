/**
 * Wire shapes of the browser-operation setting (「ブラウザ操作」) and of its part
 * of the policy the desktop app fetches (`GET /api/companies/:id/me/agent-policy`).
 * The rules (validation, defaults, the request rule) are in
 * shared/core/browser-operation.ts; the server and admin pieces are listed in
 * .claude/rules/agent-browser.md.
 */
import type { BrowserOperationMode, BrowserOperationSettings } from '../core/browser-operation'
import type { BrowserSiteParts } from '../core/browser-site-parts'

/** A member whose mode differs from the company's (try it with one person first). */
export interface AgentBrowserOverride {
  userId: string
  name: string | null
  email: string | null
  mode: BrowserOperationMode
  updatedAt: string
}

/** One change: the company setting (before → after) or one member's override (null = none). */
export interface AgentBrowserChange {
  id: string
  changedAt: string
  changedBy: string
  name: string | null
  email: string | null
  change:
    | { target: 'company'; before: BrowserOperationSettings; after: BrowserOperationSettings }
    | { target: 'member'; userId: string; memberName: string | null; before: BrowserOperationMode | null; after: BrowserOperationMode | null }
    /** A registered domain's 「詳しい設定」 (parts hosts, login helpers); null = none set (the app's fallback). */
    | { target: 'site-parts'; host: string; before: BrowserSiteParts | null; after: BrowserSiteParts | null }
}

/** GET|PUT …/agent-browser (owner/admin). */
export interface AgentBrowserView {
  settings: BrowserOperationSettings
  overrides: AgentBrowserOverride[]
  updatedAt: string | null
  updatedBy: string | null
  /** Newest first, at most 20. */
  history: AgentBrowserChange[]
  /**
   * Each registered domain's 「詳しい設定」 that is set and valid now (redesign step ②, agent-browser.md "A
   * domain's parts and login helpers"); a domain absent here uses what the app carries, if anything. Absent
   * from an older server (read as none).
   */
  siteParts?: BrowserSiteParts[]
}

/**
 * PUT …/agent-browser/site-parts (owner/admin): one registered domain's 「詳しい設定」, whole. Both lists
 * empty removes it (the domain then uses what the app carries, if anything).
 */
export type AgentBrowserSitePartsInput = BrowserSiteParts

/** The browser part of the caller's policy: the company setting with their override applied. */
export interface AgentBrowserPolicy extends BrowserOperationSettings {
  /** Where `mode` came from. */
  source: 'company' | 'member'
}
