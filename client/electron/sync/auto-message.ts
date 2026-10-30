// The commit message of 「自動で送る」: a plain template built from the staged
// changes, never the AI (one model call per scheduled run would spend the
// member's usage for a message nobody asked for). .claude/rules/sync.md.

import type { SimpleGit } from 'simple-git'
import { parseNameStatus } from './receive'

const LABEL: Record<string, string> = { A: '追加', M: '変更', D: '削除', T: '変更' }
const MAX_LINES = 10

/** 「自動同期：N件の変更」 + up to 10 「追加: path」 lines + 「ほか N 件」. */
export function autoCommitMessage(changes: ReadonlyArray<{ status: string; path: string }>): string {
  const lines = changes.slice(0, MAX_LINES).map(c => `${LABEL[c.status] ?? '変更'}: ${c.path}`)
  if (changes.length > MAX_LINES) lines.push(`ほか ${changes.length - MAX_LINES} 件`)
  return `自動同期：${changes.length}件の変更${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}`
}

/** What `git commit` would record now (staged), as the template message. */
export async function stagedAutoCommitMessage(git: SimpleGit): Promise<string> {
  const raw = await git.raw(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-status', '-z', '--no-renames'])
  return autoCommitMessage(parseNameStatus(raw))
}
