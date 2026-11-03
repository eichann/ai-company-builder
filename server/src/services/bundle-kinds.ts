/**
 * 束ねる種類 (bundle kinds, owner decision 2026-11-02, records.md "Bundle kinds"): which kind of
 * 束ねるもの each department makes, decided without a setting.
 *
 * - A department where a business plugin's kind lives — an enabled business plugin's type that
 *   implements `bundle` (案件 `deal`, 番組…) — makes that kind. "Lives" = the plugin's mapping
 *   places that type's records at or under the department folder (`visible_to_folder` of an
 *   object whose `record_type` it is), or live records of that type are there already.
 * - Any other department makes the core's ordinary kind (`project`), under the company's name for
 *   it (`TaskSettings.bundleName`, default 「プロジェクト」).
 * - There is no "use both" setting: when two business kinds live in one department, the one with
 *   more signals (then the type name) is that department's.
 *
 * The name of a kind is never 「まとまり」: that word is the code's (`bundle`).
 */
import { CORE_BUNDLE_TYPE } from '../../shared/core/core-types'
import { isSameOrAncestorPath, normalizeRepoPath } from '../../shared/core/paths'
import type { TaskSettings } from '../../shared/core/task-settings'
import { isYamlMap, parseYamlLite } from '../../shared/core/yaml-lite'
import type { BundleKind, BundleKindsResult } from '../../shared/types/records'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { currentTypes } from './record-index'
import { RECORDS_DISABLED } from './records'
import type { PluginShelf } from './plugin-shelf'

export interface BundleKindDeps {
  companyData: CompanyDataSource
  shelf: Pick<PluginShelf, 'find'>
  settingsOf: (companyId: string) => Pick<TaskSettings, 'bundleName'>
}

/** Most records of one type read to see which departments it lives in. */
const MAX_RECORDS_PER_TYPE = 5000

/** `visible_to_folder` of each mapping object, as written (the mapping's own parser needs the connector's package). */
function mappingPlaces(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const parsed = parseYamlLite(text)
  if (!parsed.ok || !isYamlMap(parsed.value) || !isYamlMap(parsed.value.objects)) return out
  for (const [object, o] of Object.entries(parsed.value.objects)) {
    if (!isYamlMap(o) || typeof o.visible_to_folder !== 'string') continue
    const p = normalizeRepoPath(o.visible_to_folder)
    if (p && !p.startsWith('.')) out.set(object, p)
  }
  return out
}

export function createBundleKinds(deps: BundleKindDeps) {
  const { companyData } = deps

  /** Every business plugin bundle type of the company, with the places its records live. */
  function businessBundles(companyId: string): Array<{ type: string; label: string; places: string[] }> {
    const handle = companyData.forCompany(companyId)
    const inForce = currentTypes(handle.records)
    const out: Array<{ type: string; label: string; places: string[] }> = []
    for (const install of handle.plugins.installs()) {
      if (!install.enabled) continue
      const pkg = deps.shelf.find(companyId, install.pluginId, install.version)?.pkg
      // A business plugin (a connector has a service and owns no types).
      if (!pkg || pkg.manifest.service !== '') continue
      const mapping = install.mappingVersion > 0 ? handle.plugins.mapping(install.pluginId, install.mappingVersion) : null
      const placed = mapping ? mappingPlaces(mapping.text) : new Map<string, string>()
      for (const [type, def] of Object.entries(pkg.types)) {
        // The definition in force decides (a company's own extension of it counts too).
        const now = inForce.get(type)?.definition ?? def
        if (!now.implements.includes('bundle')) continue
        const places: string[] = []
        for (const [object, use] of Object.entries(pkg.manifest.uses?.objects ?? {})) {
          const p = use.recordType === type ? placed.get(object) : undefined
          if (p) places.push(p)
        }
        for (const r of handle.records.candidates({ types: [type] }, MAX_RECORDS_PER_TYPE)) {
          if (r.folder) places.push(r.folder)
        }
        out.push({ type, label: now.label, places })
      }
    }
    return out
  }

  return {
    /**
     * GET /records/bundle-kinds — any member: the core's kind under the company's name, each
     * department's kind (what 「新しい〇〇にする」「〇〇につなぐ」 make and say there) and every
     * kind in use (for the places where kinds mix: the company-wide list, searching across
     * departments).
     */
    kinds(member: Member): Outcome<BundleKindsResult> {
      const handle = companyData.forCompany(member.companyId)
      if (!handle.records.settings().enabled) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const core: BundleKind = { type: CORE_BUNDLE_TYPE, name: deps.settingsOf(member.companyId).bundleName, source: 'core' }
      const business = businessBundles(member.companyId)
      const departments = handle.departments.list().map(d => {
        let best: { type: string; label: string; count: number } | null = null
        for (const b of business) {
          const count = b.places.filter(p => isSameOrAncestorPath(d.folder, p)).length
          if (count === 0) continue
          if (!best || count > best.count || (count === best.count && b.type < best.type)) best = { type: b.type, label: b.label, count }
        }
        const kind: BundleKind = best ? { type: best.type, name: best.label, source: 'plugin' } : core
        return { departmentId: d.id, folder: d.folder, kind }
      })
      const kinds: BundleKind[] = []
      for (const k of [...departments.map(d => d.kind), ...business.map(b => ({ type: b.type, name: b.label, source: 'plugin' as const }))]) {
        if (!kinds.some(x => x.type === k.type)) kinds.push(k)
      }
      if (!kinds.some(k => k.type === core.type)) kinds.push(core)
      return ok({ core, departments, kinds })
    },
  }
}

export type BundleKindService = ReturnType<typeof createBundleKinds>
