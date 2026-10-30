/**
 * Security Test: No execSync usage in route files
 *
 * execSync passes strings through /bin/sh, allowing command injection
 * via backticks, $(), and other shell metacharacters.
 * All git/shell operations must use execFile / spawn (no shell
 * interpretation) — and asynchronously: the second suite below refuses
 * execFileSync / spawnSync / execSync anywhere in src/ outside an explicit
 * allow-list of startup-time code.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { readdirSync } from 'fs'

const ROUTES_DIR = join(__dirname, '../../src/routes')
const SRC_DIR = join(__dirname, '../../src')

// Get all route files
function getRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => join(ROUTES_DIR, f))
}

// Get all TypeScript files under src/
function getAllSrcFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...getAllSrcFiles(fullPath))
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath)
    }
  }
  return results
}

describe('No execSync in server code', () => {
  it('no source file should use execSync', () => {
    const violations: string[] = []

    for (const filePath of getAllSrcFiles(SRC_DIR)) {
      const content = readFileSync(filePath, 'utf-8')
      if (/\bexecSync\b/.test(content)) {
        const relative = filePath.replace(SRC_DIR + '/', '')
        violations.push(relative)
      }
    }

    expect(violations).toEqual([])
  })

  it('route files must not use exec() (callback-based shell execution)', () => {
    const violations: string[] = []

    for (const filePath of getRouteFiles()) {
      const content = readFileSync(filePath, 'utf-8')
      // Match standalone `exec(` but not `execFileSync(` or `execFile(`
      // Also allow `spawn(` which is safe (no shell)
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip import lines
        if (line.includes('import ')) continue
        // Match `exec(` that is not part of execFile/execFileSync
        if (/\bexec\s*\(/.test(line) && !/\bexecFile/.test(line)) {
          const fileName = filePath.replace(ROUTES_DIR + '/', '')
          violations.push(`${fileName}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

/**
 * Files (relative to src/) allowed to run a synchronous child process, each
 * with the reason. Nothing reachable from a request handler belongs here.
 */
const SYNC_CHILD_PROCESS_ALLOWED: Record<string, string> = {
  // configureBareRepo / configureAllBareRepos: run once at startup
  // (index.ts, before the server listens) and by tests. Company creation uses
  // the async initBareRepo / configureBareRepoAsync.
  'lib/git-server/index.ts': 'startup-time repository configuration',
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

describe('No synchronous child process in server code', () => {
  // The server is one process: request handlers, every member's git-http
  // fetch/push, login and the admin panel share its event loop. A
  // synchronous child process blocks all of them for as long as it runs —
  // company creation's execFileSync push waited on the pre-receive checker
  // with no limit at all.
  it('no source file runs execFileSync / spawnSync / execSync outside the allow-list', () => {
    const violations: string[] = []
    for (const filePath of getAllSrcFiles(SRC_DIR)) {
      const relative = filePath.replace(SRC_DIR + '/', '')
      if (relative in SYNC_CHILD_PROCESS_ALLOWED) continue
      const lines = withoutComments(readFileSync(filePath, 'utf-8')).split('\n')
      lines.forEach((line, i) => {
        if (/\b(execFileSync|spawnSync|execSync)\b/.test(line)) violations.push(`${relative}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(violations).toEqual([])
  })

  it('every allow-listed file still exists and still needs its entry', () => {
    for (const relative of Object.keys(SYNC_CHILD_PROCESS_ALLOWED)) {
      const content = withoutComments(readFileSync(join(SRC_DIR, relative), 'utf-8'))
      expect(content, `${relative} no longer runs a synchronous child process: remove it from the allow-list`)
        .toMatch(/\b(execFileSync|spawnSync|execSync)\b/)
    }
  })

  it('the synchronous repository setup is not called from request handlers', () => {
    // initBareRepo is async; configureBareRepo (sync) is for startup only
    const violations: string[] = []
    for (const filePath of getRouteFiles()) {
      const lines = withoutComments(readFileSync(filePath, 'utf-8')).split('\n')
      lines.forEach((line, i) => {
        if (/\bconfigureBareRepo\s*\(/.test(line)) violations.push(`${filePath.replace(ROUTES_DIR + '/', '')}:${i + 1}`)
      })
    }
    expect(violations).toEqual([])
  })
})
