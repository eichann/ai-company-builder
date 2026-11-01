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
 * Business plugins own types, connectors map to one business plugin version
 * (`maps_to`, owner decision 2026-11-01): business packages are read first,
 * and a connector whose business version is not on the shelf is refused (a
 * connector of the old shape, with its own types — hubspot@0.1.x — is
 * refused too: its install shows `not-on-shelf` until a new version is chosen).
 */
import { mapsToName, parsePluginManifest, pluginAvailableTo, validatePluginPackage, type PluginPackage } from '../../shared/core/plugins'
import type { PluginShelfSource } from '../ports/plugins'

export interface ShelfPackage {
  pkg: PluginPackage
  fingerprint: string
  /** The package's recommended mapping as written (a company's first mapping version), or null. */
  recommendedMapping: string | null
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
}

const compareVersions = (a: string, b: string) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

const nameOf = (p: ShelfPackage) => `${p.pkg.manifest.id}@${p.pkg.manifest.version}`

export function createPluginShelf(source: PluginShelfSource): PluginShelf {
  let packages: ShelfPackage[] = []

  /**
   * `available_to` (§8-4) — and a connector only where the business plugin it
   * maps to is usable too (it cannot run without that plugin's types).
   */
  const usableBy = (p: ShelfPackage, companyId: string): boolean => {
    if (!pluginAvailableTo(p.pkg.manifest, companyId)) return false
    const wanted = mapsToName(p.pkg.manifest)
    return wanted === null || packages.some(b => nameOf(b) === wanted && pluginAvailableTo(b.pkg.manifest, companyId))
  }

  return {
    async load() {
      const scan = await source.scan()
      const next: ShelfPackage[] = []
      const refused = [...scan.problems]
      // Business plugins first: a connector is checked against the exact business version it maps to.
      const ordered = scan.packages.map(files => ({ files, parsed: parsePluginManifest(files.manifest) }))
        .sort((a, b) => Number(a.parsed.ok && a.parsed.value.role === 'connector') - Number(b.parsed.ok && b.parsed.value.role === 'connector'))
      for (const { files, parsed } of ordered) {
        const wanted = parsed.ok ? mapsToName(parsed.value) : null
        const business = wanted ? next.find(p => nameOf(p) === wanted)?.pkg ?? null : null
        const checked = validatePluginPackage({ manifest: files.manifest, types: files.types, mapping: files.mapping, business })
        if (!checked.ok) { refused.push({ dir: files.dir, reason: checked.errors.slice(0, 3).join(' / ') }); continue }
        const m = checked.value.manifest
        if (files.dir !== `${m.id}@${m.version}`) { refused.push({ dir: files.dir, reason: `the folder must be named ${m.id}@${m.version}` }); continue }
        next.push({ pkg: checked.value, fingerprint: files.fingerprint, recommendedMapping: files.mapping })
      }
      next.sort((a, b) => a.pkg.manifest.id.localeCompare(b.pkg.manifest.id) || compareVersions(a.pkg.manifest.version, b.pkg.manifest.version))
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
  }
}
