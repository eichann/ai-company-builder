// Words of the emergency stop (「AI の緊急停止」, .claude/rules/agent-stop.md).
// Every tool kind has a label (Record<…>): a new kind in shared/types/agent-stop.ts
// without one fails the compiler.

import type { AgentStopEntry, AgentStopToolKind } from './api'

export const STOP_TOOL_KINDS: AgentStopToolKind[] = ['command', 'write', 'web', 'mcp-external']

export const STOP_TOOL_LABELS: Record<AgentStopToolKind, string> = {
  command: 'コマンドの実行',
  write: 'ファイルの書き込み',
  web: 'Web へのアクセス',
  'mcp-external': '外部の MCP（会社が入れたもの以外の道具）',
}

export const STOP_TOOL_HELP: Record<AgentStopToolKind, string> = {
  command: 'AI がパソコンでコマンド（プログラム）を動かすこと',
  write: 'AI がファイルを作る・書き換えること',
  web: 'AI が Web のページを読む・検索すること',
  'mcp-external': 'AI が外部のサービスにつながる道具を使うこと',
}

/** Who a stop applies to, in a sentence part: 「全員」 / 「山田さん」. */
export function stopWho(entry: Pick<AgentStopEntry, 'userId' | 'userName' | 'userEmail'>): string {
  if (entry.userId === null) return '全員'
  return `${entry.userName || entry.userEmail || '（退出したメンバー）'}さん`
}

/** What a stop stops: 「AI のすべて」 / 「コマンドの実行」. */
export function stopWhat(tool: AgentStopToolKind | null): string {
  return tool === null ? 'AI のすべて' : STOP_TOOL_LABELS[tool]
}

/** One line for lists and confirmations: 「全員の AI のすべて」. */
export function stopScopeLabel(entry: Pick<AgentStopEntry, 'userId' | 'userName' | 'userEmail' | 'tool'>): string {
  const what = stopWhat(entry.tool)
  return `${stopWho(entry)}の${/^[A-Za-z]/.test(what) ? ' ' : ''}${what}`
}

/** What happens when the stop is made (shown in the confirmation). */
export function stopEffect(tool: AgentStopToolKind | null): string {
  return tool === null
    ? '動いている AI の会話はその場で止まり、新しく相談を始めることもできなくなります。'
    : `AI が「${STOP_TOOL_LABELS[tool]}」をしようとすると断られます（Codex では会話ごと止まります）。ほかの操作はそのまま使えます。`
}

export const STOP_LIMITS =
  'アプリが最新の版でないメンバーには届きません（下の「停止に対応していないアプリ」）。ACB の外で動かしている AI は止められません。'
