/**
 * The agent policy's `plugins` part as the app reads it (plan C2,
 * plugins.md "Handing packages to the app"): the business plugins' packages
 * the app keeps for a company. Pure; used by the policy store and the package
 * store in main (`electron/features/plugins/`).
 */
import { PLUGIN_PACKAGE_DIR_RE } from '../../shared/core/plugin-package-paths'
import type { DistributedPlugin } from '../../shared/types/plugins'

const FINGERPRINT_RE = /^[0-9a-f]{64}$/
const MAX_PLUGINS = 200

/** The package's folder name (`<id>@<version>`). */
export const pluginPackageName = (p: Pick<DistributedPlugin, 'id' | 'version'>): string => `${p.id}@${p.version}`

/**
 * The policy's `plugins`: undefined when absent (an older server) or when any
 * entry is malformed — the app then changes nothing it keeps, rather than
 * removing packages because of an answer it cannot read.
 */
export function parseDistributedPlugins(value: unknown): DistributedPlugin[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PLUGINS) return undefined
  const out: DistributedPlugin[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const { id, version, fingerprint, use } = item as Record<string, unknown>
    if (typeof id !== 'string' || typeof version !== 'string' || !PLUGIN_PACKAGE_DIR_RE.test(`${id}@${version}`)) return undefined
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return undefined
    if (use !== 'current' && use !== 'pinned') return undefined
    out.push({ id, version, fingerprint, use })
  }
  return out
}
