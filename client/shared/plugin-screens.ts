/**
 * A business plugin's screens as the app places them (stage 4b, plan A6,
 * `.claude/rules/plugin-frame.md` "The four slots"): what main answers the
 * renderer for `plugins:screens`. Types and words only: the declaration's
 * parser stays in main (`electron/features/plugins/screens.ts`), out of the
 * renderer's bundle.
 */
import type { PluginUi } from '../../shared/core/plugin-declaration'
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
