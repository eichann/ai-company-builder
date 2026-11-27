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
  'tests/browser-operator.test.ts': 'spawns a fake Claude Code through voice-process.ts (the /bin/sh wrapper)',
  // Recursive fs.watch is FSEvents on macOS (members' Macs); Linux's is a
  // different implementation with different event timing.
  'tests/company-watcher.test.ts': 'recursive fs.watch = FSEvents',
  // Link-escape and path guards assert the case- and normalization-insensitive
  // volume (NFC spelling reaching an NFD-named link, DOCS = docs) only on darwin.
  'tests/ipc-fs.test.ts': 'darwin-only assertions on a case/NFD-insensitive volume',
  // A folder named in NFD on disk matched by an NFC ignore line (git's
  // core.precomposeunicode, set only on a Mac).
  'tests/nested-repos.test.ts': 'NFD folder names on APFS with git precomposing them',
  // A real Electron window (「ブラウザ操作」, agent-browser.md): Linux runners have no display, so
  // the test skips itself there and would pass without guarding anything.
  'tests/browser-window-electron.test.ts': 'launches the real Electron app, which needs a display',
  // Cookies encrypted on disk by the fuse the shipped build flips (agent-browser.md "Keeping a login on disk"): a copy
  // of Electron with the fuse, macOS only (APFS clone, re-signed ad hoc); skipped elsewhere.
  'tests/cookie-encryption-electron.test.ts': 'flips the fuse on a macOS copy of Electron and launches it',
  // The HTML viewer's document frame in a real Electron (doc-frame.md): same reason.
  'tests/doc-frame-electron.test.ts': 'launches the real Electron app, which needs a display',
  // ACB's player over a document's Drive embeds in a real Electron (doc-frame.md "plan 4"): same reason.
  'tests/doc-player-electron.test.ts': 'launches the real Electron app, which needs a display',
  // Company videos played by Chromium's real media player (files-and-editor.md "Videos"): same reason.
  'tests/video-electron.test.ts': 'launches the real Electron app, which needs a display',
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
// The tests that launch the real Electron app (`*-electron.test.ts`) run one file at a time, after the
// others: run side by side, their windows take the system's focus from each other, and the keyboard and
// focus checks (doc-frame-electron, doc-player-electron) failed in turns on the shared macOS runners once
// the player test (#881) added its windows (2026-11-27). The rest keep node's parallel run.
const windowed = files.filter(f => f.endsWith('-electron.test.ts'))
const rest = files.filter(f => !windowed.includes(f))
const runs = [
  rest.length > 0 ? spawnSync('npx', ['tsx', '--test', ...rest], { cwd: clientDir, stdio: 'inherit' }) : null,
  windowed.length > 0 ? spawnSync('npx', ['tsx', '--test', '--test-concurrency=1', ...windowed], { cwd: clientDir, stdio: 'inherit' }) : null,
]
process.exit(runs.every(r => r === null || r.status === 0) ? 0 : 1)
