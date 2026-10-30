import { describe, expect, it } from 'vitest'

import { ApiError, type PermissionRule } from '@/lib/api'
import { describeRules, draftFromRules, losingEdit, previewAccess, rulesFromDraft, sameDraft } from '@/lib/edit-access'
import { describeError } from '@/lib/errors'
import { isValidFolderName, suggestFolderName } from '@/lib/folder-name'
import { compareBuilds, formatBuild, formatRelative, latest, parseBuild, parseServerDate } from '@/lib/format'
import { safeRedirect } from '@/lib/redirect'
import { explainRejection } from '@/lib/rejections'
import { members } from './fixtures'

describe('dates', () => {
  it('reads SQLite datetime() values as UTC', () => {
    expect(parseServerDate('2026-10-21 03:00:00')?.toISOString()).toBe('2026-10-21T03:00:00.000Z')
    expect(parseServerDate('2026-10-21T03:00:00.000Z')?.toISOString()).toBe('2026-10-21T03:00:00.000Z')
    expect(parseServerDate(null)).toBeNull()
    expect(parseServerDate('garbage')).toBeNull()
  })

  it('formats relative times in Japanese', () => {
    const now = new Date('2026-10-21T12:00:00Z')
    expect(formatRelative('2026-10-21T11:59:30Z', now)).toBe('たった今')
    expect(formatRelative('2026-10-21T11:55:00Z', now)).toBe('5分前')
    expect(formatRelative('2026-10-21T09:00:00Z', now)).toBe('3時間前')
    expect(formatRelative('2026-10-19T12:00:00Z', now)).toBe('2日前')
    expect(formatRelative(null, now)).toBe('—')
  })

  it('picks the latest timestamp', () => {
    expect(latest(null, '2026-10-20T00:00:00Z', '2026-10-21 00:00:00')).toBe('2026-10-21 00:00:00')
    expect(latest(null, undefined)).toBeNull()
  })
})

describe('client builds', () => {
  it('shows a friendly version', () => {
    expect(formatBuild({ semver: '0.0.1', sha: 'abc', commitDate: '20261021031200', dev: false })).toBe('0.0.1（2026/10/21 版）')
    expect(formatBuild({ semver: '0.0.1-dev', sha: 'abc', commitDate: '20261021031200', dev: true })).toBe('開発版 0.0.1（2026/10/21 版）')
    expect(formatBuild(null)).toBe('—')
    expect(formatBuild(null, 'weird')).toBe('weird')
  })

  it('parses raw versions like the server', () => {
    expect(parseBuild('0.0.1+95346af.20261021031200')).toEqual({ semver: '0.0.1', sha: '95346af', commitDate: '20261021031200', dev: false })
    expect(parseBuild('0.0.1-dev+nogit.00000000000000')).toEqual({ semver: '0.0.1-dev', sha: null, commitDate: null, dev: true })
    expect(parseBuild(null)).toBeNull()
  })

  it('orders builds: core, then release over pre-release, then commit date', () => {
    const b = (semver: string, commitDate: string | null) => ({ semver, sha: null, commitDate, dev: semver.includes('dev') })
    expect(compareBuilds(b('0.0.2', '20260101000000'), b('0.0.1', '20261231000000'))).toBe(1)
    expect(compareBuilds(b('0.0.1-dev', '20261231000000'), b('0.0.1', '20260101000000'))).toBe(-1)
    expect(compareBuilds(b('0.0.1', '20261001000000'), b('0.0.1', '20261021000000'))).toBe(-1)
    expect(compareBuilds(b('0.0.1', '20261021000000'), b('0.0.1', '20261021000000'))).toBe(0)
  })
})

describe('push rejections', () => {
  it('explains known markers in plain Japanese', () => {
    expect(explainRejection('PROTECTED_CONFIG')?.title).toBe('管理者だけが変更できる設定ファイルが含まれていた')
    expect(explainRejection('PERSONAL_PATH')?.title).toBe('個人用フォルダ(.personal)のファイルが含まれていた')
    expect(explainRejection('[SECRET_DETECTED]')?.title).toMatch(/秘密情報/)
    expect(explainRejection('WINPATH_DETECTED')?.title).toMatch(/Windows/)
  })

  it('returns null for unknown markers so the raw marker is shown', () => {
    expect(explainRejection('SOMETHING_NEW')).toBeNull()
  })
})

describe('errors', () => {
  it('turns API failures into next steps', () => {
    expect(describeError(new ApiError(403, 'Only owners'))).toMatch(/権限がありません/)
    expect(describeError(new ApiError(409, 'A folder with this name already exists'))).toMatch(/別のフォルダ名/)
    expect(describeError(new ApiError(500, 'boom'))).toMatch(/少し待って/)
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/サーバーに接続できません/)
  })
})

