/**
 * Plugin trust documents as the operator placed them (`<PLUGINS_DIR>/trust/`,
 * `.claude/rules/plugin-trust.md` "P2"): read only, never written by the api.
 */
import type { CompanyTrustTexts } from '../../shared/core/plugin-trust-distribution'

export interface PluginTrustFiles {
  /**
   * The root files and this one company's list and freshness document, as
   * texts. Null when no `trust/` folder is set up (no `PLUGINS_DIR`, or no
   * `trust/` in it). A file or folder that cannot be read safely is left out
   * (null / not in `roots`) and named in `problems` (path only).
   */
  read(companyId: string): Promise<(CompanyTrustTexts & { problems: string[] }) | null>
  /**
   * What those places look like now without reading them (which folder `trust`
   * points at, and each place's inode, size and time): equal stamps → `read`
   * would give the same texts, so the answer may be reused.
   */
  stamp(companyId: string): Promise<string>
}
