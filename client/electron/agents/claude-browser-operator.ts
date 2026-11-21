/**
 * 「ブラウザ操作」's operator on Claude Code (agent-browser.md "The operator and the preview", design
 * memo §33.1): the member's own CLI with the Team login, started fresh for ONE step of the preview —
 * no tools, no MCP server (`--strict-mcp-config` with none given), no settings of the member's
 * (`--setting-sources ""`, `--safe-mode`), no slash commands, no session file, one turn — in a new
 * empty folder, with an environment built from nothing (`inheritEnv: false`, the 4th argument of
 * `spawnVoiceProcess`; `browserOperatorEnv`), the material as JSON on stdin.
 *
 * - The CLI is resolved once per request to its real path (a regular, executable file) and that
 *   path is used for every step: nothing is looked up on PATH again.
 * - The version floor only (`browserOperatorCli.min`, owner decision 2026-11-21: no per-version gate).
 * - The company's managed settings and Anthropic's server-pushed settings are trusted as the company's
 *   own (owner decision 2026-11-21, final): nothing is checked before the start; a hook they run is
 *   not a reason to stop. The member's own settings are cut by the arguments and checked in `init`.
 * - Every start: the `system`/`init` message must show the closed start (`operatorInitProblem`), once;
 *   any `tool_use` / `server_tool_use`, a line over 2 MB or a stream over 4 MB, no answer in time —
 *   SIGKILL, and the request ends. Nothing it reads or writes is logged.
 */
import { constants as fsConstants, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { compareCliVersions, parseCliVersion } from '../../shared/agents/cli-version'
import {
  BROWSER_OPERATOR_LIMITS, browserOperatorArgs, browserOperatorEnv, operatorInitProblem,
  type BrowserOperatorFailure,
} from '../../shared/browser-operator'
import { spawnVoiceProcess } from '../voice-process'

/** The CLI fixed for one request: its real path and the folders its PATH needs. */
export interface BrowserOperatorCli {
  readonly path: string
  readonly pathDirs: readonly string[]
}

export type BrowserOperatorResolved = { ok: true; cli: BrowserOperatorCli } | { ok: false; code: BrowserOperatorFailure }

export interface BrowserOperatorStepJob {
  cli: BrowserOperatorCli
  model: string
  /** Data for the operator, sent as JSON on stdin — never an instruction slot. */
  material: unknown
  signal: AbortSignal
  timeoutMs: number
  /** Where HOME / USER / LOGNAME and the proxy variables come from (the app's own environment). */
  parentEnv: Readonly<Record<string, string | undefined>>
}

export type BrowserOperatorStepResult = { ok: true; text: string } | { ok: false; code: BrowserOperatorFailure | 'cancelled' }

type Spawn = typeof spawnVoiceProcess

const VERSION_TIMEOUT_MS = 10_000

/**
 * Every process the CLI started goes with it: the CLI runs in a process group of its own (`detached`),
 * and the whole group is killed (a hook's or a tool's child included), never only the CLI.
 */
function killGroup(child: ReturnType<Spawn>) {
  try {
    if (child.pid) { process.kill(-child.pid, 'SIGKILL'); return }
  } catch { /* the group is gone */ }
  try { child.kill('SIGKILL') } catch { /* gone */ }
}

async function executableFile(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return false
    await fs.access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The folder of the `node` a `#!…node` script needs, or undefined when it is not such a script. */
async function nodeDirFor(script: string, original: string, parentPath: string | undefined): Promise<string | null | undefined> {
  let head = ''
  try {
    const handle = await fs.open(script, 'r')
    try {
      const buffer = Buffer.alloc(256)
      const { bytesRead } = await handle.read(buffer, 0, 256, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await handle.close() }
  } catch { return null }
  if (!head.startsWith('#!')) return undefined
  const line = head.slice(2).split('\n')[0].trim()
  if (!/\bnode\b/.test(line)) return undefined
  const direct = line.split(/\s+/)[0]
  if (direct.startsWith('/') && direct.endsWith('/node')) return (await executableFile(direct)) ? dirname(await fs.realpath(direct)) : null
  // `#!/usr/bin/env node`: the node next to the CLI (nvm, volta…), else the first on the app's PATH.
  const candidates = [dirname(original), dirname(script), ...(parentPath ?? '').split(delimiter).filter(Boolean)]
  for (const dir of candidates) {
    const node = join(dir, 'node')
    if (await executableFile(node)) return dirname(await fs.realpath(node))
  }
  return null
}

function readVersion(cli: BrowserOperatorCli, parentEnv: BrowserOperatorStepJob['parentEnv'], cwd: string, spawn: Spawn): Promise<string> {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const env = browserOperatorEnv(parentEnv, { pathDirs: cli.pathDirs, tmpdir: cwd })
    let child: ReturnType<Spawn>
    try { child = spawn(cli.path, ['--version'], { cwd, env, detached: true }, { inheritEnv: false }) } catch { resolve(''); return }
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(out) } }
    timer = setTimeout(() => { killGroup(child); done() }, VERSION_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString() })
    child.stderr.resume()
    child.stdin.end()
    child.on('error', done)
    child.on('close', done)
  })
}

/**
 * The CLI for one request (design memo §33 1-2, 1-5): the app's `claude` resolved to its real path,
 * a regular executable file (else `cli-missing`), at least the floor (`--version` unreadable or
 * older: `cli-too-old`).
 */
