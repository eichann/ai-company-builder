import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { PluginPackageRef } from '../../../shared/plugin-bridge'

/** One call of a plugin screen's bridge, sent by main with the member's session (plugin-frame.md). */
export type PluginBridgePort = ElectronPort<'callPluginBridge'>

export function callPluginBridge(companyId: string, plugin: PluginPackageRef, op: string, args: unknown, port: PluginBridgePort = window.electronAPI) {
  return port.callPluginBridge(companyId, plugin, op, args)
}
