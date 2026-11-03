/**
 * The business plugins' packages this app keeps (plan C2, plugins.md
 * "Handing packages to the app"), under `<userData>/plugins/<id>@<version>/`.
 *
 * `sync(companyId, plugins)` runs with each agent-policy answer that lists
 * `plugins` (services/agent-policy-store.ts `onPolicy`): every listed version
 * that is missing (or kept with another fingerprint) is fetched and verified
 * (`fetch.ts`: package paths only, fingerprint v2 equal to the policy's) into
 * a temporary folder, then moved into place; a folder no company of any
 * account on this computer lists any more (turned off, or a version the
 * operator stopped — the stop overrides pins) is removed. Older versions the
 * policy lists as `pinned` (work pinned to them, C5) are kept like the current
 * one.
 *
 * `index.json` remembers, per account and company, what was listed and, per
 * folder, the fingerprint it was verified against; nothing else is written
 * outside the package folders. Syncs run one at a time. A failed fetch keeps
 * nothing unverified and is retried at the next policy answer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLUGIN_PACKAGE_DIR_RE } from '../../../../shared/core/plugin-package-paths'
import type { DistributedPlugin } from '../../../../shared/types/plugins'
import { pluginPackageName } from '../../../shared/plugin-packages'
import type { FetchPluginPackage, PackageFile } from './fetch'

export interface PluginStoreDeps {
  /** `<userData>/plugins`. */
  dir: () => string
  /** The signed-in account; nothing is kept without one. */
  userId: () => string | null
  fetchPackage: FetchPluginPackage
  /** What this company lists and the app keeps changed (a package came, went or was replaced): its screens change (A6). */
  onChanged?: (companyId: string) => void
  log?: Pick<Console, 'warn' | 'info'>
}

interface StoreIndex {
  /** `${user}\0${company}` → the package names that company listed last. */
  listed: Record<string, string[]>
  /** Package name → the fingerprint its folder was verified against. */
  kept: Record<string, string>
}

const INDEX_FILE = 'index.json'
const INCOMING_PREFIX = '.incoming-'

