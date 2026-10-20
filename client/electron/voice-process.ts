import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { fstatSync, openSync } from 'node:fs'

// Match the existing chat-server workaround: Electron on macOS can leave
// inherited Chromium descriptors that make posix_spawn fail with EBADF.
// Arguments stay positional; no transcript or caller text is shell source.
export function spawnVoiceProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  const env = { ...process.env, ...options.env }
  delete env.CLAUDECODE
  if (process.platform === 'win32') return spawn(command, args, { ...options, env, stdio: ['pipe', 'pipe', 'pipe'] })
  for (const fd of [0, 1, 2]) {
    try { fstatSync(fd) } catch { openSync('/dev/null', fd === 0 ? 'r' : 'w') }
  }
  return spawn('/bin/sh', [
    '-c',
    'for f in /dev/fd/*; do n="${f##*/}"; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-" 2>/dev/null || true; done; exec "$0" "$@"',
    command, ...args,
  ], { ...options, env, stdio: ['pipe', 'pipe', 'pipe'], ...(process.getuid ? { uid: process.getuid() } : {}) })
}
