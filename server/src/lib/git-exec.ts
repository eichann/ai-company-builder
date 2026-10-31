/**
 * The API process's git runner: every git the server runs in its own
 * process goes through gitAsync (the push checker, which runs inside the
 * pre-receive hook, has its own in lib/push-check/git.ts).
 *
 * Asynchronous only: this process also serves every member's git-http
 * traffic, and a synchronous git call in a request handler froze all of it
 * (tests/security/no-exec-sync.test.ts).
 *
 * Environment: this process's, then GIT_TERMINAL_PROMPT=0 (git must never
 * wait for credentials), then `env` on top.
 */
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface GitAsyncOptions {
  input?: string
  /** Added to (and overriding) this process's environment. */
  env?: NodeJS.ProcessEnv
  /**
   * Watchdog: kill git — with everything it started — and reject after this
   * many milliseconds. Meant for git that runs a hook (a push into a local
   * bare repository runs the pre-receive checker): without it a hung hook
   * leaves the request waiting forever.
   */
  timeoutMs?: number
  /** Largest stdout accepted (bytes); git is killed and the call rejects beyond it. Default 512 MiB. */
  maxBuffer?: number
}

/** A git invocation killed by the gitAsync watchdog. */
export class GitTimeoutError extends Error {
  constructor(args: string[], timeoutMs: number) {
    const command = args.filter(a => a !== '-C' && !a.startsWith('/')).slice(0, 3).join(' ')
    super(`git ${command} timed out after ${Math.round(timeoutMs / 1000)} s`)
    this.name = 'GitTimeoutError'
  }
}

const GIT_MAX_BUFFER = 512 * 1024 * 1024

export async function gitAsync(args: string[], opts: GitAsyncOptions = {}): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) }
  const maxBuffer = opts.maxBuffer ?? GIT_MAX_BUFFER
  if (opts.timeoutMs !== undefined) return gitWithWatchdog(args, env, opts.input, opts.timeoutMs, maxBuffer)
  const child = execFileAsync('git', args, { encoding: 'utf8', maxBuffer, env })
  if (opts.input !== undefined) {
    child.child.stdin?.end(opts.input)
  }
  const { stdout } = await child
  return stdout
}

/**
 * gitAsync for output that must stay bytes (`cat-file --batch`: its headers
 * count bytes, so the content cannot be decoded before it is split).
 */
export async function gitBufferAsync(args: string[], input?: string, maxBuffer = GIT_MAX_BUFFER): Promise<Buffer> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const child = execFileAsync('git', args, { encoding: 'buffer', maxBuffer, env })
  if (input !== undefined) child.child.stdin?.end(input)
  const { stdout } = await child
  return stdout
}

/**
 * gitAsync with a watchdog. git runs in its own process group (spawn
 * `detached`; execFile does not pass that option on) so the watchdog kills it
 * together with what it started — receive-pack, the hook, the checker. They
 * hold the output pipes: killing git alone would leave the call open until
 * they finish. The promise rejects at the deadline regardless.
 */
function gitWithWatchdog(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string | undefined,
  timeoutMs: number,
  maxBuffer: number,
): Promise<string> {
  const ownGroup = process.platform !== 'win32'
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { env, detached: ownGroup, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error: Error | null, out?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(out ?? '')
    }
    const kill = () => {
      try {
        if (ownGroup && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish(new GitTimeoutError(args, timeoutMs))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBuffer) {
        kill()
        finish(new Error(`git ${args[0]}: output exceeds ${maxBuffer} bytes`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 1024) stderr.push(chunk) })
    child.on('error', error => finish(error))
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(null, Buffer.concat(stdout).toString('utf8'))
        return
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim()
      const error = new Error(`Command failed: git ${args.join(' ')} (${signal ?? `exit ${code}`})${detail ? `\n${detail}` : ''}`)
      Object.assign(error, { code, signal, stderr: detail })
      finish(error)
    })
    child.stdin.on('error', () => { /* git exited before reading its input */ })
    child.stdin.end(input)
  })
}
