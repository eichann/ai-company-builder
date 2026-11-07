/**
 * The company's 「使う機能」 (per-company feature switches, owner decisions 2026-11-07;
 * `.claude/rules/records.md` "Features on and off"). Which features exist, their defaults and
 * words: shared/core/features.ts; wire: shared/types/features.ts.
 *
 * - Every member reads them (the app hides what is off; the AI's tools follow them); only owners
 *   and admins change them, one switch at a time (`PUT …/features { feature, on }`).
 * - Nothing stored = every feature on (today's companies see no change). Turning one off deletes
 *   nothing: its records stay readable, 「見るだけ」 — `typeOff` is what the engine and the
 *   service writer ask before any change.
 * - Kept apart from the task settings document so an older admin console's whole-document PUT of
 *   those never turns a feature back on.
 */
import { featuresFrom, parseFeatureChange, typeIsViewOnly, type CompanyFeatures, type FeatureId } from '../../shared/core/features'
import type { FeaturesView } from '../../shared/types/features'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import { hasFullAccess, requireFullAccess, type Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const FEATURES_FORBIDDEN = 'Only owners and admins can change the features'

export interface FeatureServiceDeps {
  companyData: CompanyDataSource
  accounts: AccountDirectory
  clock: Clock
  /** After a switch changed: the company's apps are told to read again (the push channel; no content). */
  changed?: (companyId: string) => void
}

export function createFeatureService(deps: FeatureServiceDeps) {
  const { companyData, accounts, clock } = deps

  /** The features in force for a company (anything unreadable or missing = on). */
  function of(companyId: string): CompanyFeatures {
    const stored = companyData.forCompany(companyId).tasks.features()
    if (!stored) return featuresFrom(null)
    let parsed: unknown = null
    try { parsed = JSON.parse(stored.features) } catch { parsed = null }
    return featuresFrom(parsed)
  }

  function view(member: Member): FeaturesView {
    const stored = companyData.forCompany(member.companyId).tasks.features()
    const by = stored?.updatedBy ?? null
    return {
      features: of(member.companyId),
      canEdit: hasFullAccess(member.role),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: by,
      updatedByName: by ? accounts.byIds([by]).get(by)?.name ?? null : null,
    }
  }

  return {
    of,
    isOn(companyId: string, feature: FeatureId): boolean {
      return of(companyId)[feature]
    },
    /** Records of `type` are 「見るだけ」 now (their feature is off). */
    typeOff(companyId: string, type: string): boolean {
      return typeIsViewOnly(type, of(companyId))
    },

    /** GET …/features (any member). */
    get(member: Member): FeaturesView {
      return view(member)
    },

    /** PUT …/features `{ feature, on }` (owner/admin). Check order: who → body. */
    set(member: Member, body: unknown): Outcome<FeaturesView> {
      const allowed = requireFullAccess(member, FEATURES_FORBIDDEN)
      if (!allowed.ok) return allowed
      const change = parseFeatureChange(body)
      if ('error' in change) return refuse('bad-request', change.error)
      const next = { ...of(member.companyId), [change.feature]: change.on }
      companyData.forCompany(member.companyId).tasks.saveFeatures(JSON.stringify(next), member.userId, clock.now())
      try { deps.changed?.(member.companyId) } catch { /* the apps read again on their own */ }
      return ok(view(member))
    },
  }
}

export type FeatureService = ReturnType<typeof createFeatureService>
