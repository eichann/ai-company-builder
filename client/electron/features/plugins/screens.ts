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
import type { DistributedPlugin } from '../../../../shared/types/plugins'
import type { PluginPackageRef } from '../../../shared/plugin-bridge'
import { screensOfPackage, type PluginScreens, type PluginScreensResult } from '../../../shared/plugin-screens'
import type { IpcRegistrar } from '../../ipc/registrar'

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
