/**
 * Error lines on the shared stdout log (2026-10-31). An error's text is not
 * printed: a git error carries its command line and stderr (folder and file
 * paths, a private folder's name, a pre-receive rejection naming paths), and
 * other errors quote what a member sent. A line holds a fixed sentence written
 * by the caller, the error's kind (`name`, an id-shaped `code`, git's exit
 * code / signal), the request id of the request it happened in (the same id as
 * the request log line and the X-Request-Id header), and the code locations of
 * the stack — never the message.
 *
 *   [tag] what failed: Error code=ENOENT exit=128 request=<id>
 *       at …
 *
 * Use this instead of console.error(…, err) for anything that can hold an
 * error from git, the file system or a request (.claude/rules/server.md
 * "Request log").
 */
import { currentRequestId } from './request-log'

const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,40}$/
const MAX_FRAMES = 6

/** The error's kind, without its message: name, id-shaped code, exit code, signal. */
export function errorKind(err: unknown): string {
  if (!(err instanceof Error)) return typeof err === 'object' && err !== null ? 'non-Error object' : `non-Error ${typeof err}`
  const parts = [CODE_SHAPE.test(err.name) ? err.name : 'Error']
  const extra = err as Error & { code?: unknown; signal?: unknown; status?: unknown }
  if (typeof extra.code === 'string' && CODE_SHAPE.test(extra.code)) parts.push(`code=${extra.code}`)
  if (typeof extra.code === 'number' && Number.isInteger(extra.code)) parts.push(`exit=${extra.code}`)
  if (typeof extra.signal === 'string' && CODE_SHAPE.test(extra.signal)) parts.push(`signal=${extra.signal}`)
  if (typeof extra.status === 'number' && Number.isInteger(extra.status)) parts.push(`status=${extra.status}`)
  return parts.join(' ')
}

/** The stack's code locations (`at …` lines); the first line, which repeats the message, is left out. */
function frames(err: unknown): string[] {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return []
  // The stack starts with "<name>: <message>", and a message may span lines (git's stderr).
  const head = `${err.name}: ${err.message}`
  const rest = err.stack.startsWith(head) ? err.stack.slice(head.length) : err.stack.slice(err.stack.indexOf('\n    at ') + 1 || err.stack.length)
  return rest.split('\n').filter(line => /^\s+at /.test(line)).slice(0, MAX_FRAMES).map(line => `    ${line.trim()}`)
}

/**
 * Print `[tag] what: <kind> request=<id> <fields>` and the stack's locations.
 * `what` and `fields` are the caller's own fixed text and ids — never a path,
 * name or anything a member sent.
 */
export function logError(tag: string, what: string, err?: unknown, fields: Record<string, string | number | null | undefined> = {}): void {
  const request = currentRequestId()
  const parts = [`[${tag}] ${what}:`, err === undefined ? 'no error object' : errorKind(err)]
  if (request) parts.push(`request=${request}`)
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) parts.push(`${key}=${value}`)
  }
  console.error([parts.join(' '), ...frames(err)].join('\n'))
}
