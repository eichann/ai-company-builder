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
  it('company creation must validate name input', () => {
    const content = readFileSync(join(ROUTES_DIR, 'companies.ts'), 'utf-8')

    // Find the POST / handler
    const postIdx = content.indexOf("companiesRoute.post('/',")
    expect(postIdx).toBeGreaterThan(-1)

    const body = content.slice(postIdx, postIdx + 1500)

    // Must validate name is present and is a string
    expect(body).toMatch(/!name|typeof name/)
    // Must return 400 for invalid input
    expect(body).toMatch(/400/)
  })

  it('department creation must validate folder name format', () => {
    const content = readFileSync(join(ROUTES_DIR, 'departments.ts'), 'utf-8')

    // Must have isValidFolderName check
    expect(content).toMatch(/isValidFolderName/)

    // The POST handler must call it
    const postIdx = content.indexOf("departmentsRoute.post('/',")
    expect(postIdx).toBeGreaterThan(-1)

    const body = content.slice(postIdx, postIdx + 2000)
    expect(body, 'POST / must validate folder name').toMatch(/isValidFolderName/)
    expect(body, 'POST / must return 400 for invalid folder').toMatch(/400/)
  })

  it('department update must validate new folder name if provided', () => {
    const content = readFileSync(join(ROUTES_DIR, 'departments.ts'), 'utf-8')

    const putIdx = content.indexOf("departmentsRoute.put('/:id',")
    expect(putIdx).toBeGreaterThan(-1)

    const body = content.slice(putIdx, putIdx + 2000)
    expect(body, 'PUT /:id must validate new folder name').toMatch(/isValidFolderName/)
  })

  it('git-http must validate service parameter', () => {
    const content = readFileSync(join(ROUTES_DIR, 'git-http.ts'), 'utf-8')

    // Must whitelist allowed service values
    expect(content).toMatch(/git-upload-pack.*git-receive-pack|git-receive-pack.*git-upload-pack/)
  })

  it('invitation creation must validate role parameter', () => {
    const content = readFileSync(join(ROUTES_DIR, 'invitations.ts'), 'utf-8')

    const postIdx = content.indexOf("invitationsRoute.post('/companies/:companyId/invitations'")
    expect(postIdx).toBeGreaterThan(-1)

    const body = content.slice(postIdx, postIdx + 1500)
    // Must validate role is one of the allowed values
    expect(body).toMatch(/admin.*member|includes\(role\)/)
    expect(body).toMatch(/400/)
  })

  it('member addition must validate role parameter', () => {
    const content = readFileSync(join(ROUTES_DIR, 'companies.ts'), 'utf-8')

    const postIdx = content.indexOf("companiesRoute.post('/:id/members'")
    expect(postIdx).toBeGreaterThan(-1)

    const body = content.slice(postIdx, postIdx + 1500)
    // Must validate role
    expect(body).toMatch(/owner.*admin.*member|includes\(role\)/)
    expect(body).toMatch(/Invalid role/)
  })
})
