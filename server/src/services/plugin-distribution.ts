/**
 * Handing business plugins' packages to the members' apps (plan C2 「配る道」,
 * `.claude/rules/plugins.md` "Handing packages to the app").
 *
 * - `pluginsFor(companyId)`: what the agent policy lists (`GET
 *   /me/agent-policy` → `plugins`, services/agent-policy.ts) — every
 *   **contract-2 business plugin the company turned on** whose package may be
 *   used now (on the shelf for this company, not stopped by the operator, the
 *   fingerprint the company chose), with its v2 fingerprint; plus older
 *   versions some work is pinned to (`pinned`, stored by C5; §5-9). The
 *   operator's stop overrides a pin: a stopped version is never listed, so the
 *   apps remove it. A plugin turned off lists nothing (its pins neither).
 *   Contract-1 packages and connectors have nothing for the app.
 * - `packageFor(member, pluginId, version)`: any member of the company, only a
 *   version `pluginsFor` lists now (anything else is the same 404 as a plugin
 *   that exists nowhere); the files are read from disk again and handed out
 *   only when their fingerprint is still the listed one (a package replaced
 *   on the shelf under the same version → 409 `PACKAGE_CHANGED`).
 *
 * Nothing here writes. The operator's stop file is read on every call, like
 * every other plugin call.
 */
import { PLUGIN_CONTRACT_V2, comparePluginVersions } from '../../shared/core/plugins'
import type { DistributedPlugin, PluginPackageDownload } from '../../shared/types/plugins'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import type { PluginShelf } from './plugin-shelf'
import { PLUGIN_NOT_FOUND } from './plugin-service-common'

export const PACKAGE_CHANGED = { error: 'この版の中身が変わっています。運用担当者に確かめてもらってください', code: 'PACKAGE_CHANGED' } as const

export interface PluginDistributionDeps {
  companyData: CompanyDataSource
  shelf: PluginShelf
  /**
   * The versions (with their fingerprints) some work of the company is pinned
   * to (plugin-steps.md; C5 stores the pins and binds this). Not bound = no
   * work is pinned yet.
   */
  pinnedVersions?: (companyId: string, pluginId: string) => Array<{ version: string; fingerprint: string }>
}

export function createPluginDistribution(deps: PluginDistributionDeps) {
  const { companyData, shelf } = deps

  /** The version's shelf fingerprint when it may be handed out now, else null. */
  async function usable(companyId: string, pluginId: string, version: string, fingerprint: string): Promise<string | null> {
    const found = shelf.find(companyId, pluginId, version)
    if (!found) return null
    const m = found.pkg.manifest
    if (m.role !== 'business' || m.contract < PLUGIN_CONTRACT_V2) return null
    if (found.fingerprint !== fingerprint) return null
    if (await shelf.isStopped(pluginId, version)) return null
    return found.fingerprint
  }

  async function pluginsFor(companyId: string): Promise<DistributedPlugin[]> {
    const out: DistributedPlugin[] = []
    for (const install of companyData.forCompany(companyId).plugins.installs()) {
      if (!install.enabled) continue
      const current = await usable(companyId, install.pluginId, install.version, install.fingerprint)
      if (current) out.push({ id: install.pluginId, version: install.version, fingerprint: current, use: 'current' })
      const seen = new Set([install.version])
      for (const pin of deps.pinnedVersions?.(companyId, install.pluginId) ?? []) {
        if (seen.has(pin.version)) continue
        seen.add(pin.version)
        const pinned = await usable(companyId, install.pluginId, pin.version, pin.fingerprint)
        if (pinned) out.push({ id: install.pluginId, version: pin.version, fingerprint: pinned, use: 'pinned' })
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : comparePluginVersions(a.version, b.version)))
  }

  return {
    pluginsFor,

    /** GET …/plugins/:pluginId/package/:version — any member; only a version the policy lists now. */
    async packageFor(member: Member, pluginId: string, version: string): Promise<Outcome<PluginPackageDownload>> {
      const notFound = refuse('not-found', PLUGIN_NOT_FOUND.error, { code: PLUGIN_NOT_FOUND.code })
      if (typeof pluginId !== 'string' || typeof version !== 'string' || pluginId.length > 40 || version.length > 20) return notFound
      const listed = (await pluginsFor(member.companyId)).find(p => p.id === pluginId && p.version === version)
      if (!listed) return notFound
      const read = await shelf.files(member.companyId, pluginId, version)
      if (!read || read.fingerprintV2 !== listed.fingerprint) return refuse('conflict', PACKAGE_CHANGED.error, { code: PACKAGE_CHANGED.code })
      return ok({
        id: pluginId, version, fingerprint: listed.fingerprint,
        files: read.files.map(f => ({ path: f.path, base64: Buffer.from(f.bytes).toString('base64') })),
      })
    },
  }
}

export type PluginDistribution = ReturnType<typeof createPluginDistribution>
