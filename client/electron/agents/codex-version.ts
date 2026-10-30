/**
 * The Codex version floor (registry `minCliVersion`): `codex --version`
 * before the app starts Codex for a chat or the settings check. A passing
 * CLI is remembered per path for the app run; a failing one is asked again
 * next time (the member may have updated it meanwhile).
 */
import { AGENTS } from '../../shared/agents/registry'
import { checkCodexVersion, type CliVersionCheck } from '../../shared/agents/cli-version'
import { findCodex } from './codex-rpc'
import { spawnAgentProcess } from './process'

const VERSION_TIMEOUT_MS = 10_000
const passed = new Set<string>()

/** `<cli> --version` output (stdout), or '' when it does not answer in time. */
export function readCliVersionOutput(cli: string, env: Record<string, string>, timeoutMs = VERSION_TIMEOUT_MS): Promise<string> {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = spawnAgentProcess({ command: cli, args: ['--version'], env })
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(out) } }
    timer = setTimeout(() => { child.kill('SIGKILL'); done() }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString() })
    child.stdin?.end()
    child.on('error', done)
    child.on('close', done)
  })
}

export type CodexVersionCheck = (env: Record<string, string>) => Promise<CliVersionCheck>

/** Is the member's Codex new enough? A missing CLI throws findCodex's message. */
export const checkInstalledCodex: CodexVersionCheck = async env => {
  const floor = AGENTS.codex.minCliVersion
  if (!floor) return { ok: true }
  const cli = findCodex(env)
  if (passed.has(cli)) return { ok: true }
  const result = checkCodexVersion(await readCliVersionOutput(cli, env), floor)
  if (result.ok) passed.add(cli)
  else console.warn(`[codex] CLI below the version floor ${floor}: ${result.version ? result.version.join('.') : 'unknown'}`)
  return result
}
