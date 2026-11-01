/**
 * A business plugin's screens as the app places them (stage 4b, plan A6,
 * `.claude/rules/plugin-frame.md` "The four slots"): what main answers the
 * renderer for `plugins:screens`, and how main reads it from a kept package's
 * verified `plugin.yaml`. Pure; main and tests import it.
 *
 * Only a contract-2 business plugin whose declaration names this package
 * (same id and version), declares `ui` with a bridge version this app speaks,
 * and whose every frame entry is a file of the verified package gets screens.
 * Anything else answers null: the slots then show nothing for it.
 */
import { parsePluginManifest } from '../../shared/core/plugin-manifest'
import { PLUGIN_CONTRACT_V2, type PluginUi } from '../../shared/core/plugin-declaration'
import { APP_BRIDGE_VERSION } from './plugin-bridge-ops'
import type { PluginPackageRef } from './plugin-bridge'

export interface PluginScreens {
  plugin: PluginPackageRef
  /** The plugin's own name (its declaration's `label`). */
  label: string
  tab: PluginUi['tab']
  peek: PluginUi['peek']
  recordSections: PluginUi['recordSections']
  fileActions: PluginUi['fileActions']
}

export type PluginScreensResult =
  | { success: true; screens: PluginScreens[] }
  | { success: false; error: string }

export const PLUGIN_SCREENS_OFFLINE_TEXT = 'プラグインの画面を読み込めませんでした。'

/** The screens of one kept package, from its verified declaration and file list; null when it has none to show. */
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
