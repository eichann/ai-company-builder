/**
 * 「ブラウザ操作を使える人」: who may use which registered site, and how (step ① of the redesign; agent-browser.md "Who may
 * use a site"; design memo §3 I5 / I10, §10, §11, §13 D4). The units are generic — the host the company registered and a
 * level (`none` 使わない / `read` 見るだけ / `write` 変えてよい) — so nothing of a site's jobs reaches any company's screen.
 *
 * Invariants (each tested in tests/unit/browser-site-grants.test.ts):
 * - a person's level counts only for a host the company registered now (its setting's list) and only while they are a
 *   member: a row written before they joined this time is not theirs (the default applies), one who left has nothing;
 * - no row = `read` (owner decision D4: everyone starts at 見るだけ once the site is registered); `write` only by a row;
 * - the company's level for the host is the ceiling (`browserPersonAllows`), and the company's mode with the member's own
 *   override must be on (the setting's rule, as before);
 * - owners and admins follow the same table (no implicit 変えてよい);
 * - only owners / admins read or change the table; a change names a member and a registered host exactly.
 * The rule itself is `shared/core/browser-operation.ts` (`browserPersonAllows`), so the admin console shows the same cap.
 */
import {
  BROWSER_PERSON_DEFAULT_LEVEL, browserPersonAllows, isBrowserPersonLevel, levelAllows, normalizeBrowserHost,
  type BrowserOperationEffect, type BrowserOperationSettings, type BrowserPersonLevel,
} from '../../shared/core/browser-operation'
import type { BrowserSiteGrantsView } from '../../shared/types/browser-site-grants'
import type { BrowserSiteGrantRepository } from '../ports/browser-lines'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { MembershipRepository } from '../ports/memberships'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export interface BrowserSiteGrantDeps {
  companyData: CompanyDataSource
  clock: Clock
  memberships: Pick<MembershipRepository, 'roleOf' | 'joinedAt'>
  /** The member's browser setting now (the company's with their own mode). */
  browserPolicy: (member: Pick<Member, 'companyId' | 'userId'>) => BrowserOperationSettings
  /**
   * A person's level changed: their policy carries it (`browserLevels`, agent-browser.md "Keeping a login on disk"),
   * so the company's apps are told a new version (agent-policy.ts `announce`).
   */
  onChange?: (companyId: string) => void
}

export const BROWSER_SITE_GRANT_WORDS = {
  manageForbidden: 'ブラウザ操作を使える人を変えられるのは、オーナーと管理者だけです',
  memberNotFound: 'Member not found',
  badChange: '変更の形が正しくありません',
  notRegistered: 'このサイトは、会社のブラウザ操作に登録されていません',
  aboveSite: 'このサイトは会社の設定が「見るだけ」なので、「変えてよい」にはできません',
} as const
const W = BROWSER_SITE_GRANT_WORDS

