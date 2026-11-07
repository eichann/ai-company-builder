/**
 * Wire shape of the company's 「使う機能」 (feature switches, owner decisions 2026-11-07). The
 * rules (features, defaults, words, what each owns) are in shared/core/features.ts.
 */
import type { CompanyFeatures } from '../core/features'

/**
 * GET /api/companies/:id/features (every member) and PUT { feature, on } (owner/admin). The same
 * `features` also rides on `GET /records/types` (session and the AI's token), where an older app
 * ignores it and a newer app reads it missing (an older server) as everything on.
 */
export interface FeaturesView {
  features: CompanyFeatures
  /** The caller may change them (owner/admin). */
  canEdit: boolean
  /** null while the company never changed a switch. */
  updatedAt: string | null
  updatedBy: string | null
  updatedByName: string | null
}
