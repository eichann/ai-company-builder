/**
 * Shell commands the chat asks the member about before Claude Code runs them (the PreToolUse
 * hook in `electron/agents/claude.ts`), each with what it does in plain Japanese for the
 * approval banner (`tool-approval-words.ts`). One list, so the question and its words never
 * drift apart. Pure.
 */

export interface DangerousCommand {
  pattern: RegExp
  /** What running it does, as the member reads it: 「ファイルを消すコマンドを実行します」. */
  action: string
}

const DELETE = 'ファイルを消すコマンドを実行します'

export const DANGEROUS_COMMANDS: readonly DangerousCommand[] = [
  // Direct deletion commands
  { pattern: /\brm\s/, action: DELETE },
  { pattern: /\bunlink\s/, action: DELETE },
  { pattern: /\bshred\s/, action: DELETE },
  { pattern: /\bfind\b.*\s-delete\b/, action: DELETE },
  { pattern: /\bfind\b.*-exec\s+rm\b/, action: DELETE },

  // Scripted deletion (Python, Node, etc.)
  { pattern: /\bos\.remove\s*\(/, action: DELETE },
  { pattern: /\bos\.unlink\s*\(/, action: DELETE },
  { pattern: /\bshutil\.rmtree\s*\(/, action: DELETE },
  { pattern: /\bpathlib\b.*\.unlink\s*\(/, action: DELETE },
  { pattern: /\bfs\.unlink/, action: DELETE },
  { pattern: /\bfs\.rm\b/, action: DELETE },
  { pattern: /\bfs\.rmdir/, action: DELETE },

  // Git destructive
  { pattern: /\bgit\s+reset\s+--hard/, action: 'まだ共有していない変更を取り消すコマンドを実行します' },
  { pattern: /\bgit\s+push\s+--force/, action: 'サーバーにある内容を上書きするコマンドを実行します' },
  { pattern: /\bgit\s+push\s+-f\b/, action: 'サーバーにある内容を上書きするコマンドを実行します' },
  { pattern: /\bgit\s+clean\s+-f/, action: 'まだ共有していないファイルを消すコマンドを実行します' },

  // System-level destructive
  { pattern: /\bchmod\s+777\b/, action: 'だれでもファイルを変えられるようにするコマンドを実行します' },
  { pattern: /\bmkfs\b/, action: 'ディスクを書き換えるコマンドを実行します' },
  { pattern: /\bdd\s+if=/, action: 'ディスクを書き換えるコマンドを実行します' },
  { pattern: /(?<!\d)>\s*\//, action: 'パソコンの大切な場所に書き込むコマンドを実行します' }, // > / (redirect to root, but not 2>/dev/null)
]

/** The first entry `command` matches, or undefined when the hook does not ask about it. */
export function dangerousCommandOf(command: string): DangerousCommand | undefined {
  return DANGEROUS_COMMANDS.find(entry => entry.pattern.test(command))
}
