/**
 * Wire shapes of the AI sandbox setting (「AI の囲い」) and of the policy the
 * desktop app fetches (`GET /api/companies/:id/me/agent-policy`). The rules
 * (validation, defaults) are in shared/core/agent-sandbox.ts.
 */
import type { AgentSandboxMode, AgentSandboxSettings } from '../core/agent-sandbox'
import type { AgentBrowserPolicy } from './agent-browser'
import type { BrowserSiteParts } from '../core/browser-site-parts'
import type { BrowserPersonLevel } from '../core/browser-operation'
import type { AgentStopPolicy } from './agent-stop'
import type { DistributedPlugin } from './plugins'
import type { SecondOpinionPolicy } from './second-opinion'

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

/** One registered domain and the caller's own level there (`AgentPolicy.browserLevels`). */
export interface BrowserSiteLevel {
  host: string
  level: BrowserPersonLevel
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
  /**
   * The business plugins' packages the app keeps for this company (plan C2,
   * plugins.md "Handing packages to the app"). Absent from an older server:
   * the app then leaves what it keeps as it is.
   */
  plugins?: DistributedPlugin[]
  /**
   * 「もう一方の AI に聞く」 for this company (second-opinion.ts). Absent from an older server or
   * unreadable: the app treats it as not allowed.
   */
  secondOpinion?: SecondOpinionPolicy
  /**
   * 「ブラウザ操作」 for this member (agent-browser.ts, `.claude/rules/agent-browser.md`).
   * Absent from an older server: the app treats it as off.
   */
  browser?: AgentBrowserPolicy
  /**
   * The registered domains' parts hosts and login helpers the company set (redesign step ②,
   * agent-browser.md "A domain's parts and login helpers"): only while `browser` is on, only valid ones,
   * absent when none. A field of its own so the `browser` part released apps validate keeps its shape;
   * they ignore it. A domain absent here uses what the app carries, if anything.
   */
  browserParts?: BrowserSiteParts[]
  /**
   * The caller's own level on each registered domain (「ブラウザ操作を使える人」, agent-browser.md "Who may
   * use a site"): only while `browser` is on, one entry per listed site, absent when none. The app keeps a
   * site's login on disk only for a level other than `none` (`browserLoginStorage`, agent-browser.md
   * "Keeping a login on disk"); absent (an older server) = not known = memory only. A field of its own,
   * as `browserParts`, so released apps ignore it.
   */
  browserLevels?: BrowserSiteLevel[]
  /**
   * A digest of the plugin trust documents the server hands this company now (plugin-trust.md
   * "P2": roots, its signed list, its freshness document). Only a marker: a new value tells the
   * app to fetch `GET /api/companies/:companyId/plugin-trust`; it vouches for nothing. Absent from
   * an older server or when the operator put no `trust/` folder.
   */
  pluginTrust?: string
}