describe('redirects', () => {
  it('only allows same-origin paths', () => {
    expect(safeRedirect('/invite/abc')).toBe('/invite/abc')
    expect(safeRedirect('//evil.example')).toBe('/dashboard')
    expect(safeRedirect('https://evil.example')).toBe('/dashboard')
    expect(safeRedirect('/\\evil.example')).toBe('/dashboard')
    expect(safeRedirect(null)).toBe('/dashboard')
  })
})

// isValidFolderName itself is compared with the server's and the app's copies
// in client/tests/rule-parity-names.test.ts.
describe('folder names', () => {
  it('suggests a valid folder from a name', () => {
    expect(suggestFolderName('営業 企画部')).toBe('営業-企画部')
    expect(suggestFolderName('  Sales & Marketing ')).toBe('Sales-Marketing')
    expect(isValidFolderName(suggestFolderName('#マーケ'))).toBe(true)
  })
})

describe('per-place edit choice', () => {
  const rule = (subjectType: PermissionRule['subjectType'], subjectId: string | null, canWrite: boolean): PermissionRule => ({
    id: `${subjectType}:${subjectId}`,
    subjectType,
    subjectId,
    subjectLabel: subjectId ?? '全員',
    canRead: true,
    canWrite,
  })
  const tanaka = { subjectType: 'user', subjectId: 'u_member' } as const
  const roleMember = { subjectType: 'role', subjectId: 'member' } as const

  it('reads the three choices from rules', () => {
    expect(draftFromRules([])).toEqual({ draft: { mode: 'inherit', editors: [] }, custom: false })
    expect(draftFromRules([rule('everyone', null, true)])).toEqual({ draft: { mode: 'everyone', editors: [] }, custom: false })
    expect(draftFromRules([rule('everyone', null, false), rule('user', 'u_member', true), rule('role', 'member', true)])).toEqual({
      draft: { mode: 'specific', editors: [tanaka, roleMember] },
      custom: false,
    })
    // A redundant read-only rule under 指定した人だけ changes nothing.
    expect(draftFromRules([rule('everyone', null, false), rule('user', 'u_member', false)]).custom).toBe(false)
  })

  it('flags rules the choice cannot express', () => {
    expect(draftFromRules([rule('everyone', null, true), rule('user', 'u_member', false)]).custom).toBe(true)
    expect(draftFromRules([rule('everyone', null, false), rule('role', 'member', true), rule('user', 'u_member', false)]).custom).toBe(true)
    expect(draftFromRules([rule('user', 'u_member', true)]).custom).toBe(true)
  })

  it('writes a complete rule set for each choice', () => {
    expect(rulesFromDraft({ mode: 'inherit', editors: [tanaka] })).toEqual([])
    expect(rulesFromDraft({ mode: 'everyone', editors: [tanaka] })).toEqual([{ subjectType: 'everyone', subjectId: null, canWrite: true }])
    expect(rulesFromDraft({ mode: 'specific', editors: [tanaka] })).toEqual([
      { subjectType: 'everyone', subjectId: null, canWrite: false },
      { subjectType: 'user', subjectId: 'u_member', canWrite: true },
    ])
    expect(sameDraft({ mode: 'specific', editors: [tanaka, roleMember] }, { mode: 'specific', editors: [roleMember, tanaka] })).toBe(true)
    expect(sameDraft({ mode: 'everyone', editors: [tanaka] }, { mode: 'everyone', editors: [] })).toBe(true)
  })

  it('previews access like the server and finds who loses edit', () => {
    const open = previewAccess(members, [rule('everyone', null, true)], '')
    const only = previewAccess(members, rulesFromDraft({ mode: 'specific', editors: [] }), '営業部')
    expect(only.find((m) => m.userId === 'u_owner')).toMatchObject({ write: true, reason: 'role' })
    expect(only.find((m) => m.userId === 'u_member')).toMatchObject({ read: true, write: false, decidedBy: { path: '営業部', subjectLabel: '全員' } })
    expect(losingEdit(open, only).map((m) => m.userId)).toEqual(['u_member'])
    const userBeatsRole = previewAccess(members, [rule('everyone', null, false), rule('role', 'member', true), rule('user', 'u_member', false)], '')
    expect(userBeatsRole.find((m) => m.userId === 'u_member')?.write).toBe(false)
  })

  it('describes a rule set in one line', () => {
    expect(describeRules([rule('everyone', null, true)], members)).toBe('全員')
    expect(describeRules([rule('everyone', null, false), rule('user', 'u_member', true)], members)).toBe('指定した人だけ（田中 太郎）')
    expect(describeRules([rule('everyone', null, false)], members)).toBe('指定した人だけ（オーナーと管理者のみ）')
  })
})
