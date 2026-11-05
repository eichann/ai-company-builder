import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GitResult } from '../../../shared/ipc-contract'
import { autoSyncNoticeFor, syncNoticeFor, syncNoticeHidesItself } from './model'

const result = (fields: Partial<GitResult>): GitResult => ({ success: true, ...fields }) as GitResult

test('whatever sync set aside is a warning that stays until dismissed, pointing at the backup', () => {
  const cases: Array<[Partial<GitResult>, string]> = [
    [{ restoredProtectedFiles: ['.claude/settings.json'], protectedBackupPath: '/b/protected' }, '/b/protected'],
    [{ restoredWriteDeniedFiles: ['総務/規程.md'], writeDeniedBackupPath: '/b/denied' }, '/b/denied'],
    [{ untrackedPersonalFiles: ['.personal/memo.md'], backupPath: '/b/personal' }, '/b/personal'],
    [{ outsideCheckoutFiles: ['開発部/new.md'], outsideCheckoutBackupPath: '/b/outside' }, '/b/outside'],
    [{ hadConflicts: true, conflictFiles: ['a.md', 'b.md'], backupPath: '/b/conflict' }, '/b/conflict'],
  ]
  for (const [fields, backupPath] of cases) {
    const r = result(fields)
    const notice = syncNoticeFor(r)
    assert.equal(notice.type, 'warning', JSON.stringify(fields))
    assert.equal(notice.backupPath, backupPath)
    assert.equal(syncNoticeHidesItself(r), false, 'a warning must not disappear on its own')
  }
})

test('the conflict notice says how many files and that the server version won', () => {
  assert.equal(syncNoticeFor(result({ hadConflicts: true, conflictFiles: ['a.md', 'b.md'] })).message, '2ファイルが競合しました。サーバー版で上書きしました。')
})

test('restored folders, large files and imported repositories warn without hiding', () => {
  for (const fields of [{ restoredFolders: ['営業部'] }, { ignoredLargeFiles: ['big.mov'] }, { excludedNestedRepos: ['tool'] }]) {
    const r = result(fields)
    assert.equal(syncNoticeFor(r).type, 'warning')
    assert.equal(syncNoticeHidesItself(r), false)
  }
})

test('a clean sync is a success that hides itself; a failure is an error that stays', () => {
  const clean = result({ message: '同期しました' })
  assert.deepEqual(syncNoticeFor(clean), { type: 'success', message: '同期しました' })
  assert.equal(syncNoticeHidesItself(clean), true)
  const failed = result({ success: false, error: 'サーバーに接続できません' })
  assert.deepEqual(syncNoticeFor(failed), { type: 'error', message: 'サーバーに接続できません' })
  assert.equal(syncNoticeHidesItself(failed), false)
})

const MESSAGE = '同期が完了しました。移したファイルがあります。'

// Each: what the member would otherwise never hear about, and where the notice points.
const lasting: Array<[string, Partial<GitResult>, string | undefined]> = [
  ['a private folder gone from this computer', { lostPrivateFolders: ['経営'] }, undefined],
  ['files in a reserved folder name', { reservedPathFiles: ['経営/a.md'], reservedPathBackupPath: '/b/reserved' }, '/b/reserved'],
  ['edits saved when a folder was made public', { madePublicFolders: ['経営'], madePublicBackupPath: '/b/public' }, '/b/public'],
  ['a folder moved out of a private folder\'s place', { movedAsideFolders: ['経営'], movedAsideBackupPath: '/b/moved' }, '/b/moved'],
  ['a conflict inside a private folder', { privateFolders: [{ path: '経営', success: true, setAside: true, backupPath: '/b/private' }] }, '/b/private'],
  ['files kept when a stopped sync was cleaned up', { recoveredFiles: ['x.md'], recoveryBackupPath: '/b/recovery' }, '/b/recovery'],
  ['this computer\'s files a teammate\'s replaced', { nestedRepoBackupFiles: ['tool/a.md'], nestedRepoBackupPath: '/b/nested' }, '/b/nested'],
  ['a large file a teammate\'s replaced', { largeFileBackupFiles: ['big.mov'], largeFileBackupPath: '/b/large' }, '/b/large'],
]

test('what sync moved or removed is a yellow notice that stays, with sync\'s own sentence and the backup', () => {
  for (const [what, fields, backupPath] of lasting) {
    const r = result({ message: MESSAGE, ...fields })
    const notice = syncNoticeFor(r)
    assert.deepEqual({ type: notice.type, message: notice.message, backupPath: notice.backupPath }, { type: 'warning', message: MESSAGE, backupPath }, what)
    assert.equal(syncNoticeHidesItself(r), false, what)
  }
})

test('an automatic send shows the same notice although nobody pressed anything', () => {
  for (const [what, fields] of lasting) {
    assert.equal(autoSyncNoticeFor(result({ message: MESSAGE, ...fields }), false)?.type, 'warning', what)
  }
})

test('an automatic send that failed still tells what it moved, also when that failure was shown before', () => {
  const failed = result({ success: false, error: '接続できません', recoveredFiles: ['x.md'], recoveryBackupPath: '/b/recovery' })
  assert.deepEqual(autoSyncNoticeFor(failed, false), { type: 'error', message: '接続できません', backupPath: '/b/recovery', mustSee: true })
})

test('an automatic send stays quiet about a plain success, and about a failure the member has seen', () => {
  assert.equal(autoSyncNoticeFor(result({ message: '同期が完了しました' }), false), null)
  const failed = result({ success: false, error: '接続できません' })
  assert.equal(autoSyncNoticeFor(failed, false), null)
  assert.equal(autoSyncNoticeFor(failed, true)?.type, 'error')
})

test('a private folder that synced with nothing set aside, or was just downloaded, keeps the notice quiet', () => {
  const r = result({ message: '同期が完了しました', privateFolders: [{ path: '経営', success: true, setAside: false }], madePublicFolders: ['公開'] })
  assert.equal(syncNoticeHidesItself(r), true)
})

test('a notice about something else still points at a backup the result only names as backupPath', () => {
  assert.equal(syncNoticeFor(result({ message: MESSAGE, lostPrivateFolders: ['経営'], backupPath: '/b/conflict' })).backupPath, '/b/conflict')
})

test('a restored department is said whichever notice wins', () => {
  for (const fields of [{ lostPrivateFolders: ['経営'] }, { hadConflicts: true, conflictFiles: ['a.md'] }]) {
    const notice = syncNoticeFor(result({ message: MESSAGE, restoredFolders: ['営業部'], ...fields }))
    assert.equal(notice.type, 'warning')
    assert.match(notice.message, /部署フォルダを復元しました: 営業部/)
    assert.match(notice.message, /移したファイルがあります/)
  }
})
