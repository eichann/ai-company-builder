// Signing in to the member's own Claude Code from the app, without a terminal.
// The app starts the official CLI's own `claude auth login` (which opens
// Anthropic's page in the browser and keeps the login itself) and asks
// `claude auth status --json`. It never reads, stores, logs or relays the
// login: only the state and the account kind leave this file
// (chat-and-agents.md "Signing in to Claude Code").

import {
  claudeSignInMessage, claudeSignInSupported, readClaudeAuthStatus, signInPageUrl, UNKNOWN_SIGN_IN,
  type ClaudeSignIn, type ClaudeSignInOutcome, type ClaudeSignInResult,
} from '../../shared/claude-sign-in'

/** The part of a spawned process this service uses (a ChildProcess fits). */
export interface SignInChild {
  stdout: { on(event: 'data', fn: (chunk: Buffer | string) => void): unknown } | null
  stdin: { end(): unknown } | null
  on(event: 'close', fn: (code: number | null) => void): unknown
  on(event: 'error', fn: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface ClaudeSignInDeps {
  /** The member's `claude` (services/claude-cli.ts), or null when it is not installed. */
  cliPath: () => string | null
  env: () => Record<string, string>
  /** `<cli> --version` output, '' when it does not answer. */
  readVersion: (cli: string, env: Record<string, string>) => Promise<string>
  /** Starts the CLI with the AI environment (agents/process.ts `spawnAgentProcess`). */
  spawn: (cli: string, args: string[], env: Record<string, string>) => SignInChild
  openExternal: (url: string) => Promise<void>
  loginTimeoutMs?: number
  statusTimeoutMs?: number
  killGraceMs?: number
}

export interface ClaudeSignInCheck {
  signIn: ClaudeSignIn
  /** False for a missing or too old CLI: the app offers no sign-in button there. */
  signInSupported: boolean
}

export interface ClaudeSignInService {
  /** What the CLI says now; several callers at once share one `auth status`. */
  check(): Promise<ClaudeSignInCheck>
  /** Starts `claude auth login`, or joins the one already running (any window, any company). */
  start(): Promise<ClaudeSignInResult>
  /** Stops a running sign-in; false when none runs. */
  cancel(): boolean
  /** Opens the sign-in page again when the browser did not open; false without one. */
  openPage(): Promise<boolean>
  /** On quit: a sign-in left running would keep its listener open after the app is gone. */
  stop(): void
}

interface RunningSignIn { promise: Promise<ClaudeSignInResult>; cancel: () => void; pageUrl?: string }
type StopReason = { by?: 'member' | 'timeout' }

const LOGIN_TIMEOUT_MS = 10 * 60_000
const STATUS_TIMEOUT_MS = 15_000
const OUTPUT_LIMIT = 16_384
const KILL_GRACE_MS = 5_000
// `claude auth login` exits with 130 when the member stops it.
const EXIT_CANCELLED = 130

export function createClaudeSignIn(deps: ClaudeSignInDeps): ClaudeSignInService {
  const supportedPaths = new Set<string>()
  let checking: Promise<ClaudeSignInCheck> | undefined
  let running: RunningSignIn | undefined

  async function supported(cli: string, env: Record<string, string>): Promise<boolean> {
    if (supportedPaths.has(cli)) return true
    const ok = claudeSignInSupported(await deps.readVersion(cli, env).catch(() => ''))
    // Only a passing CLI is remembered: the member may update an old one meanwhile.
    if (ok) supportedPaths.add(cli)
    return ok
  }

  function runStatus(cli: string, env: Record<string, string>): Promise<ClaudeSignIn> {
    return new Promise(resolve => {
      let out = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (value: ClaudeSignIn) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
      let child: SignInChild
      try { child = deps.spawn(cli, ['auth', 'status', '--json'], env) }
      catch { resolve(UNKNOWN_SIGN_IN); return }
      timer = setTimeout(() => { child.kill('SIGKILL'); done(UNKNOWN_SIGN_IN) }, deps.statusTimeoutMs ?? STATUS_TIMEOUT_MS)
      child.stdout?.on('data', chunk => { if (out.length < OUTPUT_LIMIT) out += chunk.toString() })
      child.stdin?.end()
      child.on('error', () => done(UNKNOWN_SIGN_IN))
      // The exit code is not trusted alone: only the CLI's own `loggedIn: false` means signed out.
      child.on('close', () => done(readClaudeAuthStatus(out)))
    })
  }

  async function freshCheck(): Promise<ClaudeSignInCheck> {
    const cli = deps.cliPath()
    if (!cli) return { signIn: UNKNOWN_SIGN_IN, signInSupported: false }
    const env = deps.env()
    if (!(await supported(cli, env))) return { signIn: UNKNOWN_SIGN_IN, signInSupported: false }
    return { signIn: await runStatus(cli, env), signInSupported: true }
  }

  function check(): Promise<ClaudeSignInCheck> {
    if (!checking) checking = freshCheck().finally(() => { checking = undefined })
    return checking
  }

  const result = (outcome: ClaudeSignInOutcome, signIn?: ClaudeSignIn): ClaudeSignInResult =>
    ({ outcome, message: claudeSignInMessage(outcome), ...(signIn ? { signIn } : {}) })

  async function signIn(cli: string, env: Record<string, string>, entry: RunningSignIn, stopped: StopReason): Promise<ClaudeSignInResult> {
    const exit = await new Promise<number | null | Error>(resolve => {
      let child: SignInChild
      try { child = deps.spawn(cli, ['auth', 'login'], env) }
      catch (error) { resolve(error instanceof Error ? error : new Error(String(error))); return }
      let out = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let force: ReturnType<typeof setTimeout> | undefined
      const done = (value: number | null | Error) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(force); resolve(value) } }
      // A CLI that ignores SIGTERM is killed and the sign-in ends anyway: never a half-done state.
      const stop = (by: 'member' | 'timeout') => {
        stopped.by ??= by
        child.kill('SIGTERM')
        force ??= setTimeout(() => { child.kill('SIGKILL'); done(null) }, deps.killGraceMs ?? KILL_GRACE_MS)
      }
      timer = setTimeout(() => stop('timeout'), deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS)
      entry.cancel = () => stop('member')
      // stdin stays open: closing it could read as "no code pasted". The output is never logged.
      child.stdout?.on('data', chunk => {
        if (out.length < OUTPUT_LIMIT) out += chunk.toString()
        entry.pageUrl ??= signInPageUrl(out)
      })
      child.on('error', error => done(error))
      child.on('close', code => done(code))
    })
    if (stopped.by === 'timeout') return result('timed-out')
    if (stopped.by) return result('cancelled')
    if (exit instanceof Error) return result((exit as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'failed')
    if (exit === EXIT_CANCELLED) return result('cancelled')
    if (exit !== 0) return result('failed')
    // Success is what the CLI reports afterwards, not the exit code alone.
    const after = await runStatus(cli, env)
    if (after.state === 'signed-in') return result('signed-in', after)
    return after.state === 'signed-out' ? result('still-signed-out', after) : result('unverified', after)
  }

  async function begin(entry: RunningSignIn, stopped: StopReason): Promise<ClaudeSignInResult> {
    const cli = deps.cliPath()
    if (!cli) return result('not-installed')
    const env = deps.env()
    if (!(await supported(cli, env))) return result('outdated')
    // Already signed in (another window finished, or the terminal / desktop app did): change nothing.
    const before = await runStatus(cli, env)
    if (before.state === 'signed-in') return result('signed-in', before)
    if (stopped.by) return result('cancelled')
    return signIn(cli, env, entry, stopped)
  }

  function start(): Promise<ClaudeSignInResult> {
    if (running) return running.promise
    const stopped: StopReason = {}
    const entry: RunningSignIn = { promise: Promise.resolve(result('failed')), cancel: () => { stopped.by ??= 'member' } }
    running = entry
    entry.promise = begin(entry, stopped)
      .catch(() => result('failed'))
      .finally(() => { if (running === entry) running = undefined })
    return entry.promise
  }

  return {
    check,
    start,
    cancel() {
      if (!running) return false
      running.cancel()
      return true
    },
    async openPage() {
      const url = running?.pageUrl
      if (!url) return false
      await deps.openExternal(url)
      return true
    },
    stop() { running?.cancel() },
  }
}
