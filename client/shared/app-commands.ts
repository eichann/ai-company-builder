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
export const appCommandToolName = (commandId: string): string => commandId.split('.').join('_')
export const appCommandToolId = (commandId: string): string => `mcp__${APP_COMMANDS_SERVER}__${appCommandToolName(commandId)}`

/** The commands the AI may run, from the one catalog (today tabs.list, tabs.tidy, tabs.restore). */
export function aiCommands(): CommandDefinition[] {
  return Object.values(COMMANDS as Record<string, CommandDefinition>).filter(def => def.exposeToAI === true)
}

/** Whether `commandId` is one of them (main and the window both check). */
export function isAiCommand(commandId: unknown): commandId is string {
  return typeof commandId === 'string' && aiCommands().some(def => def.id === commandId)
}

/** Main → the main window: run this command for the AI of a consultation in `companyId`. */
export interface AppCommandRequest {
  requestId: string
  /** The consultation's company: the window refuses when another company is on screen. */
  companyId: string
  commandId: string
  args: unknown
}

/**
 * Why the window will not run an AI request, or null: only the catalog's AI commands, and only
 * for the company on screen (a consultation of another company never touches these tabs).
 */
export function appCommandRefusal(request: Pick<AppCommandRequest, 'commandId' | 'companyId'>, shownCompanyId: string | null | undefined): string | null {
  if (!isAiCommand(request.commandId)) return APP_COMMAND_MESSAGES.unknown
  if (!shownCompanyId || request.companyId !== shownCompanyId) return APP_COMMAND_MESSAGES.otherCompany
  return null
}

/** What the AI reads instead of the name of a file in a private folder this consultation has not read. */
export const PRIVATE_TAB_TITLE = '（非公開のファイル）'

/**
 * What the AI gets back: every `path` (company path of a file tab, which the window adds so main can
 * tell) is removed, and the title of a file in a private folder the consultation has not read is
 * replaced (private-folders.md: a folder's names never reach where they were not read).
 */
export function redactForAI(value: unknown, hidden: (companyPath: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map(v => redactForAI(v, hidden))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  const entry = value as Record<string, unknown>
  for (const [k, v] of Object.entries(entry)) if (k !== 'path') out[k] = redactForAI(v, hidden)
  if (typeof entry.path === 'string' && hidden(entry.path)) out.title = PRIVATE_TAB_TITLE
  return out
}

/** The window's answer: what the command returned (plain data), or why it did not run (Japanese). */
export type AppCommandAnswer = { ok: true; result: unknown } | { ok: false; error: string }

/**
 * A handler's result as the window's answer: `{ error }` alone means the handler refused and did
 * nothing (an unknown group, nothing chosen), so the AI gets `ok: false` with those words.
 */
export function appCommandAnswerOf(result: unknown): AppCommandAnswer {
  const r = result as Record<string, unknown> | null
  if (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 1 && typeof r.error === 'string') return { ok: false, error: r.error }
  return { ok: true, result: JSON.parse(JSON.stringify(result ?? null)) }
}

export const APP_COMMAND_MESSAGES = {
  /** A consultation shown in a window of its own: that window has no tabs. */
  ownWindow: 'この相談は別のウィンドウで開いています。タブはメインの画面の相談からだけ扱えます。',
  noWindow: 'アプリの画面が開いていないため、できませんでした。',
  timeout: '画面が応答しませんでした。少し待ってからもう一度ためしてください。',
  unknown: 'この操作は AI からは使えません。',
  otherCompany: 'この相談は、いま画面に出ている会社のものではありません。その会社を開いているときに頼んでください。',
  badArgs: '指定のしかたが正しくありません。',
  failed: 'できませんでした。',
} as const
