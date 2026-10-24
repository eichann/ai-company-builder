// The environment the app's child processes get (Claude CLI, Codex, npm for
// skill tools, the commit-message and voice helpers).
//
// macOS .app bundles don't inherit the user's shell PATH, so it is rebuilt
// from known install locations (computed once, on first use).

import fs from 'fs'
import os from 'os'
import path from 'path'

export interface ShellEnvironment {
  /** PATH for spawned processes. */
  path(): string
  /** process.env with that PATH, without CLAUDECODE. */
  env(): Record<string, string>
}

// Directories to append to PATH on Windows so the spawned Claude CLI can find
// node/git and its own siblings. Unlike macOS .app bundles, Windows apps DO
// inherit the user's PATH, so we keep it and only append known install dirs.
function getWindowsExtraPathDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.local', 'bin'),               // native installer (claude.exe)
    path.join(home, 'AppData', 'Roaming', 'npm'),   // npm global (claude.cmd)
    path.join(home, '.npm-global'),
    path.join(home, '.npm-global', 'bin'),
  ].filter(p => {
    try { return fs.existsSync(p) } catch { return false }
  })
}

function resolveShellPath(): string {
  if (process.platform === 'win32') {
    // Keep the inherited Windows PATH and append known Claude/npm locations,
    // joined with ';' (path.delimiter). Never replace it with POSIX paths.
    const current = process.env.Path || process.env.PATH || ''
    return [current, ...getWindowsExtraPathDirs()]
      .filter(Boolean)
      .join(path.delimiter)
  }

  const staticPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.volta', 'bin'),
    path.join(os.homedir(), '.nodenv', 'shims'),
  ]

  // Directories containing version subdirectories (e.g. v22.17.1/bin)
  const versionManagerDirs = [
    path.join(os.homedir(), '.nvm', 'versions', 'node'),
    path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions'),
    path.join(os.homedir(), '.nodenv', 'versions'),
    path.join(os.homedir(), '.asdf', 'installs', 'nodejs'),
    '/usr/local/n/versions/node',
  ]

  // NOTE: Do NOT use execSync here to query the user's shell PATH.
  // execSync with stdio:'pipe' corrupts Electron's file descriptor table,
  // causing spawn EBADF errors in subsequent child process creation.
  // Instead, build PATH from known locations + version manager directories.

  // Expand version manager directories to include all installed versions
  const expandedPaths: string[] = [...staticPaths]
  for (const versionsDir of versionManagerDirs) {
    try {
      if (!fs.existsSync(versionsDir)) continue
      const versions = fs.readdirSync(versionsDir)
      for (const ver of versions) {
        expandedPaths.push(path.join(versionsDir, ver, 'bin'))
      }
    } catch { /* skip */ }
  }

  return expandedPaths.join(':')
}

export function createShellEnvironment(): ShellEnvironment {
  let resolvedShellPath: string | null = null
  const shellPath = () => {
    if (!resolvedShellPath) resolvedShellPath = resolveShellPath()
    return resolvedShellPath
  }
  return {
    path: shellPath,
    env() {
      if (process.platform === 'win32') {
        const env: Record<string, string> = { ...process.env as Record<string, string> }
        // Remove CLAUDECODE to avoid "nested session" detection when spawning Claude CLI
        delete env['CLAUDECODE']
        // Windows env keys are case-insensitive; replace the EXISTING path key in
        // place (usually 'Path') so the child doesn't get both 'Path' and 'PATH'.
        const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'Path'
        env[pathKey] = shellPath()
        return env
      }
      const env: Record<string, string> = { ...process.env as Record<string, string>, PATH: shellPath() }
      // Remove CLAUDECODE to avoid "nested session" detection when spawning Claude CLI
      delete env['CLAUDECODE']
      return env
    },
  }
}
