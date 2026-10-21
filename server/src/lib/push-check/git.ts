/**
 * git plumbing for the push checker.
 *
 * Runs as a child of `git receive-pack` (through the pre-receive hook), so it
 * inherits GIT_DIR, the quarantine variables (GIT_OBJECT_DIRECTORY,
 * GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_QUARANTINE_PATH) and the hook's
 * LC_ALL=C. Every git process it starts inherits them in turn, so it sees the
 * pushed objects exactly like the shell hook's git commands did.
 *
 * stderr is discarded like the shell hook's `2>/dev/null`; callers decide what
 * a failure means (the checks fail closed).
 */
import { spawn } from 'child_process'

export interface GitRun {
  /** true when git exited 0. */
  ok: boolean
  /** Everything git wrote to stdout (also on failure — the shell hook used partial output too). */
  stdout: Buffer
}

export interface GitOptions {
  input?: string | Buffer
  /** Extra environment on top of the inherited one. */
  env?: Record<string, string>
}

function start(args: string[], opts: GitOptions, command = 'git') {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  })
  child.stdin.on('error', () => { /* git may exit before reading all input */ })
  if (opts.input !== undefined) child.stdin.end(opts.input)
  else child.stdin.end()
  return child
}

export function runGit(args: string[], opts: GitOptions = {}): Promise<GitRun> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const child = start(args, opts)
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => {
      if (settled) return
      settled = true
      resolve({ ok: false, stdout: Buffer.concat(chunks) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({ ok: code === 0, stdout: Buffer.concat(chunks) })
    })
  })
}

/**
 * Stream git's stdout line by line ("\n"-separated, as awk reads it: a final
 * line without a newline is still delivered). Lines are byte strings (latin1),
 * so no byte is altered. Resolves true when git exited 0.
 */
export function streamGitLines(args: string[], onLine: (line: string) => void, opts: GitOptions = {}): Promise<boolean> {
  return streamLines('git', args, onLine, opts)
}

/** streamGitLines for another launcher (`xargs -0 git ...`). */
export function streamLines(command: string, args: string[], onLine: (line: string) => void, opts: GitOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let rest: Buffer = Buffer.alloc(0)
    let settled = false
    const child = start(args, opts, command)
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk
      let pos = 0
      for (;;) {
        const nl = buf.indexOf(10, pos)
        if (nl === -1) break
        onLine(buf.toString('latin1', pos, nl))
        pos = nl + 1
      }
      rest = pos < buf.length ? Buffer.from(buf.subarray(pos)) : Buffer.alloc(0)
    })
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (rest.length > 0) onLine(rest.toString('latin1'))
      rest = Buffer.alloc(0)
      resolve(ok)
    }
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}
