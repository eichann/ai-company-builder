/**
 * Security Test: No execSync usage in route files
 *
 * execSync passes strings through /bin/sh, allowing command injection
 * via backticks, $(), and other shell metacharacters.
 * All git/shell operations must use execFileSync (no shell interpretation).
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
  it('route files must not import execSync', () => {
    const violations: string[] = []

    for (const filePath of getRouteFiles()) {
      const content = readFileSync(filePath, 'utf-8')
      // Match: import { execSync } or import { ..., execSync, ... }
      if (/\bexecSync\b/.test(content)) {
        const fileName = filePath.replace(ROUTES_DIR + '/', '')
        violations.push(fileName)
      }
    }

    expect(violations).toEqual([])
  })

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

  it('route files that use child_process must use safe APIs (execFileSync or spawn)', () => {
    for (const filePath of getRouteFiles()) {
      const content = readFileSync(filePath, 'utf-8')
      if (/child_process/.test(content)) {
        const fileName = filePath.replace(ROUTES_DIR + '/', '')
        // execFileSync and spawn are safe (no shell interpretation)
        const hasSafeApi = /\bexecFileSync\b/.test(content) || /\bspawn\b/.test(content)
        expect(hasSafeApi, `${fileName} must use execFileSync or spawn, not execSync`).toBe(true)
      }
    }
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
