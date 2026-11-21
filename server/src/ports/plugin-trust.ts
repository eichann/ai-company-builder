/**
 * Plugin trust documents as the operator placed them (`<PLUGINS_DIR>/trust/`,
 * `.claude/rules/plugin-trust.md` "P2"): read only, never written by the api.
 */
import type { CompanyTrustTexts } from '../../shared/core/plugin-trust-distribution'

export interface PluginTrustFiles {
  /**
   * The root files and this one company's list and freshness document, as
   * texts, read again on every call. Null when no `trust/` folder is set up
   * (no `PLUGINS_DIR`, or no `trust/` in it). A file that cannot be read is
   * left out (null / not in `roots`) and named in `problems` (path only).
   */
  read(companyId: string): Promise<(CompanyTrustTexts & { problems: string[] }) | null>
}