export function createBrowserSiteGrants(deps: BrowserSiteGrantDeps) {
  const repo = (companyId: string): BrowserSiteGrantRepository => deps.companyData.forCompany(companyId).browserLines

  /** The person's own level on this host now (not yet capped by the site's level). */
  function personLevel(companyId: string, userId: string, host: string): BrowserPersonLevel {
    const joined = deps.memberships.joinedAt(companyId, userId)
    if (typeof joined !== 'string') return 'none'
    const row = repo(companyId).siteGrantOf(userId, host)
    if (!row || row.updatedAt < joined) return BROWSER_PERSON_DEFAULT_LEVEL
    return isBrowserPersonLevel(row.level) ? row.level : 'none'
  }

  function view(member: Member): BrowserSiteGrantsView {
    const sites = deps.browserPolicy(member).sites.map(s => ({ host: s.host, level: s.level }))
    const hosts = new Set(sites.map(s => s.host))
    const grants: BrowserSiteGrantsView['grants'] = []
    for (const g of repo(member.companyId).siteGrants()) {
      if (!hosts.has(g.host) || !isBrowserPersonLevel(g.level)) continue
      const joined = deps.memberships.joinedAt(member.companyId, g.userId)
      if (typeof joined !== 'string' || g.updatedAt < joined) continue
      grants.push({ userId: g.userId, host: g.host, level: g.level, grantedBy: g.grantedBy, updatedAt: g.updatedAt })
    }
    return { sites, defaultLevel: BROWSER_PERSON_DEFAULT_LEVEL, grants }
  }

  return {
    /**
     * May this member let the AI do something with `effect` on `host` now? The company's mode (with their override) on,
     * the host registered, its level allowing the effect, and the person's own level allowing it.
     */
    allows(member: Member, host: string, effect: BrowserOperationEffect): boolean {
      const settings = deps.browserPolicy(member)
      const site = settings.sites.find(s => s.host === host)
      if (settings.mode !== 'on' || !site) return false
      return browserPersonAllows(personLevel(member.companyId, member.userId, host), site.level, effect)
    },

    /** GET /browser-site-grants (owner/admin). */
    view(member: Member): Outcome<BrowserSiteGrantsView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', W.manageForbidden)
      return ok(view(member))
    },

    /** PUT /browser-site-grants/:userId { host, level } (owner/admin): one member × one registered host. */
    set(member: Member, userId: string, body: unknown): Outcome<BrowserSiteGrantsView> {
      if (!hasFullAccess(member.role)) return refuse('forbidden', W.manageForbidden)
      if (deps.memberships.roleOf(member.companyId, userId) === null) return refuse('not-found', W.memberNotFound)
      const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
      if (!b || Object.keys(b).some(k => k !== 'host' && k !== 'level') || !isBrowserPersonLevel(b.level) || typeof b.host !== 'string') {
        return refuse('bad-request', W.badChange, { code: 'BROWSER_BAD_SITE_GRANT' })
      }
      const host = normalizeBrowserHost(b.host)
      const site = host === undefined ? undefined : deps.browserPolicy(member).sites.find(s => s.host === host)
      if (!host || !site || host !== b.host) return refuse('bad-request', W.notRegistered, { code: 'BROWSER_SITE_NOT_REGISTERED' })
      if (b.level === 'write' && !levelAllows(site.level, 'write')) return refuse('conflict', W.aboveSite, { code: 'BROWSER_SITE_LEVEL_ABOVE_SITE' })
      repo(member.companyId).saveSiteGrant({ userId, host, level: b.level, grantedBy: member.userId, updatedAt: deps.clock.now() })
      deps.onChange?.(member.companyId)
      return ok(view(member))
    },

    /**
     * The member's own level on each registered domain, while their browser part is on (none otherwise): what their
     * policy carries as `browserLevels`, so the app keeps a login on disk only where they may use the site.
     */
    levelsFor(member: Pick<Member, 'companyId' | 'userId'>): Array<{ host: string; level: BrowserPersonLevel }> {
      const settings = deps.browserPolicy(member)
      if (settings.mode !== 'on') return []
      return settings.sites.map(s => ({ host: s.host, level: personLevel(member.companyId, member.userId, s.host) }))
    },

    /**
     * In the company setting's save transaction (services/agent-browser.ts): writing is no longer allowed on these hosts
     * (removed, or lowered to 見るだけ), so every 変えてよい there goes — raising the site or registering it again later
     * never brings one back unseen. 使わない / 見るだけ rows stay.
     */
    writeNoLongerAllowed(companyId: string, hosts: readonly string[]): void {
      for (const host of hosts) repo(companyId).removeSiteWriteGrants(host)
    },

    /** In removeMember's transaction: their rows go (invited back, they start from the default). */
    memberLeft(companyId: string, userId: string): void {
      repo(companyId).removeSiteGrantsOf(userId)
    },
  }
}

export type BrowserSiteGrants = ReturnType<typeof createBrowserSiteGrants>
