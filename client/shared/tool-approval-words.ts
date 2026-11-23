/**
 * What the approval banner (「AI が確認を求めています」) says about a call the AI wants to make, in
 * plain Japanese: the member reads what will happen, never a tool id (「Bash」) or English
 * command text. The exact call stays behind 「くわしく」 (`technical`, `exact`) for whoever needs it.
 * Presentation only: what is asked, and what an answer allows, is decided elsewhere. Pure.
 */
import { toolLineOf } from './tool-display'
import { dangerousCommandOf } from './dangerous-commands'

export interface ApprovalWords {
  /** What will happen: 「ファイルを消すコマンドを実行します」, 「ファイルに書きます」. */
  action: string
  /** A short, safe detail (a company-relative path, Claude's own description of a command). */
  detail?: string
  /** The tool's own name, for 「くわしく」. */
  technical: string
  /** The exact command, path, address or query the call names, for 「くわしく」. */
  exact?: string
}

const COMMAND_TOOLS = new Set(['Bash', 'executeCommand'])

function commandText(value: unknown): string {
  if (typeof value === 'string') return value
  // Codex may report a command as its argument list.
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join(' ')
  return ''
}

/** The past-tense row label as a statement of what is about to happen: 「…しました」 → 「…します」. */
function aboutTo(label: string): string {
  return label.replace(/ました$/, 'ます')
}

export function approvalWordsOf(toolName: string, rawInput: Record<string, unknown> | undefined, root?: string): ApprovalWords {
  const input = rawInput ?? {}
  const line = toolLineOf(toolName, input, undefined, { root })
  const exactValue = [input.command, input.file_path, input.notebook_path, input.path, input.url, input.query]
    .map(commandText).find(Boolean)
  const exact = exactValue || undefined
  if (COMMAND_TOOLS.has(toolName)) {
    const command = commandText(input.command)
    const action = dangerousCommandOf(command)?.action ?? 'コマンドを実行します'
    return { action, ...(line.detail ? { detail: line.detail } : {}), technical: toolName, ...(exact ? { exact } : {}) }
  }
  if (line.muted) return { action: 'ほかの道具を使います', technical: line.technical ?? toolName, ...(exact ? { exact } : {}) }
  return { action: aboutTo(line.label), ...(line.detail ? { detail: line.detail } : {}), technical: toolName, ...(exact ? { exact } : {}) }
}
