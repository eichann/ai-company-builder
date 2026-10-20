import { spawnVoiceProcess } from '../../electron/voice-process'
export function probeClaudeRecall(cli: string, cwd: string, system: string, text: string, env: Record<string, string>): Promise<{ text: string; elapsedMs: number; usage: unknown; modelUsage: unknown; nativeSessionId: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const cleanEnv = { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete (cleanEnv as Record<string, string>)[key]
    const child = spawnVoiceProcess(cli, ['-p', '--model', 'haiku', '--safe-mode', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--output-format', 'json', '--system-prompt', system], { cwd, env: cleanEnv })
    let output = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { child.kill('SIGKILL'); reject(error); return }
      try {
        const result = JSON.parse(output)
        if (result.is_error || typeof result.result !== 'string') throw new Error('新規セッションでの応答に失敗しました')
        resolve({ text: result.result, elapsedMs: Date.now() - startedAt, usage: result.usage, modelUsage: result.modelUsage, nativeSessionId: result.session_id })
      } catch (error) { reject(error) }
    }
    const timer = setTimeout(() => finish(new Error('復旧検証がタイムアウトしました')), 60_000)
    child.on('error', finish)
    child.stdin.on('error', finish)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; if (output.length > 100_000) finish(new Error('出力超過')) })
    child.stderr.resume()
    child.on('close', code => finish(code === 0 ? undefined : new Error(`復旧検証の終了コード: ${code}`)))
    child.stdin.end(text)
  })
}
