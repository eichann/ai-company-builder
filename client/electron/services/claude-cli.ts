// The member's own Claude Code CLI: where it is, and whether the app can use
// it (the app never runs the SDK's bundled CLI — CLAUDE.md "Claude Code agent
// stack").

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ClaudeCodeStatus } from '../../shared/ipc-contract'

export interface ClaudeCli {
  /** Availability, path, version, authentication; cached for 30 s unless forced. */
  status(forceRefresh?: boolean): ClaudeCodeStatus
  /** Legacy compat: the CLI is available AND authenticated. */
  isAuthenticated(): boolean
  /** The CLI's path, or a platform-appropriate fallback for PATH lookup. */
  path(): string
}

const CLAUDE_STATUS_TTL = 30_000 // Re-check every 30 seconds

/**
 * Find the Claude Code CLI binary by searching common locations.
 * Returns the full path or null if not found.
 */
function findClaudeCodeCli(): string | null {
  // NOTE: Do NOT use execSync (e.g. `which claude`, `where claude.cmd`) here.
  // execSync with stdio:'pipe' corrupts Electron's file descriptor table,
  // causing spawn EBADF errors. Use fs.existsSync on known paths instead.

  if (process.platform === 'win32') {
    const home = os.homedir()
    const winPaths = [
      // Native installer (irm https://claude.ai/install.ps1 | iex) — preferred:
      // a real .exe spawns directly without a shell, even from paths with spaces.
      path.join(home, '.local', 'bin', 'claude.exe'),
      // npm global install (npm i -g @anthropic-ai/claude-code)
      path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      path.join(home, '.npm-global', 'claude.cmd'),
      path.join(home, '.npm-global', 'bin', 'claude.cmd'),
      // .cmd shim sometimes placed next to the native install
      path.join(home, '.local', 'bin', 'claude.cmd'),
    ]
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  // macOS / Linux: search common paths
  const commonPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',               // Homebrew on Apple Silicon
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  ]

  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p
  }

  // Search Node version manager directories (nvm, fnm, volta, nodenv, asdf, n)
  const versionManagerDirs = [
    path.join(os.homedir(), '.nvm', 'versions', 'node'),       // nvm
    path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions'), // fnm
    path.join(os.homedir(), '.nodenv', 'versions'),             // nodenv
    path.join(os.homedir(), '.asdf', 'installs', 'nodejs'),     // asdf
    '/usr/local/n/versions/node',                                // n
  ]

  for (const versionsDir of versionManagerDirs) {
    try {
      if (!fs.existsSync(versionsDir)) continue
      const versions = fs.readdirSync(versionsDir)
      // Sort descending to prefer newer versions
      versions.sort().reverse()
      for (const ver of versions) {
        const claudePath = path.join(versionsDir, ver, 'bin', 'claude')
        if (fs.existsSync(claudePath)) return claudePath
      }
    } catch { /* skip */ }
  }

  // volta stores binaries directly in ~/.volta/bin
  const voltaPath = path.join(os.homedir(), '.volta', 'bin', 'claude')
  if (fs.existsSync(voltaPath)) return voltaPath

  return null
}

export function createClaudeCli(): ClaudeCli {
  /** Cached result of Claude Code CLI detection */
  let cachedClaudeCodeStatus: ClaudeCodeStatus | null = null

  /**
   * Check Claude Code CLI status: availability, path, version, and authentication.
   * Results are cached for CLAUDE_STATUS_TTL milliseconds.
   */
  function status(forceRefresh = false): ClaudeCodeStatus {
    if (!forceRefresh && cachedClaudeCodeStatus && Date.now() - cachedClaudeCodeStatus.checkedAt < CLAUDE_STATUS_TTL) {
      return cachedClaudeCodeStatus
    }

    const result: ClaudeCodeStatus = {
      available: false,
      authenticated: false,
      cliPath: null,
      version: null,
      error: null,
      checkedAt: Date.now(),
    }

    // Step 1: Find the CLI binary
    const cliPath = findClaudeCodeCli()
    if (!cliPath) {
      result.error = 'Claude Code CLIが見つかりません。`npm install -g @anthropic-ai/claude-code` でインストールしてください。'
      cachedClaudeCodeStatus = result
      return result
    }
    result.cliPath = cliPath

    // Step 2: Mark as available if binary exists
    // NOTE: Do NOT use execSync here (e.g. `claude --version`) — it corrupts
    // Electron's file descriptor table and causes `spawn EBADF` on subsequent
    // process spawns (e.g. when launching the Claude CLI for chat).
    // Actual auth errors will surface at API call time with a clear message.
    result.available = true
    result.authenticated = true
    result.version = 'installed'

    cachedClaudeCodeStatus = result
    return result
  }

  return {
    status,
    isAuthenticated() {
      const current = status()
      return current?.available === true && current?.authenticated === true
    },
    path() {
      const current = status()
      return current?.cliPath || (process.platform === 'win32' ? 'claude.cmd' : 'claude')
    },
  }
}