export function createPluginPackageStore(deps: PluginStoreDeps) {
  const log = deps.log ?? console
  let chain: Promise<void> = Promise.resolve()

  const indexPath = () => path.join(deps.dir(), INDEX_FILE)
  function readIndex(): StoreIndex {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as Partial<StoreIndex>
      const listed: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(raw.listed ?? {})) if (Array.isArray(v)) listed[k] = v.filter(n => typeof n === 'string' && PLUGIN_PACKAGE_DIR_RE.test(n))
      const kept: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw.kept ?? {})) if (PLUGIN_PACKAGE_DIR_RE.test(k) && typeof v === 'string') kept[k] = v
      return { listed, kept }
    } catch {
      return { listed: {}, kept: {} }
    }
  }
  function writeIndex(index: StoreIndex): void {
    fs.mkdirSync(deps.dir(), { recursive: true, mode: 0o700 })
    const tmp = `${indexPath()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 })
    fs.renameSync(tmp, indexPath())
  }

  /** Write the verified files into a fresh folder, then put it in place of `<name>`. */
  function place(name: string, files: PackageFile[]): void {
    const root = deps.dir()
    const incoming = path.join(root, `${INCOMING_PREFIX}${randomUUID()}`)
    fs.mkdirSync(incoming, { recursive: true, mode: 0o700 })
    try {
      for (const f of files) {
        // The path was checked against the package grammar (fetch.ts); resolve once more to stay inside.
        const target = path.resolve(incoming, ...f.path.split('/'))
        if (!target.startsWith(incoming + path.sep)) throw new Error('a path outside the package')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, f.bytes)
      }
      const final = path.join(root, name)
      fs.rmSync(final, { recursive: true, force: true })
      fs.renameSync(incoming, final)
    } catch (error) {
      fs.rmSync(incoming, { recursive: true, force: true })
      throw error
    }
  }

  async function run(companyId: string, plugins: DistributedPlugin[]): Promise<void> {
    const user = deps.userId()
    if (!user) return
    const root = deps.dir()
    const index = readIndex()
    const key = `${user}\0${companyId}`
    const keptHere = () => (index.listed[key] ?? []).filter(n => index.kept[n] !== undefined).map(n => `${n}=${index.kept[n]}`).sort().join('\n')
    const before = keptHere()
    index.listed[key] = plugins.map(pluginPackageName)

    for (const entry of plugins) {
      const name = pluginPackageName(entry)
      if (index.kept[name] === entry.fingerprint && fs.existsSync(path.join(root, name, 'plugin.yaml'))) continue
      const got = await deps.fetchPackage(companyId, entry)
      if (!got.ok) {
        log.warn(`[plugins] ${name}: not kept (${got.reason})`)
        // Never keep a folder that no longer matches what the company chose.
        if (index.kept[name] !== undefined && index.kept[name] !== entry.fingerprint) {
          fs.rmSync(path.join(root, name), { recursive: true, force: true })
          delete index.kept[name]
        }
        continue
      }
      try {
        place(name, got.files)
        index.kept[name] = entry.fingerprint
        log.info(`[plugins] ${name}: kept`)
      } catch (error) {
        log.warn(`[plugins] ${name}: could not be written (${error instanceof Error ? error.message : 'unknown'})`)
      }
    }

    // Remove what no company lists any more, and anything else left in the folder.
    const wanted = new Set(Object.values(index.listed).flat())
    for (const name of Object.keys(index.kept)) {
      if (wanted.has(name)) continue
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      delete index.kept[name]
      log.info(`[plugins] ${name}: removed`)
    }
    let entries: string[] = []
    try { entries = fs.readdirSync(root) } catch { /* nothing there */ }
    for (const entry of entries) {
      if (entry === INDEX_FILE || entry.startsWith(`${INDEX_FILE}.`) || index.kept[entry] !== undefined) continue
      fs.rmSync(path.join(root, entry), { recursive: true, force: true })
    }
    writeIndex(index)
    if (keptHere() !== before) deps.onChanged?.(companyId)
  }

  return {
    /** Keep exactly what this company's policy lists (one sync at a time). */
    sync(companyId: string, plugins: DistributedPlugin[]): Promise<void> {
      const next = chain.then(() => run(companyId, plugins)).catch((error: unknown) => {
        log.warn(`[plugins] ${companyId}: keeping the packages failed (${error instanceof Error ? error.message : 'unknown'})`)
      })
      chain = next
      return next
    },
    /** Settles when the syncs started so far have finished. */
    idle(): Promise<void> {
      return chain
    },
    /**
     * The folder of a package this company lists now and the app keeps, or
     * null (for the steps that run from it, C5).
     */
    folderOf(companyId: string, pluginId: string, version: string): string | null {
      const user = deps.userId()
      if (!user) return null
      const name = pluginPackageName({ id: pluginId, version })
      const index = readIndex()
      if (!index.listed[`${user}\0${companyId}`]?.includes(name) || index.kept[name] === undefined) return null
      return path.join(deps.dir(), name)
    },
    /**
     * A kept package with the fingerprint it was verified against, when a
     * company of the signed-in account lists it now (`companyId`: that
     * company only), else null — for the plugin screens' protocol and bridge
     * (A5, plugin-frame.md), which verify the folder against the fingerprint
     * again before serving anything from it.
     */
    keptPackage(pluginId: string, version: string, companyId?: string): { folder: string; fingerprint: string } | null {
      const user = deps.userId()
      if (!user) return null
      const name = pluginPackageName({ id: pluginId, version })
      if (!PLUGIN_PACKAGE_DIR_RE.test(name)) return null
      const index = readIndex()
      const fingerprint = index.kept[name]
      if (fingerprint === undefined) return null
      const listed = Object.entries(index.listed).some(([key, names]) =>
        (companyId === undefined ? key.startsWith(`${user}\0`) : key === `${user}\0${companyId}`) && names.includes(name))
      return listed ? { folder: path.join(deps.dir(), name), fingerprint } : null
    },
  }
}

export type PluginPackageStore = ReturnType<typeof createPluginPackageStore>
