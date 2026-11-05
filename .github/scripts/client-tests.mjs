#!/usr/bin/env node
// Runs the client's node tests (client/tests/*.test.ts and the colocated
// renderer tests client/src/**/*.test.ts) for one runner platform.
//
//   node .github/scripts/client-tests.mjs linux          # every test not in MACOS
//   node .github/scripts/client-tests.mjs macos          # only the MACOS list
//   node .github/scripts/client-tests.mjs <os> --list    # print the files
//
// Most client tests are plain Node and run on Linux (cheap, plentiful
// runners). The files in MACOS guard behaviour that only a Mac shows, so a
// Linux run would pass without guarding it. A file listed here that no longer
// exists fails the run, so the list cannot silently empty out. Each entry
// says why it needs macOS; add a file here only with such a reason.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MACOS = {
  // The POSIX spawn wrappers (electron/agents/process.ts, voice-process.ts)
  // close inherited fds with `exec N>&-` through /bin/sh: bash on macOS, dash
  // on Ubuntu, where multi-digit fds fail (a known Linux-only bug; Linux is
  // not a shipped platform). These tests spawn real children through them.
  'tests/agent-env.test.ts': 'spawns through the /bin/sh fd-closing wrapper',
  'tests/disk-key.test.ts': 'compares diskKey with what the case-insensitive APFS volume does',
  'tests/commit-message.test.ts': 'spawns a fake CLI through claude-oneshot (the /bin/sh wrapper)',
  'tests/permission-mode.test.ts': 'spawns a /bin/sh CLI through the Claude Code wrapper',
  'tests/sandbox-claude.test.ts': 'spawns a /bin/sh CLI through the Claude Code wrapper',
  'tests/voice-helper.test.ts': 'spawns the helper through voice-process.ts',
  'tests/voice-polisher.test.ts': 'spawns through the /bin/sh fd-closing wrapper',
  'tests/voice-probe.test.ts': 'spawns through voice-process.ts',
  // Recursive fs.watch is FSEvents on macOS (members' Macs); Linux's is a
  // different implementation with different event timing.
  'tests/company-watcher.test.ts': 'recursive fs.watch = FSEvents',
  // Link-escape and path guards assert the case- and normalization-insensitive
  // volume (NFC spelling reaching an NFD-named link, DOCS = docs) only on darwin.
  'tests/ipc-fs.test.ts': 'darwin-only assertions on a case/NFD-insensitive volume',
}

const os = process.argv[2]
if (os !== 'linux' && os !== 'macos') {
  console.error('usage: client-tests.mjs <linux|macos> [--list]')
  process.exit(2)
}

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client')
const walk = dir => fs.readdirSync(path.join(clientDir, dir), { withFileTypes: true }).flatMap(e => {
  const rel = `${dir}/${e.name}`
  return e.isDirectory() ? walk(rel) : e.name.endsWith('.test.ts') ? [rel] : []
})
// tests/*.test.ts (not the sync/, perf/ sub-folders) + src/**/*.test.ts.
const all = [
  ...fs.readdirSync(path.join(clientDir, 'tests')).filter(f => f.endsWith('.test.ts')).map(f => `tests/${f}`),
  ...walk('src'),
].sort()
if (all.some(f => /\s/.test(f))) {
  console.error('client-tests.mjs: test file names must not contain spaces')
  process.exit(1)
}
const missing = Object.keys(MACOS).filter(f => !all.includes(f))
if (missing.length > 0) {
  console.error(`client-tests.mjs names files that do not exist: ${missing.join(', ')}`)
  process.exit(1)
}

const files = os === 'macos' ? Object.keys(MACOS).sort() : all.filter(f => !(f in MACOS))
console.log(`Client node tests (${os}): ${files.length} files`)
if (process.argv.includes('--list')) {
  console.log(files.join('\n'))
  process.exit(0)
}
const run = spawnSync('npx', ['tsx', '--test', ...files], { cwd: clientDir, stdio: 'inherit' })
process.exit(run.status ?? 1)
