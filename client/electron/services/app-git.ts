// The app's git: which binary (dugite's bundled git, else the system git),
// HTTPS credentials through GIT_ASKPASS with the session token, and the
// guarded configuration of sync/git-factory.ts (.claude/rules/sync-guards.md). Every git the app runs comes from here.

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { resolveGitBinary, resolveGitDir } from 'dugite'
import type { SimpleGit } from 'simple-git'
import { gitIdentityConfig } from '../client-identity'
import { configuredGitCommand, createConfiguredGit } from '../sync/git-factory'

export interface AppGitDeps {
  /** The session token git presents to the server ('' when signed out). */
  token: () => string
  /** <userData>/git: the app-owned hooks/ and templates/ (empty). */
  appGitDir: () => string
}

export interface AppGit {
  /** A simple-git instance for the repository, with HTTPS token authentication. */
  create(repoPath: string, extraEnv?: Record<string, string>): SimpleGit
  /** The same configuration for a git process that is streamed and stopped early (read-only, no token). */
  searchCommand(): ReturnType<typeof configuredGitCommand>
  /** Bundled git, or the system-git fallback (the UI warns about the latter). */
  binaryStatus(): { bundled: boolean; binary: string }
}

const ASKPASS_FILE = process.platform === 'win32' ? 'git-askpass.bat' : 'git-askpass.sh'
const ASKPASS_CONTENT = process.platform === 'win32' ? '@echo %GIT_TOKEN%\r\n' : '#!/bin/sh\necho "$GIT_TOKEN"\n'

/**
 * The GIT_ASKPASS helper (prints $GIT_TOKEN, the session's sync pass): git runs it, outside the
 * agent's sandbox, whenever HTTPS needs credentials. Audit B-M8: anything able to rewrite it would
 * run code at the next sync and read the pass — it was in the shared temp folder, written once and
 * reused as found. So it lives in the app's own folder (`<userData>/git/askpass/`, which the
 * agent's sandbox neither reads nor writes: agent-sandbox.md), the folder 0700 and the file 0700
 * (owner only, no group / other bits), and it is checked **before every use**: a regular file (not
 * a symlink), exactly the app's content, nobody else may write it — anything else is replaced
 * first (written beside it, then renamed over it). Returns the helper's path.
 */
export function ensureAskPass(appGitDir: string): string {
  const dir = path.join(path.resolve(appGitDir), 'askpass')
  const scriptPath = path.join(dir, ASKPASS_FILE)
  const dirStat = lstatOrNull(dir)
  if (dirStat && !dirStat.isDirectory()) fs.rmSync(dir, { force: true, recursive: true })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
  if (askPassIntact(scriptPath)) return scriptPath
  const temp = path.join(dir, `.${ASKPASS_FILE}.${process.pid}.${Date.now()}`)
  fs.writeFileSync(temp, ASKPASS_CONTENT, { mode: 0o700, flag: 'wx' })
  if (process.platform !== 'win32') fs.chmodSync(temp, 0o700)
  fs.renameSync(temp, scriptPath)
  return scriptPath
}

function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p) } catch { return null }
}

/** The helper as the app wrote it: a regular file, its content byte for byte, writable by its owner only. */
function askPassIntact(scriptPath: string): boolean {
  const st = lstatOrNull(scriptPath)
  if (!st || !st.isFile()) return false
  if (process.platform !== 'win32') {
    if ((st.mode & 0o022) !== 0) return false
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
  }
  try { return fs.readFileSync(scriptPath, 'utf8') === ASKPASS_CONTENT } catch { return false }
}

// Resolve git binary: try dugite's bundled git first, fall back to system git.
// The mac build ships a universal (arm64 + x86_64) bundled git
// (scripts/universal-git.mjs). The system-git fallback is a last resort only:
// Apple Git 2.39 at /usr/bin/git has a broken chunked HTTP push and known
// CVEs, which is what Intel Macs ran while the bundled git was arm64-only.
function resolveGitBinaryWithFallback(): { binary: string; envOverrides: Record<string, string>; fallback: boolean } {
  const dugiteBinary = resolveGitBinary()
  try {
    // Quick check: can the bundled binary actually execute?
    const version = execFileSync(dugiteBinary, ['--version'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    console.log(`[git] Using bundled git: ${dugiteBinary} (${version}, ${process.platform}-${process.arch})`)
    const gitDir = resolveGitDir()
    return {
      binary: dugiteBinary,
      envOverrides: {
        GIT_EXEC_PATH: path.join(gitDir, 'libexec', 'git-core'),
        // GIT_TEMPLATE_DIR is set by the git factory for every binary: an
        // empty app-owned directory, so init/clone copy no templates.
      },
      fallback: false,
    }
  } catch (error) {
    // Bundled git failed (e.g. arch mismatch) — fall back to system git
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[git] Bundled git ${dugiteBinary} failed on ${process.platform}-${process.arch} (${reason}); falling back to system git`)
    const systemPaths = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
    for (const p of systemPaths) {
      if (fs.existsSync(p)) {
        console.log(`[git] Using system git: ${p}`)
        return { binary: p, envOverrides: {}, fallback: true }
      }
    }
    // Last resort: hope 'git' is in PATH
    console.warn('[git] No system git found, using PATH lookup')
    return { binary: 'git', envOverrides: {}, fallback: true }
  }
}

export function createAppGit(deps: AppGitDeps): AppGit {
  /** The GIT_ASKPASS helper, checked (and put back if changed) before every use: ensureAskPass. */
  function getGitAskPassPath(): string {
    return ensureAskPass(deps.appGitDir())
  }

  // Cache the resolved git binary (checked once, on first use)
  let resolvedGit: ReturnType<typeof resolveGitBinaryWithFallback> | null = null
  function getResolvedGit() {
    if (!resolvedGit) resolvedGit = resolveGitBinaryWithFallback()
    return resolvedGit
  }

  // Create a simpleGit instance with HTTPS token authentication
  function createGit(repoPath: string, extraEnv?: Record<string, string>): SimpleGit {
    const { binary, envOverrides } = getResolvedGit()
    return createConfiguredGit(repoPath, {
      binary,
      askPassPath: getGitAskPassPath(),
      token: deps.token(),
      // App-owned hooks/ and templates/ (empty): the member's git hooks and
      // init.templateDir never run in the app (sync/git-factory.ts appGitDirs).
      appGitDir: deps.appGitDir(),
      envOverrides: extraEnv ? { ...envOverrides, ...extraEnv } : envOverrides,
      // X-ACB-Client-Version / X-ACB-Client-Platform on git's HTTP requests,
      // so the server records which build synced (electron/client-identity.ts).
      extraConfig: gitIdentityConfig(),
    })
  }

  return {
    create: createGit,
    // Search tab / Cmd+P / history panel: electron/git-search.ts (limits, what
    // is searched, no lazy fetch). The same git configuration as createGit, for a
    // process whose output is streamed and stopped early.
    searchCommand() {
      const { binary, envOverrides } = getResolvedGit()
      return configuredGitCommand({
        binary,
        askPassPath: getGitAskPassPath(),
        token: '', // read-only local commands: no server access
        appGitDir: deps.appGitDir(),
        envOverrides,
        extraConfig: gitIdentityConfig(),
      })
    },
    binaryStatus() {
      const { binary, fallback } = getResolvedGit()
      return { bundled: !fallback, binary }
    },
  }
}
