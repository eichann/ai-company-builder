/**
 * The Drive rules in shared/core (google-drive.md): least privilege of the scope model, the
 * Picker token's scope check, what may be put, and when a folder reaches outside.
 */
import { describe, expect, it } from 'vitest'
import { GOOGLE_ALLOWED_SCOPES, GOOGLE_FEATURE_SCOPES, GOOGLE_NEVER_SCOPES, GOOGLE_SCOPE, googleScopesFor, normalizeGrantedScopes } from '../../shared/core/google'
import { checkDriveFileName, checkDrivePutContent, driveFolderReachesOutside, drivePutKindOf, isDrivePickerTokenScope } from '../../shared/core/google-drive'

const enc = (s: string) => new TextEncoder().encode(s)

describe('Drive scopes: drive.file and nothing wider', () => {
  it('the feature drive asks only drive.file (with the identity scopes)', () => {
    expect(GOOGLE_FEATURE_SCOPES.drive).toEqual([GOOGLE_SCOPE.driveFile])
    expect(googleScopesFor(['drive'])).toEqual(['openid', 'email', GOOGLE_SCOPE.driveFile])
  })

  it('no scope ACB may hold or ask is one it must never have', () => {
    for (const never of GOOGLE_NEVER_SCOPES) expect(GOOGLE_ALLOWED_SCOPES).not.toContain(never)
    expect(GOOGLE_NEVER_SCOPES).toContain('https://www.googleapis.com/auth/drive')
    expect(GOOGLE_NEVER_SCOPES).toContain('https://www.googleapis.com/auth/drive.readonly')
    // Google reporting a wider Drive scope is never stored.
    expect(normalizeGrantedScopes('openid https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file')).toEqual([GOOGLE_SCOPE.driveFile, 'openid'])
  })

  it('the Picker token must carry exactly drive.file', () => {
    expect(isDrivePickerTokenScope(GOOGLE_SCOPE.driveFile)).toBe(true)
    expect(isDrivePickerTokenScope(`${GOOGLE_SCOPE.driveFile} ${GOOGLE_SCOPE.gmailSend}`)).toBe(false)
    expect(isDrivePickerTokenScope(`openid ${GOOGLE_SCOPE.driveFile}`)).toBe(false)
    expect(isDrivePickerTokenScope('')).toBe(false)
    expect(isDrivePickerTokenScope(undefined)).toBe(false)
  })
})

describe('what may be put', () => {
  it('PDF and HTML only, by extension', () => {
    expect(drivePutKindOf('a.pdf')).toBe('pdf')
    expect(drivePutKindOf('a.HTML')).toBe('html')
    expect(drivePutKindOf('a.htm')).toBe('html')
    for (const n of ['a.docx', 'a.pdf.exe', 'a', 'a.svg', 'a.js']) expect(drivePutKindOf(n)).toBeNull()
  })

  it('the content is what its kind says', () => {
    expect(checkDrivePutContent('pdf', enc('%PDF-1.7\n'))).toBeNull()
    expect(checkDrivePutContent('pdf', enc('<html>'))).not.toBeNull()
    expect(checkDrivePutContent('html', enc('<p>提案</p>'))).toBeNull()
    expect(checkDrivePutContent('html', new Uint8Array([0x3c, 0x00, 0x3e]))).not.toBeNull()
    expect(checkDrivePutContent('html', new Uint8Array([0xff, 0xfe, 0x3c]))).not.toBeNull()
    expect(checkDrivePutContent('pdf', new Uint8Array())).not.toBeNull()
  })

  it('the name: one segment, no control characters, the kind\'s extension', () => {
    expect(checkDriveFileName('提案書.pdf', 'pdf')).toEqual({ name: '提案書.pdf' })
    for (const bad of ['a/b.pdf', 'a\\b.pdf', '..', 'a\n.pdf', 'a.html', '']) expect('error' in checkDriveFileName(bad, 'pdf'), bad).toBe(true)
  })
})

describe('a folder reaches outside', () => {
  const D = 'div.example'
  it('internal people and the company domain: no', () => {
    expect(driveFolderReachesOutside([{ type: 'user', emailAddress: 'sato@div.example' }, { type: 'domain', domain: 'DIV.example' }, { type: 'group', emailAddress: 'sales@div.example' }], D)).toBe(false)
  })
  it('anyone with the link, another domain, an outside person or group, an unknown kind: yes', () => {
    expect(driveFolderReachesOutside([{ type: 'anyone' }], D)).toBe(true)
    expect(driveFolderReachesOutside([{ type: 'domain', domain: 'a-corp.example' }], D)).toBe(true)
    expect(driveFolderReachesOutside([{ type: 'user', emailAddress: 'suzuki@a-corp.example' }], D)).toBe(true)
    expect(driveFolderReachesOutside([{ type: 'group', emailAddress: 'x@sub.div.example' }], D)).toBe(true)
    expect(driveFolderReachesOutside([{ type: 'user' }], D)).toBe(true)
    expect(driveFolderReachesOutside([{ type: 'something-new' }], D)).toBe(true)
  })
})
