/**
 * Wire shapes of the browser-operation setting (「ブラウザ操作」) and of its part
 * of the policy the desktop app fetches (`GET /api/companies/:id/me/agent-policy`).
 * The rules (validation, defaults, the request rule) are in
 * shared/core/browser-operation.ts; the server and admin pieces are listed in
 * .claude/rules/agent-browser.md.
 */
import type { BrowserOperationMode, BrowserOperationSettings } from '../core/browser-operation'

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
}

/** GET|PUT …/agent-browser (owner/admin). */
export interface AgentBrowserView {
  settings: BrowserOperationSettings
  overrides: AgentBrowserOverride[]
  updatedAt: string | null
  updatedBy: string | null
  /** Newest first, at most 20. */
  history: AgentBrowserChange[]
}

/** The browser part of the caller's policy: the company setting with their override applied. */
export interface AgentBrowserPolicy extends BrowserOperationSettings {
  /** Where `mode` came from. */
  source: 'company' | 'member'
}
