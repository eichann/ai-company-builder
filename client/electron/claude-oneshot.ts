import { spawnVoiceProcess } from './voice-process'

/**
 * One isolated, non-persistent `claude -p` call: the caller's model (Haiku), no tools, no MCP, no
 * slash commands, no settings or memory from anywhere, the input as JSON on
 * stdin (data, never shell source or an instruction slot) and the
 * instructions in the system prompt. Used by the voice polisher and by sync's
 * commit-message generation.
 */
export interface ClaudeOneShotMessages {
  cancelled: string
  timedOut: string
  spawnFailed: string
  stdinFailed: string
  tooLong: string
  exitFailed: string
  invalid: string
}

export interface ClaudeOneShotRequest {
  cli: string
  cwd: string
  /** The CLI `--model` (registry task model: shared/agents/registry.ts). */
  model: string
  systemPrompt: string
  /** Serialised as JSON on stdin. */
  input: unknown
  signal: AbortSignal
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  messages: ClaudeOneShotMessages
}

export const CLAUDE_ONESHOT_FLAGS = ['--safe-mode', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--output-format', 'json']

export function runClaudeOneShot(request: ClaudeOneShotRequest): Promise<string> {
  const { cli, cwd, model, systemPrompt, input, signal, env = process.env, timeoutMs, messages } = request
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error(messages.cancelled)); return }
    const child = spawnVoiceProcess(cli, ['-p', '--model', model, ...CLAUDE_ONESHOT_FLAGS, '--system-prompt', systemPrompt], {
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
    function cancel() { finish(new Error(messages.cancelled)) }
    timeout = setTimeout(() => finish(new Error(messages.timedOut)), timeoutMs)
    signal.addEventListener('abort', cancel, { once: true })
    child.on('error', () => finish(new Error(messages.spawnFailed)))
    child.stdin.on('error', () => finish(new Error(messages.stdinFailed)))
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      if (output.length > 100_000) finish(new Error(messages.tooLong))
    })
    // Drain without recording potentially sensitive CLI output.
    child.stderr.resume()
    child.on('close', code => {
      if (code !== 0) { finish(new Error(messages.exitFailed)); return }
      try {
        const result = JSON.parse(output)
        if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new Error()
        finish(undefined, result.result.trim())
      } catch { finish(new Error(messages.invalid)) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}
