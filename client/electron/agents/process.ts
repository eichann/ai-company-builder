import fs from 'fs'
import { spawn as nodeSpawn } from 'child_process'
import { agentEnv } from './agent-env'
// Windows spawn for the Claude CLI. Windows has no posix_spawn EBADF problem
// and no /bin/sh or /dev/fd, so the macOS FD-closing shell wrapper does not
// apply — we spawn directly. A native claude.exe spawns directly (and handles
// install paths containing spaces); a claude.cmd/.bat must go through cmd.exe.
function spawnOnWindows(opts: SpawnInput) {
  const isBatch = /\.(cmd|bat)$/i.test(opts.command)
  let file = opts.command
  let args = opts.args
  const extra: Record<string, unknown> = {}
  if (isBatch) {
    // Quote the command and any args with spaces, then run verbatim through
    // cmd.exe so paths like C:\Users\My Name\...\claude.cmd work.
    file = process.env.ComSpec || 'cmd.exe'
    const quoted = [opts.command, ...opts.args]
      .map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
      .join(' ')
    args = ['/d', '/s', '/c', quoted]
    extra.windowsVerbatimArguments = true
  }
  if (!opts.quiet) console.log('[agent-process] spawning (win32):', opts.command, opts.args?.slice(0, 3))
  const child = nodeSpawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
    windowsHide: true,
    ...extra,
  })
  logOrDrain(child, opts.quiet)
  return child
}

interface SpawnInput {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  /** Never log the child's stderr (it is still read, so the child cannot block on a full pipe). */
  quiet?: boolean
}

function logOrDrain(child: ReturnType<typeof nodeSpawn>, quiet: boolean | undefined) {
  if (quiet) {
    child.on('error', () => {})
    child.stderr?.resume()
    return
  }
  child.on('error', (err) => console.error('[agent-process] child process error:', err))
  child.stderr?.on('data', (data: Buffer) => console.error('[agent-process] stderr:', data.toString()))
}

/**
 * Stops a child started here. On Windows a `.cmd` runs under cmd.exe, so the whole tree is
 * ended with taskkill; elsewhere the child is the CLI itself (`exec` in the wrapper).
 */
export function killAgentProcess(child: ReturnType<typeof nodeSpawn>, signal: NodeJS.Signals = 'SIGTERM') {
  if (process.platform === 'win32' && child.pid) {
    const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill(signal))
    return
  }
  child.kill(signal)
}

// Spawn helper for Claude Code CLI that works around Electron's FD inheritance issues (EBADF on posix_spawn).
// Repair standard FDs, force fork+exec, and close inherited Chromium FDs before exec.
// Every AI process starts here (Claude Code via the SDK's spawnClaudeCodeProcess, Codex
// app-server, hand-off writers), so this is where its environment is cut down to the
// allowlist (agent-env.ts) — after the SDK and the provider have merged in process.env.
export function spawnAgentProcess(input: SpawnInput) {
  const opts: SpawnInput = { ...input, env: agentEnv(input.env ?? process.env) }
  if (process.platform === 'win32') return spawnOnWindows(opts)
  for (const fd of [0, 1, 2]) {
    try { fs.fstatSync(fd) }
    catch {
      console.warn(`[agent-process] FD ${fd} invalid, reopening as /dev/null`)
      fs.openSync('/dev/null', fd === 0 ? 'r' : 'w')
    }
  }
  const child = nodeSpawn('/bin/sh', [
    '-c',
    'for f in /dev/fd/*; do n="${f##*/}"; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-" 2>/dev/null || true; done; exec "$0" "$@"',
    opts.command,
    ...opts.args,
  ], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
    windowsHide: true,
    ...(process.getuid ? { uid: process.getuid() } : {}),
  })
  logOrDrain(child, opts.quiet)
  return child
}