export async function resolveClaudeBrowserOperatorCli(
  cliPath: string, floor: string, parentEnv: BrowserOperatorStepJob['parentEnv'], spawn: Spawn = spawnVoiceProcess,
): Promise<BrowserOperatorResolved> {
  if (!cliPath.startsWith('/')) return { ok: false, code: 'cli-missing' }
  let real: string
  try { real = await fs.realpath(cliPath) } catch { return { ok: false, code: 'cli-missing' } }
  if (!(await executableFile(real))) return { ok: false, code: 'cli-missing' }
  const nodeDir = await nodeDirFor(real, cliPath, parentEnv.PATH)
  if (nodeDir === null) return { ok: false, code: 'start-failed' }
  const cli: BrowserOperatorCli = { path: real, pathDirs: [dirname(real), ...(nodeDir ? [nodeDir] : [])] }
  const minimum = parseCliVersion(floor)
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'acb-operator-')))
  try {
    const version = parseCliVersion(await readVersion(cli, parentEnv, dir, spawn))
    if (!minimum || !version || compareCliVersions(version, minimum) < 0) return { ok: false, code: 'cli-too-old' }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return { ok: true, cli }
}

/** One stream-json message → nothing, the answer, or why to stop. Exported for tests. */
export function readOperatorMessage(
  message: unknown, state: { init: boolean; text?: string }, expected: { cwd: string; model: string },
): BrowserOperatorFailure | undefined {
  const m = message as { type?: string; subtype?: string; message?: { content?: unknown }; is_error?: boolean; result?: unknown } | null
  if (!m || typeof m !== 'object') return 'init-mismatch'
  if (m.type === 'system' && m.subtype === 'init') {
    if (state.init) return 'init-mismatch'
    state.init = true
    return operatorInitProblem(m as Record<string, unknown>, expected) ? 'init-mismatch' : undefined
  }
  // Other system messages (a managed hook's, trusted as the company's own) may come before init.
  if (m.type === 'system') return undefined
  if (!state.init) return 'init-mismatch'
  if (m.type === 'assistant') {
    const content = Array.isArray(m.message?.content) ? m.message!.content as Array<{ type?: string }> : []
    return content.some(part => part?.type === 'tool_use' || part?.type === 'server_tool_use') ? 'tool-asked' : undefined
  }
  if (m.type === 'result') {
    if (m.is_error || m.subtype !== 'success' || typeof m.result !== 'string') {
      const text = typeof m.result === 'string' ? m.result : ''
      return /log ?in|authenticat|api key/i.test(text) ? 'not-signed-in' : 'bad-answer'
    }
    state.text = m.result
  }
  return undefined
}

/** One step: one fresh CLI start, its answer text, or why it stopped (the child is killed). */
export async function runClaudeBrowserOperatorStep(job: BrowserOperatorStepJob, spawn: Spawn = spawnVoiceProcess): Promise<BrowserOperatorStepResult> {
  if (job.signal.aborted) return { ok: false, code: 'cancelled' }
  // A new empty working folder and TMPDIR for every step, removed afterwards (realpath: macOS /var → /private/var).
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'acb-operator-')))
  let tmp: string
  try {
    tmp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'acb-operator-tmp-')))
  } catch {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
    return { ok: false, code: 'start-failed' }
  }
  try {
    return await new Promise<BrowserOperatorStepResult>(resolve => {
      const env = browserOperatorEnv(job.parentEnv, { pathDirs: job.cli.pathDirs, tmpdir: tmp })
      let child: ReturnType<Spawn>
      try {
        child = spawn(job.cli.path, browserOperatorArgs(job.model), { cwd, env, detached: true }, { inheritEnv: false })
      } catch {
        resolve({ ok: false, code: 'start-failed' })
        return
      }
      const state: { init: boolean; text?: string } = { init: false }
      const expected = { cwd, model: job.model }
      let bytes = 0
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const lines = createInterface({ input: child.stdout })
      const finish = (result: BrowserOperatorStepResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        job.signal.removeEventListener('abort', cancel)
        lines.close()
        // Whatever the outcome, nothing the CLI started outlives the step.
        killGroup(child)
        resolve(result)
      }
      function cancel() { finish({ ok: false, code: 'cancelled' }) }
      timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), job.timeoutMs)
      job.signal.addEventListener('abort', cancel, { once: true })
      child.on('error', () => finish({ ok: false, code: 'start-failed' }))
      child.stdin.on('error', () => finish({ ok: false, code: 'start-failed' }))
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > BROWSER_OPERATOR_LIMITS.outputBytes) finish({ ok: false, code: 'bad-answer' })
      })
      lines.on('line', line => {
        if (settled || !line.trim()) return
        if (Buffer.byteLength(line) > BROWSER_OPERATOR_LIMITS.lineBytes) { finish({ ok: false, code: 'bad-answer' }); return }
        let message: unknown
        try { message = JSON.parse(line) } catch { finish({ ok: false, code: 'bad-answer' }); return }
        const stop = readOperatorMessage(message, state, expected)
        if (stop) finish({ ok: false, code: stop })
      })
      // Drained, never recorded: it may carry the material.
      child.stderr.resume()
      child.on('close', () => {
        if (settled) return
        if (!state.init) finish({ ok: false, code: 'start-failed' })
        else if (state.text === undefined) finish({ ok: false, code: 'bad-answer' })
        else finish({ ok: true, text: state.text })
      })
      child.stdin.end(JSON.stringify(job.material))
    })
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
