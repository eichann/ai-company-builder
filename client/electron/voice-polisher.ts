import { spawnVoiceProcess } from './voice-process'
import { composeVoicePrompt } from '../shared/voice-prompt'

/** The default prompt (fixed part + default 「整え方の指示」); members may edit the latter. */
export const VOICE_SYSTEM_PROMPT = composeVoicePrompt()

export function polishVoice(cli: string, cwd: string, transcript: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, systemPrompt: string = VOICE_SYSTEM_PROMPT): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('キャンセルしました')); return }
    const child = spawnVoiceProcess(cli, ['-p', '--model', 'haiku', '--safe-mode', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--output-format', 'json', '--system-prompt', systemPrompt], {
      cwd, env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    })
    let output = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error, text?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      if (error) { child.kill('SIGKILL'); reject(error) } else resolve(text!)
    }
    function cancel() { finish(new Error('キャンセルしました')) }
    timeout = setTimeout(() => finish(new Error('文章の整形がタイムアウトしました')), 60_000)
    signal.addEventListener('abort', cancel, { once: true })
    child.on('error', () => finish(new Error('Claude Codeを起動できません。インストール状況をご確認ください')))
    child.stdin.on('error', () => finish(new Error('Claude Codeへの入力に失敗しました')))
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      if (output.length > 100_000) finish(new Error('整形結果が長すぎます'))
    })
    // Drain without recording potentially sensitive CLI output.
    child.stderr.resume()
    child.on('close', code => {
      if (code !== 0) { finish(new Error('Claude Codeで整形できませんでした。ログイン状態・バージョンをご確認ください')); return }
      try {
        const result = JSON.parse(output)
        if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new Error()
        finish(undefined, result.result.trim())
      } catch { finish(new Error('Claude Codeから有効な整形結果を取得できませんでした')) }
    })
    child.stdin.end(JSON.stringify({ transcript }))
  })
}
