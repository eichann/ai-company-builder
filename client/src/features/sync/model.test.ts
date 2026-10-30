import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncNoticeFor, syncNoticeHidesItself, type SyncResult } from './model'

const result = (fields: Partial<SyncResult>): SyncResult => ({ success: true, ...fields }) as SyncResult

test('whatever sync set aside is a warning that stays until dismissed, pointing at the backup', () => {
  const cases: Array<[Partial<SyncResult>, string]> = [
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
