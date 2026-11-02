/**
 * A second opinion from Claude Code (second-opinion-runner.ts): one non-persistent `claude -p`
 * with no tools (`--tools ""`; `dontAsk` refuses anything else), no settings from anywhere
 * (`--setting-sources ""`, `--safe-mode`: no CLAUDE.md, skills, hooks, plugins), no MCP servers
 * (`--strict-mcp-config` with none given), no slash commands, no session file, one turn, an
 * empty temporary folder as cwd, the material as JSON on stdin (data, never shell source).
 * Verified on CLI 2.1.316: the init message lists `tools: []` and `mcp_servers: []`.
 *
 * The stream is read line by line and stops at once (SIGKILL) when the init message lists any
 * tool or MCP server, or the model asks for a tool: a CLI that ignored the flags never runs.
 * Nothing it reads or writes is logged.
 */
import { createInterface } from 'node:readline'
import { spawnVoiceProcess } from '../voice-process'
import { agentEnv } from './agent-env'
import { SECOND_OPINION_SYSTEM_PROMPT } from '../../shared/agents/second-opinion'
import { SECOND_OPINION_MAX_ANSWER, SECOND_OPINION_MAX_OUTPUT, SecondOpinionError, type SecondOpinionJob, type SecondOpinionResult } from './second-opinion-runner'

const MAX_LINE = 2_000_000

export function claudeSecondOpinionArgs(model: string): string[] {
  return [
    '-p', '--model', model,
    '--safe-mode',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns', '1',
    '--output-format', 'stream-json', '--verbose',
    '--system-prompt', SECOND_OPINION_SYSTEM_PROMPT,
  ]
}

/** One stream-json message → the answer, or the reason to stop. Exported for tests. */
export function readClaudeSecondOpinionMessage(message: unknown, state: { answer?: string }): SecondOpinionError | undefined {
  const m = message as { type?: string; subtype?: string; tools?: unknown; mcp_servers?: unknown; message?: { content?: unknown }; is_error?: boolean; result?: unknown } | null
  if (!m || typeof m !== 'object') return undefined
  if (m.type === 'system' && m.subtype === 'init') {
    const tools = Array.isArray(m.tools) ? m.tools.length : -1
    const servers = Array.isArray(m.mcp_servers) ? m.mcp_servers.length : 0
    if (tools !== 0 || servers !== 0) return new SecondOpinionError('failed', `second opinion started with tools (${tools}) or MCP servers (${servers})`)
    return undefined
  }
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    if ((m.message!.content as Array<{ type?: string }>).some(part => part?.type === 'tool_use' || part?.type === 'server_tool_use')) {
      return new SecondOpinionError('failed', 'second opinion asked for a tool')
    }
    return undefined
  }
  if (m.type === 'result') {
    if (m.is_error || m.subtype !== 'success' || typeof m.result !== 'string' || !m.result.trim()) {
      const text = typeof m.result === 'string' ? m.result : ''
      if (/log ?in|authenticat|api key/i.test(text)) return new SecondOpinionError('unavailable', 'Claude Code is not signed in')
      if (/usage limit|rate.?limit|429/i.test(text)) return new SecondOpinionError('limited', 'Claude Code usage limit')
      return new SecondOpinionError('failed', `second opinion ended without an answer (${String(m.subtype ?? 'unknown')})`)
    }
    if (m.result.length > SECOND_OPINION_MAX_ANSWER) return new SecondOpinionError('too-long', 'second opinion too long')
    state.answer = m.result
  }
  return undefined
}

type Spawn = typeof spawnVoiceProcess

export function runClaudeSecondOpinion(job: SecondOpinionJob, spawn: Spawn = spawnVoiceProcess): Promise<SecondOpinionResult> {
  return new Promise((resolve, reject) => {
    if (job.signal.aborted) { reject(new SecondOpinionError('cancelled', 'cancelled')); return }
    let ready = true
    try { ready = job.host.claudeReady ? job.host.claudeReady() : true } catch { ready = false }
    if (!ready) { reject(new SecondOpinionError('unavailable', 'Claude Code is not signed in')); return }
    let cli: string
    try { cli = job.host.getCli() } catch { reject(new SecondOpinionError('unavailable', 'no Claude Code CLI')); return }
    const child = spawn(cli, claudeSecondOpinionArgs(job.model), {
      cwd: job.cwd, env: agentEnv({ ...job.host.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }),
    }, { inheritEnv: false })
    const state: { answer?: string } = {}
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const lines = createInterface({ input: child.stdout })
    const finish = (error?: SecondOpinionError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      job.signal.removeEventListener('abort', cancel)
      lines.close()
      if (error) {
        child.kill('SIGKILL')
        reject(error)
      } else if (state.answer === undefined) {
        reject(new SecondOpinionError('failed', 'second opinion ended without an answer'))
      } else {
        resolve({ answer: state.answer })
      }
    }
    function cancel() { finish(new SecondOpinionError('cancelled', 'cancelled')) }
    timer = setTimeout(() => finish(new SecondOpinionError('timeout', 'second opinion timed out')), job.timeoutMs)
    job.signal.addEventListener('abort', cancel, { once: true })
    child.on('error', () => finish(new SecondOpinionError('unavailable', 'could not start Claude Code')))
    child.stdin.on('error', () => finish(new SecondOpinionError('unavailable', 'could not write to Claude Code')))
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > SECOND_OPINION_MAX_OUTPUT) finish(new SecondOpinionError('too-long', 'second opinion output too long'))
    })
    lines.on('line', line => {
      if (settled || !line.trim()) return
      if (line.length > MAX_LINE) { finish(new SecondOpinionError('too-long', 'second opinion message too long')); return }
      let message: unknown
      try { message = JSON.parse(line) } catch { return }
      const stop = readClaudeSecondOpinionMessage(message, state)
      if (stop) finish(stop)
    })
    // Drain without recording: it may carry the material.
    child.stderr.resume()
    child.on('close', code => {
      if (settled) return
      if (code !== 0 && state.answer === undefined) { finish(new SecondOpinionError('failed', `Claude Code exited with ${code}`)); return }
      finish()
    })
    child.stdin.end(JSON.stringify(job.material))
  })
}
