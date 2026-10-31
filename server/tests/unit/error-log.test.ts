/**
 * Unit Test: error lines (lib/error-log.ts) never print an error's text.
 *
 * A git error's message is its command line plus stderr — file paths, a
 * private folder's name, the push checker's rejections. The shared log gets
 * the caller's fixed sentence, the error's kind (name, code, exit code) and
 * the stack's code locations only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { errorKind, logError } from '../../src/lib/error-log'

const SECRET = '人事評価_極秘'

function gitError(): Error {
  // The shape lib/git-exec.ts throws, with a multi-line stderr that even looks like a stack frame.
  const stderr = `fatal: path '営業部/${SECRET}/査定.md' does not exist\n    at ${SECRET}/給与.md`
  return Object.assign(new Error(`Command failed: git show main:営業部/${SECRET}/査定.md (exit 128)\n${stderr}`), { code: 128, signal: null, stderr })
}

afterEach(() => { vi.restoreAllMocks() })

describe('logError', () => {
  it('prints the fixed sentence, the kind and code locations — not the message, stderr or a path', () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })

    logError('company-files', 'failed to read company files', gitError())
    const fsError = Object.assign(new Error(`ENOENT: no such file or directory, open '/data/repos/x/${SECRET}'`), { code: 'ENOENT' })
    logError('departments', 'failed to create a department', fsError)

    const out = lines.join('\n')
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('営業部')
    expect(out).not.toContain('Command failed')
    expect(out).toMatch(/^\[company-files\] failed to read company files: Error exit=128$/m)
    expect(out).toMatch(/^\[departments\] failed to create a department: Error code=ENOENT$/m)
    expect(out).toMatch(/^ {4}at .*error-log\.test\.ts/m) // where it happened stays findable
  })

  it('a code that is not id-shaped is left out', () => {
    expect(errorKind(Object.assign(new Error('x'), { code: `bad ${SECRET}` }))).toBe('Error')
    expect(errorKind('a string with a path 営業部/x')).toBe('non-Error string')
  })
})
