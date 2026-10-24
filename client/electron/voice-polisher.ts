import { runClaudeOneShot } from './claude-oneshot'
import { composeVoicePrompt } from '../shared/voice-prompt'
import { AGENTS } from '../shared/agents/registry'

/** The default prompt (fixed part + default 「整え方の指示」); members may edit the latter. */
export const VOICE_SYSTEM_PROMPT = composeVoicePrompt()

export const VOICE_MESSAGES = {
  cancelled: 'キャンセルしました',
  timedOut: '文章の整形がタイムアウトしました',
  spawnFailed: 'Claude Codeを起動できません。インストール状況をご確認ください',
  stdinFailed: 'Claude Codeへの入力に失敗しました',
  tooLong: '整形結果が長すぎます',
  exitFailed: 'Claude Codeで整形できませんでした。ログイン状態・バージョンをご確認ください',
  invalid: 'Claude Codeから有効な整形結果を取得できませんでした',
}

export function polishVoice(cli: string, cwd: string, transcript: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, systemPrompt: string = VOICE_SYSTEM_PROMPT): Promise<string> {
  return runClaudeOneShot({ cli, cwd, model: AGENTS['claude-code'].tasks.voice!, systemPrompt, input: { transcript }, signal, env, timeoutMs: 60_000, messages: VOICE_MESSAGES })
}
