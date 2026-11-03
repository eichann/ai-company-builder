/**
 * The invitation page links members to APP_DOWNLOAD_URL: only an https URL
 * without credentials is ever offered (a mistyped http:// or javascript: value
 * must not become a download link on a public page).
 */
import { describe, expect, it } from 'vitest'
import { appDownloadUrl } from '../../src/lib/config'

describe('appDownloadUrl', () => {
  it('offers an https URL as is', () => {
    expect(appDownloadUrl({ APP_DOWNLOAD_URL: ' https://example.com/acb/ACB.dmg ' })).toBe('https://example.com/acb/ACB.dmg')
  })

  it('offers nothing for any other scheme, credentials, or no value', () => {
    for (const value of ['http://example.com/ACB.dmg', 'javascript:alert(1)', 'file:///tmp/a.dmg', 'https://u:p@example.com/a.dmg', 'not a url', '', undefined]) {
      expect(appDownloadUrl({ APP_DOWNLOAD_URL: value }), String(value)).toBeNull()
    }
  })
})
