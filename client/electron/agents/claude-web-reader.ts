/**
 * The Web reader on Claude Code (web-research.md): one non-persistent
 * `claude -p` with exactly the two web tools (WebFetch, WebSearch), allowed
 * without asking (`dontAsk` refuses anything else), no settings from anywhere
 * (`--setting-sources ""`, `--safe-mode`: no CLAUDE.md, skills, hooks,
 * plugins, MCP), no slash commands, no session file, a turn limit, an
 * empty temporary folder as cwd, and the question as JSON on stdin (data,
 * never shell source). Verified against CLI 2.1.304: the init message lists
 * only WebFetch and WebSearch, and WebFetch runs under --safe-mode.
 *
 * The stream (`stream-json`) is read line by line: the init message must list
 * no other tool, every WebFetch URL is checked (a reader steered to the
 * member's network is stopped — best effort, the call may already be running),
 * and the URLs it opened become the result's sources. Nothing it reads is
 * logged.
 */
import { createInterface } from 'node:readline'
import { spawnVoiceProcess } from '../voice-process'
import { agentEnv } from './agent-env'
import { WEB_READER_SYSTEM_PROMPT, checkWebUrl } from '../../shared/web-research'
import { WEB_READER_MAX_ANSWER, WEB_READER_MAX_OUTPUT, WebReaderError, type WebReaderJob, type WebReaderResult } from './web-reader'

const READER_TOOLS = ['WebFetch', 'WebSearch'] as const
/** Room to search, read the given pages and follow their links (owner decision 2026-10-29). */
const MAX_TURNS = 25
const MAX_LINE = 2_000_000

export function claudeWebReaderArgs(model: string): string[] {
  return [
    '-p', '--model', model,
    '--safe-mode',
    '--tools', READER_TOOLS.join(','),
    '--allowedTools', READER_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'stream-json', '--verbose',
    '--system-prompt', WEB_READER_SYSTEM_PROMPT,
  ]
}

interface StreamState {
  fetchedUrls: string[]
  searches: number
  answer?: string
}

/**
 * One stream-json message → the reader's state, or the reason to stop.
 * Exported for tests.
 */
export function readClaudeReaderMessage(message: unknown, state: StreamState): WebReaderError | undefined {
  const m = message as { type?: string; subtype?: string; tools?: unknown; message?: { content?: unknown }; is_error?: boolean; result?: unknown } | null
  if (!m || typeof m !== 'object') return undefined
  if (m.type === 'system' && m.subtype === 'init') {
    const tools = Array.isArray(m.tools) ? m.tools.map(String) : []
    const extra = tools.filter(t => !(READER_TOOLS as readonly string[]).includes(t))
    if (extra.length > 0) return new WebReaderError('failed', `reader started with other tools (${extra.length})`)
    return undefined
  }
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    for (const part of m.message!.content as Array<{ type?: string; name?: string; input?: { url?: unknown } }>) {
      if (part?.type !== 'tool_use') continue
      if (part.name === 'WebSearch') { state.searches++; continue }
      if (part.name !== 'WebFetch') return new WebReaderError('failed', 'reader asked for another tool')
      const url = typeof part.input?.url === 'string' ? part.input.url : ''
      const checked = checkWebUrl(url)
      if (!checked.ok) return new WebReaderError('refused-address', 'reader tried to open a refused address')
      if (!state.fetchedUrls.includes(checked.url)) state.fetchedUrls.push(checked.url)
    }
    return undefined
  }
  if (m.type === 'result') {
    if (m.is_error || m.subtype !== 'success' || typeof m.result !== 'string' || !m.result.trim()) {
      return new WebReaderError('failed', `reader ended without an answer (${String(m.subtype ?? 'unknown')})`)
    }
    if (m.result.length > WEB_READER_MAX_ANSWER) return new WebReaderError('too-long', 'reader answer too long')
    state.answer = m.result
  }
  return undefined
}

export function runClaudeWebReader(job: WebReaderJob): Promise<WebReaderResult> {
  return new Promise((resolve, reject) => {
    if (job.signal.aborted) { reject(new WebReaderError('cancelled', 'cancelled')); return }
    let cli: string
    try { cli = job.host.getCli() } catch { reject(new WebReaderError('unavailable', 'no Claude Code CLI')); return }
    const child = spawnVoiceProcess(cli, claudeWebReaderArgs(job.model), {
      cwd: job.cwd, env: agentEnv({ ...job.host.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }),
    }, { inheritEnv: false })
    const state: StreamState = { fetchedUrls: [], searches: 0 }
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const lines = createInterface({ input: child.stdout })
    const finish = (error?: WebReaderError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      job.signal.removeEventListener('abort', cancel)
      lines.close()
      if (error) {
        child.kill('SIGKILL')
        reject(error)
      } else if (state.answer === undefined) {
        reject(new WebReaderError('failed', 'reader ended without an answer'))
      } else {
        resolve({ answer: state.answer, fetchedUrls: state.fetchedUrls, searches: state.searches })
      }
    }
    function cancel() { finish(new WebReaderError('cancelled', 'cancelled')) }
    timer = setTimeout(() => finish(new WebReaderError('timeout', 'reader timed out')), job.timeoutMs)
    job.signal.addEventListener('abort', cancel, { once: true })
    child.on('error', () => finish(new WebReaderError('unavailable', 'could not start Claude Code')))
    child.stdin.on('error', () => finish(new WebReaderError('unavailable', 'could not write to Claude Code')))
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > WEB_READER_MAX_OUTPUT) finish(new WebReaderError('too-long', 'reader output too long'))
    })
    lines.on('line', line => {
      if (settled || !line.trim()) return
      if (line.length > MAX_LINE) { finish(new WebReaderError('too-long', 'reader message too long')); return }
      let message: unknown
      try { message = JSON.parse(line) } catch { return }
      const stop = readClaudeReaderMessage(message, state)
      if (stop) finish(stop)
    })
    // Drain without recording: it may carry page text.
    child.stderr.resume()
    child.on('close', code => {
      if (settled) return
      if (code !== 0 && state.answer === undefined) { finish(new WebReaderError('failed', `Claude Code exited with ${code}`)); return }
      finish()
    })
    child.stdin.end(JSON.stringify(job.input))
  })
}
