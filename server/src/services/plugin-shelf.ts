/**
 * The plugin shelf (「プラグインの棚」, `.claude/rules/plugins.md`): the
 * packages the operator (div) put in `PLUGINS_DIR`, read at startup, each
 * validated with the core's one copy of the rules (`validatePluginPackage`)
 * and kept with its fingerprint. A package that does not pass — or whose
 * folder is not named `<id>@<version>` of its declaration — is not used, and
 * the reason is logged (the folder name and the rule's sentence, never the
 * file's content).
 *
 * Shared by every company and read only: it holds no company's data. What a
 * company may see is filtered by the declaration's `available_to`
 * (`pluginAvailableTo`, owner rule §8-4): a package listed for other
 * companies does not exist for this one, in any answer.
 *
 * Connectors and business plugins are read on their own (owner decision
 * 2026-11-01): a connector knows no business plugin, and a business plugin
 * names the connector it can use (`connector: hubspot >= 0.3.0`), joined per
 * company when it runs (`combineUse`). Old shapes are refused with the reason
 * (a connector with its own types — hubspot@0.1.x — or with `maps_to` —
 * hubspot@0.2.0): an install of one shows `not-on-shelf` until a new version
 * is chosen.
 *
 * Contract 2 (plan C1): the package's `steps/` and `ui/` are checked with the
 * declaration, its fingerprint is v2 (`shared/core/plugin-fingerprint.ts`;
 * contract 1 keeps v1, so existing installs keep matching), and its signature
 * slot is read for shape only — kept as `signature`, never verified or
 * trusted here.
 */
import {
  PLUGIN_CONTRACT_V2, comparePluginVersions, parsePluginSignature, pluginAvailableTo, validatePluginPackage,
  type PluginPackage, type PluginSignature,
} from '../../shared/core/plugins'
import type { PluginShelfSource } from '../ports/plugins'

export interface ShelfPackage {
  pkg: PluginPackage
  fingerprint: string
  /** The package's recommended mapping as written (a company's first mapping version), or null. */
  recommendedMapping: string | null
  /** Contract 2: `steps/<file>.md` → its text (what the app is handed, C2). */
  steps: Record<string, string>
  /** Contract 2: the paths under `ui/`. */
  ui: string[]
  /** The signature slot, shape-checked only: NOT verified. */
  signature: PluginSignature | null
}

export interface PluginShelf {
  /** (Re)read the shelf; returns what was loaded and what was refused. */
  load(): Promise<{ loaded: string[]; refused: Array<{ dir: string; reason: string }> }>
  /** Every version of every package this company may use, by id then version. */
  packagesFor(companyId: string): ShelfPackage[]
  /** One version of a package, if this company may use it. */
  find(companyId: string, pluginId: string, version: string): ShelfPackage | null
  /** Stopped for every company by the operator (read on every call). */
  isStopped(pluginId: string, version: string): Promise<boolean>
  /**
   * The files of one version this company may use, read from disk now (plan
   * C2), with the v2 fingerprint of what was read — the caller compares it
   * with the one the shelf loaded (a package replaced on disk since is not
   * handed out). Null when not on the shelf for this company or unreadable.
   */
  files(companyId: string, pluginId: string, version: string): Promise<{ files: Array<{ path: string; bytes: Uint8Array }>; fingerprintV2: string } | null>
}

export function createPluginShelf(source: PluginShelfSource): PluginShelf {
  let packages: ShelfPackage[] = []

  /** `available_to` (§8-4). */
  const usableBy = (p: ShelfPackage, companyId: string): boolean => pluginAvailableTo(p.pkg.manifest, companyId)

  return {
    async load() {
      const scan = await source.scan()
      const next: ShelfPackage[] = []
      const refused = [...scan.problems]
      for (const files of scan.packages) {
        const checked = validatePluginPackage({ manifest: files.manifest, types: files.types, mapping: files.mapping, steps: files.steps, ui: files.ui })
        if (!checked.ok) { refused.push({ dir: files.dir, reason: checked.errors.slice(0, 3).join(' / ') }); continue }
        const m = checked.value.manifest
        if (files.dir !== `${m.id}@${m.version}`) { refused.push({ dir: files.dir, reason: `the folder must be named ${m.id}@${m.version}` }); continue }
        let signature: PluginSignature | null = null
        if (files.signature !== null) {
          const sig = parsePluginSignature(files.signature, m)
          if (!sig.ok) { refused.push({ dir: files.dir, reason: sig.errors.slice(0, 3).join(' / ') }); continue }
          signature = sig.value
        }
        next.push({
          pkg: checked.value,
          fingerprint: m.contract >= PLUGIN_CONTRACT_V2 ? files.fingerprintV2 : files.fingerprint,
          recommendedMapping: files.mapping, steps: files.steps, ui: files.ui, signature,
        })
      }
      next.sort((a, b) => a.pkg.manifest.id.localeCompare(b.pkg.manifest.id) || comparePluginVersions(a.pkg.manifest.version, b.pkg.manifest.version))
      packages = next
      return { loaded: next.map(p => `${p.pkg.manifest.id}@${p.pkg.manifest.version}`), refused }
    },
    packagesFor(companyId) {
      return packages.filter(p => usableBy(p, companyId))
    },
    find(companyId, pluginId, version) {
      return packages.find(p => p.pkg.manifest.id === pluginId && p.pkg.manifest.version === version && usableBy(p, companyId)) ?? null
    },
    async isStopped(pluginId, version) {
      const list = await source.stopped()
      return list.includes('*') || list.includes(pluginId) || list.includes(`${pluginId}@${version}`)
    },
    async files(companyId, pluginId, version) {
      const found = packages.find(p => p.pkg.manifest.id === pluginId && p.pkg.manifest.version === version && usableBy(p, companyId))
      if (!found) return null
      return source.files(`${pluginId}@${version}`)
    },
  }
}
