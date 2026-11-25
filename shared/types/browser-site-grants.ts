/**
 * API shapes of 「ブラウザ操作を使える人」 (agent-browser.md "Who may use a site"): who may use which registered site,
 * and how. Generic units only — a domain and a level —: never a site's job, line or map name.
 */
import type { BrowserOperationLevel, BrowserPersonLevel } from '../core/browser-operation'

export type { BrowserOperationLevel, BrowserPersonLevel }

/** GET /browser-site-grants (owner/admin). */
export interface BrowserSiteGrantsView {
  /** The sites the company registered (「ブラウザ操作」's list), in its order: the host and the company's level (the ceiling). */
  sites: Array<{ host: string; level: BrowserOperationLevel }>
  /** The level of a member nobody chose one for (`read`: 見るだけ). */
  defaultLevel: BrowserPersonLevel
  /**
   * The levels chosen for a person on a registered site, set while they are a member this time. A person or site with no
   * entry is at `defaultLevel`. `level` is what was chosen; what applies is that capped by the site's level.
   */
  grants: Array<{ userId: string; host: string; level: BrowserPersonLevel; grantedBy: string; updatedAt: string }>
}

/** PUT /browser-site-grants/:userId (owner/admin): one person × one registered host. Answers the whole view. */
export interface BrowserSiteGrantChange {
  host: string
  level: BrowserPersonLevel
}
