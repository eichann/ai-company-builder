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

test('lockNamesFor: the full name everywhere; Word\'s shortened owner file only for Word documents', () => {
  assert.deepEqual(lockNamesFor('見積.xlsx'), ['~$見積.xlsx', '.~lock.見積.xlsx#'])
  const word = lockNamesFor('Document.docx')
  assert.ok(word.includes('~$cument.docx'), 'Word drops the first two characters of a long name')
  assert.ok(lockNamesFor('Report1.docx').includes('~$eport1.docx'), 'and one of a seven-character one')
  assert.ok(lockNamesFor('ab.docx').every(n => n === '~$ab.docx' || n === '.~lock.ab.docx#'), 'a short name is never shortened to nothing')
})
