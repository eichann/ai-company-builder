// A business plugin's screens for the app's four slots (stage 4b, plan A6, plugin-frame.md
// "The four slots"):
//   plugins:screens   the screens of the plugins a company lists now and this app keeps, verified
//
// Read from each kept package's own `plugin.yaml` through the same check as every file the frame
// is served (protocol.ts: listed for this company now, the folder equal to its fingerprint), so a
// plugin turned off, a version the operator stopped (no longer listed) or a folder that does not
// match shows no slot. Only the `current` version of each plugin has screens; a `pinned` one is
// kept for the steps of older work only. Only the main window may ask.

import { COMPANY_ID_RE } from '../../../../shared/core/plugin-declaration-rules'
import { PLUGIN_CONTRACT_V2 } from '../../../../shared/core/plugin-declaration'
import { parsePluginManifest } from '../../../../shared/core/plugin-manifest'
import type { DistributedPlugin } from '../../../../shared/types/plugins'
import type { PluginPackageRef } from '../../../shared/plugin-bridge'
import { APP_BRIDGE_VERSION } from '../../../shared/plugin-bridge-ops'
import type { PluginScreens, PluginScreensResult } from '../../../shared/plugin-screens'
import type { IpcRegistrar } from '../../ipc/registrar'

/**
 * The screens of one kept package, from its verified declaration and file
 * list. Only a contract-2 business plugin whose declaration names this package
 * (same id and version), declares `ui` with a bridge version this app speaks,
 * and whose every frame entry is a file of the verified package has any;
 * anything else answers null (no slot).
 */
export function screensOfPackage(ref: PluginPackageRef, manifestText: string, files: ReadonlySet<string>): PluginScreens | null {
  const parsed = parsePluginManifest(manifestText)
  if (!parsed.ok) return null
  const m = parsed.value
  if (m.role !== 'business' || m.contract !== PLUGIN_CONTRACT_V2 || !m.ui || m.ui.bridge !== APP_BRIDGE_VERSION) return null
  if (m.id !== ref.id || m.version !== ref.version) return null
  const ui = m.ui
  const entries = [...(ui.tab ? [ui.tab.entry] : []), ...ui.recordSections.map(s => s.entry), ...ui.fileActions.map(a => a.entry)]
  // The shelf checked this already; a kept folder that lacks one is not the package the company chose.
  if (entries.some(e => !files.has(e))) return null
  return { plugin: { id: m.id, version: m.version }, label: m.label, tab: ui.tab, peek: ui.peek, recordSections: ui.recordSections, fileActions: ui.fileActions }
}

export interface PluginScreensDeps {
  /** What the company's agent policy lists now (asked of the server when nothing is known yet); null = unknown. */
  listed: (companyId: string) => Promise<DistributedPlugin[] | null>
  /** Settles when the packages being fetched are kept (or not). */
  settled: () => Promise<void>
  /** A kept package's verified declaration and files for this company, or null (protocol.ts `declaration`). */
  declaration: (companyId: string, ref: PluginPackageRef) => Promise<{ manifest: string; files: Set<string> } | null>
  isMainWindow: (senderId: number) => boolean
  settleTimeoutMs?: number
}

export function createPluginScreens(deps: PluginScreensDeps) {
  return {
    async list(companyId: unknown): Promise<PluginScreensResult> {
      if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) return { success: false, error: '入力が正しくありません。' }
      const listed = (await deps.listed(companyId))?.filter(p => p.use === 'current') ?? []
      if (listed.length === 0) return { success: true, screens: [] }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([deps.settled(), new Promise<void>(resolve => { timer = setTimeout(resolve, deps.settleTimeoutMs ?? 10_000) })])
      clearTimeout(timer)
      const screens: PluginScreens[] = []
      for (const p of listed) {
        const ref = { id: p.id, version: p.version }
        const kept = await deps.declaration(companyId, ref)
        const s = kept ? screensOfPackage(ref, kept.manifest, kept.files) : null
        if (s) screens.push(s)
      }
      return { success: true, screens }
    },
  }
}

export function registerPluginScreensIpc(ipc: IpcRegistrar, deps: PluginScreensDeps) {
  const screens = createPluginScreens(deps)
  ipc.handle('plugins:screens', (event, companyId) => {
    if (!deps.isMainWindow(event.sender.id)) return { success: true, screens: [] }
    return screens.list(companyId)
  })
}
