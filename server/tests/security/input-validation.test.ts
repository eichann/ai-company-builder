/**
 * Security Test: Input validation
 *
 * Ensures user-supplied inputs are validated before use.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROUTES_DIR = join(__dirname, '../../src/routes')

describe('Input validation', () => {
  it('department update must validate new folder name if provided', () => {
    const content = readFileSync(join(ROUTES_DIR, 'departments.ts'), 'utf-8')

    const putIdx = content.indexOf("departmentsRoute.put('/:id',")
    expect(putIdx).toBeGreaterThan(-1)

    const body = content.slice(putIdx, putIdx + 2000)
    // The check runs in the service (after the repository check, as before)
    expect(body, 'PUT /:id must hand the update to the department service').toMatch(/departments\.update\(/)
    const service = readFileSync(join(ROUTES_DIR, '../services/departments.ts'), 'utf-8')
    const update = service.slice(service.indexOf('async update('))
    expect(update.slice(0, 1500), 'the update must validate a new folder name').toMatch(/isValidFolderName\(body\.folder\)[\s\S]*bad-request/)
  })

  it('git-http must validate service parameter', () => {
    const content = readFileSync(join(ROUTES_DIR, 'git-http.ts'), 'utf-8')

    // Must whitelist allowed service values
    expect(content).toMatch(/git-upload-pack.*git-receive-pack|git-receive-pack.*git-upload-pack/)
  })
})
