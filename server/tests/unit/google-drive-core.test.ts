/**
 * The Drive rules in shared/core (google-drive.md): least privilege of the scope model, the
 * Picker token's scope check, what may be put, when a folder reaches outside, and which pasted
 * links name a Drive file (only Google's own hosts, only a file, only an id of Google's characters).
 */
import { describe, expect, it } from 'vitest'
import { GOOGLE_ALLOWED_SCOPES, GOOGLE_FEATURE_SCOPES, GOOGLE_NEVER_SCOPES, GOOGLE_SCOPE, googleScopesFor, normalizeGrantedScopes } from '../../shared/core/google'
import { checkDriveFileName, checkDrivePutContent, driveFileIdFromLink, driveFileIdsFromText, driveFolderReachesOutside, drivePreselectIds, drivePutKindOf, isDrivePickerTokenScope } from '../../shared/core/google-drive'

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

describe('a pasted Drive link: only Google\'s own file addresses give an id', () => {
  const ID = '1AbC-def_GhIjKlMnOpQrStUv'

  it('Docs, Sheets, Slides and Drive file addresses (with an account number, an edit tail, ?usp)', () => {
    for (const url of [
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      `https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`,
      `https://docs.google.com/document/u/1/d/${ID}/edit`,
      `https://docs.google.com/file/d/${ID}`,
      `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
      `https://drive.google.com/file/u/0/d/${ID}/view`,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/uc?id=${ID}&export=download`,
      `  https://DRIVE.GOOGLE.COM/file/d/${ID}/view  `,
    ]) expect(driveFileIdFromLink(url), url).toBe(ID)
  })

  it('no id from another host, a look-alike, a sub-domain, another scheme, a user or a port', () => {
    for (const url of [
      `https://drive.google.com.evil.example/file/d/${ID}/view`,
      `https://evil.example/drive.google.com/file/d/${ID}/view`,
      `https://drive-google.com/file/d/${ID}/view`,
      `https://drive.google.co/file/d/${ID}/view`,
      `https://xn--drive-google-xyz.com/file/d/${ID}/view`,
      `https://sub.drive.google.com/file/d/${ID}/view`,
      `https://drive.google.com./file/d/${ID}/view`,
      `https://google.com/file/d/${ID}/view`,
      `http://drive.google.com/file/d/${ID}/view`,
      `javascript:alert('https://drive.google.com/file/d/${ID}/view')`,
      `file:///drive.google.com/file/d/${ID}`,
      `https://me@drive.google.com/file/d/${ID}/view`,
      `https://drive.google.com:8443/file/d/${ID}/view`,
      `drive.google.com/file/d/${ID}/view`,
      ID,
    ]) expect(driveFileIdFromLink(url), url).toBeNull()
  })

  it('no id from a folder, another kind of page, or an id that is not Google\'s shape', () => {
    for (const url of [
      `https://drive.google.com/drive/folders/${ID}`,
      `https://drive.google.com/drive/u/0/folders/${ID}`,
      `https://docs.google.com/forms/d/${ID}/edit`,
      `https://docs.google.com/document/d/e/2PACX-1vQpublished/pub`,
      'https://drive.google.com/file/d/short/view',
      `https://drive.google.com/file/d/${'a'.repeat(201)}/view`,
      'https://drive.google.com/file/d/abc%2F..%2Fdefghijk/view',
      'https://drive.google.com/file/d/abc def ghijklm/view',
      `https://drive.google.com/open?id=${ID}&id=other-id-0123456789`,
      'https://drive.google.com/open?id=bad id here!',
      'https://drive.google.com/open',
      '',
    ]) expect(driveFileIdFromLink(url), url).toBeNull()
    expect(driveFileIdFromLink(42)).toBeNull()
    expect(driveFileIdFromLink(`https://drive.google.com/file/d/${ID}/view`.padEnd(3000, 'x'))).toBeNull()
  })

  it('a pasted text: each Drive file address once, at most 10, the rest ignored', () => {
    const other = 'zYxW-vut_srqponmlkji'
    expect(driveFileIdsFromText(`見て https://docs.google.com/document/d/${ID}/edit と\nhttps://evil.example/file/d/${other}/view https://drive.google.com/file/d/${ID}/view https://drive.google.com/file/d/${other}/view`)).toEqual([ID, other])
    const many = Array.from({ length: 12 }, (_, i) => `https://drive.google.com/file/d/${ID}${i.toString().padStart(2, '0')}/view`).join(' ')
    expect(driveFileIdsFromText(many)).toHaveLength(10)
    expect(driveFileIdsFromText('ただの文')).toEqual([])
    expect(driveFileIdsFromText(null)).toEqual([])
  })

  it('ids handed on to the Picker: Drive ids only, once each, at most 10', () => {
    expect(drivePreselectIds([ID, ID, 'bad id', "x');alert(1)//", 7, 'short'])).toEqual([ID])
    expect(drivePreselectIds('not-a-list-0123456789')).toEqual([])
    expect(drivePreselectIds(Array.from({ length: 12 }, (_, i) => `${ID}${i.toString().padStart(2, '0')}`))).toHaveLength(10)
  })
})
