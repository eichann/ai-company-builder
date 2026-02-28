/**
 * Security Test: Path traversal prevention
 *
 * All route files that handle companyId or file paths must sanitize
 * them to prevent directory traversal attacks (e.g., ../../etc/passwd).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { readdirSync } from 'fs'

const ROUTES_DIR = join(__dirname, '../../src/routes')

function getRouteFiles(): { name: string; content: string }[] {
  return readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => ({
      name: f,
      content: readFileSync(join(ROUTES_DIR, f), 'utf-8'),
    }))
}

describe('Path traversal prevention', () => {
  it('files using companyId in path construction must sanitize it', () => {
    const violations: string[] = []

    for (const { name, content } of getRouteFiles()) {
      // Check if the file builds filesystem paths with companyId
      const usesCompanyIdInPath =
        /join\(.*companyId/.test(content) ||
        /`\$\{.*companyId.*\}\.git`/.test(content) ||
        /`\$\{sanitizedId\}\.git`/.test(content)

      if (!usesCompanyIdInPath) continue

      // Must have sanitization via one of these patterns
      const hasSanitization =
        /sanitizedId/.test(content) ||
        /sanitizeCompanyId/.test(content) ||
        // getBareRepoPath in departments.ts has its own sanitize
        /getBareRepoPath/.test(content) ||
        // companies.ts passes generateId() output (not user input) to createCompanyRepo
        (name === 'companies.ts' && /createCompanyRepo/.test(content) && /generateId/.test(content))

      if (!hasSanitization) {
        violations.push(`${name}: uses companyId in path construction without sanitization`)
      }
    }

    expect(violations).toEqual([])
  })

  it('folder name validation rejects path traversal characters', () => {
    // Verify the isValidFolderName regex from departments.ts
    const deptContent = readFileSync(join(ROUTES_DIR, 'departments.ts'), 'utf-8')

    // Verify the function exists
    expect(deptContent, 'isValidFolderName function must exist in departments.ts')
      .toContain('isValidFolderName')

    // Use the known pattern directly (verified against source)
    // Pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
    expect(deptContent).toContain('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')

    const pattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

    // These must be rejected (path traversal, injection, etc.)
    const maliciousNames = [
      '../etc',
      '..\\etc',
      '.hidden',
      '/absolute',
      'path/traversal',
      'name;injection',
      'name`injection`',
      'name$(cmd)',
      '',
      ' ',
      '-startsWithDash',
      '.startsWithDot',
    ]

    for (const name of maliciousNames) {
      expect(
        pattern.test(name),
        `isValidFolderName should reject "${name}"`
      ).toBe(false)
    }

    // These must be accepted
    const validNames = [
      'sales',
      'my-dept',
      'dept_name',
      'dept.v2',
      'Department1',
    ]

    for (const name of validNames) {
      expect(
        pattern.test(name),
        `isValidFolderName should accept "${name}"`
      ).toBe(true)
    }
  })

  it('git-http route sanitizes repo parameter', () => {
    const content = readFileSync(join(ROUTES_DIR, 'git-http.ts'), 'utf-8')

    // Must have sanitizeCompanyId or equivalent
    expect(content).toMatch(/sanitizeCompanyId/)

    // sanitizeCompanyId must strip dangerous characters
    expect(content).toContain('[^a-zA-Z0-9_-]')
  })

  it('git route sanitizes companyId from URL params before building repo paths', () => {
    const content = readFileSync(join(ROUTES_DIR, 'git.ts'), 'utf-8')

    // Every endpoint handler that takes companyId from URL params must sanitize it
    // before using it in path construction.
    // Note: join(REPOS_DIR, name) in the list handler uses `name` from readdirSync
    // which is safe (not user input), so we check handler-level patterns instead.

    const lines = content.split('\n')

    // Find all route handlers that extract companyId from params
    for (let i = 0; i < lines.length; i++) {
      if (/c\.req\.param\(['"]companyId['"]\)/.test(lines[i])) {
        // Scan the next 5 lines for sanitization
        const context = lines.slice(i, i + 5).join('\n')
        expect(
          context,
          `git.ts:${i + 1} — companyId from param must be sanitized`
        ).toMatch(/sanitizedId/)
      }
    }
  })
})
