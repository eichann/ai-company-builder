import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexRpc } from '../../electron/agents/codex-rpc'
import { CODEX_TEXT_OVERRIDES } from '../../electron/agents/codex-text'
import { spawnVoiceProcess } from '../../electron/voice-process'

// Probe only the ephemeral session IDs created by this experiment. No user data is deleted.
const [provider, directory] = process.argv.slice(2)
if (!['claude-code', 'codex'].includes(provider) || !path.isAbsolute(directory || '')) throw new Error('provider and absolute experiment directory required')
const metrics = JSON.parse(fs.readFileSync(path.join(directory, 'metrics.json'), 'utf8'))
const sessionId: string = metrics.find((row: { phase: string }) => row.phase === 'memo-2').nativeSessionId
if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error('invalid session ID')
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
let result: unknown
if (provider === 'codex') {
  const rpc = new CodexRpc(env, CODEX_TEXT_OVERRIDES)
  try {
    await rpc.initialize()
    await rpc.request('thread/resume', { threadId: sessionId })
    result = { absent: false, message: 'Unexpected: ephemeral thread resumed' }
  } catch (error) { result = { resumeRejected: true, message: error instanceof Error ? error.message : String(error) } }
  finally { rpc.close() }
} else {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[key]
  result = await new Promise(resolve => {
    const child = spawnVoiceProcess(process.env.ACB_HANDOFF_CLAUDE_CLI || path.join(os.homedir(), '.local/bin/claude'), ['-p', '--resume', sessionId, '--model', 'haiku', '--safe-mode', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--output-format', 'json'], { cwd: path.join(directory, 'empty-project'), env })
    let output = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.stdout.setEncoding('utf8').on('data', (data: string) => { output += data; if (output.length > 10000) child.kill('SIGKILL') })
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; if (stderr.length > 10000) child.kill('SIGKILL') })
    child.on('error', error => { clearTimeout(timer); resolve({ error: error.message }) })
    child.stdin.on('error', () => {})
    child.on('close', code => { clearTimeout(timer); resolve({ code, output, stderr }) })
    child.stdin.end('Reply OK only. This is an isolated session-absence probe.')
  })
}
fs.writeFileSync(path.join(directory, 'session-absence.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
