import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { PluginPackageRef } from '../../../shared/plugin-bridge'

/** One call of a plugin screen's bridge, sent by main with the member's session (plugin-frame.md). */
export type PluginBridgePort = ElectronPort<'callPluginBridge'>

export function callPluginBridge(companyId: string, plugin: PluginPackageRef, op: string, args: unknown, port: PluginBridgePort = window.electronAPI) {
  return port.callPluginBridge(companyId, plugin, op, args)
}

/** Which screens the company's plugins put in the four slots (read on this computer: verified kept packages). */
export type PluginScreensPort = ElectronPort<'getPluginScreens' | 'onPluginsChanged'>

export function getPluginScreens(companyId: string, port: PluginScreensPort = window.electronAPI) {
  return port.getPluginScreens(companyId)
}

export function onPluginsChanged(callback: (change: { companyId: string }) => void, port: PluginScreensPort = window.electronAPI) {
  return port.onPluginsChanged(callback)
}
