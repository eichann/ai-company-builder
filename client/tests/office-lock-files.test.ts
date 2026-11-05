// Which names are office lock / temporary files (never shared) and which lock
// names say a file is open (client/shared/office-lock-files.ts). That sync
// ignores them and holds open files back: tests/sync/open-files.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOfficeLockFile, lockNamesFor } from '../shared/office-lock-files'

test('isOfficeLockFile: Office owner files, Word temporary files and LibreOffice locks, at any depth', () => {
  for (const p of ['~$見積.xlsx', '営業部/~$cument.docx', '営業部/2026/.~lock.見積.xlsx#', '~WRL0001.tmp', '営業部/~WRD0000.tmp']) {
    assert.equal(isOfficeLockFile(p), true, p)
  }
  for (const p of ['見積.xlsx', '~$', '営業部/$見積.xlsx', '.~lock.#', '.~lock.見積.xlsx', '~WRL0001.txt', '営業部/~$dir/notes.md', 'notes~$.md']) {
    assert.equal(isOfficeLockFile(p), false, p)
  }
})

test('lockNamesFor: the full name everywhere; Word\'s shortened owner file by Word\'s rule, for Word documents only', () => {
  assert.deepEqual(lockNamesFor('見積.xlsx'), ['~$見積.xlsx', '.~lock.見積.xlsx#'])
  assert.deepEqual(lockNamesFor('Document.docx').slice(2), ['~$cument.docx'], '8 or more: the first two characters go')
  assert.deepEqual(lockNamesFor('Report1.docx').slice(2), ['~$eport1.docx'], '7: the first one goes')
  assert.deepEqual(lockNamesFor('abcd.docx').slice(2), [], 'up to 6: the whole name (abcd.docx never matches ~$cd.docx)')
  assert.deepEqual(lockNamesFor('Help.doc'), ['~$Help.doc', '.~lock.Help.doc#'])
  assert.deepEqual(lockNamesFor('Document.xlsx').slice(2), [], 'Excel and PowerPoint keep the whole name')
  // Japanese stems: unknown whether Word counts characters or bytes, so both shortened forms count.
  assert.deepEqual(lockNamesFor('提案書2026.docx').slice(2), ['~$案書2026.docx', '~$書2026.docx'])
  assert.deepEqual(lockNamesFor('提案.docx').slice(2), [])
})

test('officeAppIn: the Mac process list names a running Office or LibreOffice app', async () => {
  const { officeAppIn } = await import('../electron/sync/open-files')
  assert.equal(officeAppIn('/sbin/launchd\n/Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel\n'), true)
  assert.equal(officeAppIn('/Applications/LibreOffice.app/Contents/MacOS/soffice\n'), true)
  assert.equal(officeAppIn('/sbin/launchd\n/Applications/Numbers.app/Contents/MacOS/Numbers\n/usr/bin/Microsoft Excel Helper\n'), false)
})
