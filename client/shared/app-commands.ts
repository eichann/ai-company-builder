/**
 * The app's commands handed to the consultation AI (commands.md "Handed to the AI"): the catalog's
 * `exposeToAI` commands become tools on the app's own MCP server `acb_app` (`tabs.list` →
 * `tabs_list`). Main asks the main window to run one (`appCommand:request`) and the window answers
 * (`appCommand:respond`). Pure: main, preload, the renderer and tests read it.
 */
import { COMMANDS } from './commands/catalog'
import type { CommandDefinition } from './commands/define'

export const APP_COMMANDS_SERVER = 'acb_app'

/** `tabs.list` → `tabs_list` (MCP tool names have no dots). */
export const appCommandToolName = (commandId: string): string => commandId.replace('.', '_')
export const appCommandToolId = (commandId: string): string => `mcp__${APP_COMMANDS_SERVER}__${appCommandToolName(commandId)}`

/** The commands the AI may run, from the one catalog (today tabs.list, tabs.tidy, tabs.restore). */
export function aiCommands(): CommandDefinition[] {
  return Object.values(COMMANDS as Record<string, CommandDefinition>).filter(def => def.exposeToAI === true)
}

/** Whether `commandId` is one of them (main and the window both check). */
export function isAiCommand(commandId: unknown): commandId is string {
  return typeof commandId === 'string' && aiCommands().some(def => def.id === commandId)
}

/** Main → the main window: run this command for the AI. */
export interface AppCommandRequest {
  requestId: string
  commandId: string
  args: unknown
}

/** The window's answer: what the command returned (plain data), or why it did not run (Japanese). */
export type AppCommandAnswer = { ok: true; result: unknown } | { ok: false; error: string }

export const APP_COMMAND_MESSAGES = {
  /** A consultation shown in a window of its own: that window has no tabs. */
  ownWindow: 'この相談は別のウィンドウで開いています。タブはメインの画面の相談からだけ扱えます。',
  noWindow: 'アプリの画面が開いていないため、できませんでした。',
  timeout: '画面が応答しませんでした。少し待ってからもう一度ためしてください。',
  unknown: 'この操作は AI からは使えません。',
  badArgs: '指定のしかたが正しくありません。',
  failed: 'できませんでした。',
} as const
