// Names inside a backup folder (client/electron/sync/backup-names.ts): a
// member's files never share a copy, and none meets the backup's own
// _metadata.json — also where A–Z case does not count (a Mac's disk).
// End to end: tests/sync/scenarios.test.ts 「a member's own top-level
// _metadata.json survives a conflict backup…」.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKUP_METADATA_FILE, backupCopyName } from '../electron/sync/backup-names'

const caseless = (name: string) => name.toLowerCase()

test('no two member paths share a backup copy, and none is the backup\'s own metadata, even where case does not count', () => {
  const members = [
    '_metadata.json', '_Metadata.JSON', '_METADATA.json',
    '_metadata (member).json', '_metadata (MEMBER).json', '_Metadata (Member).Json',
    '_metadata (member) (member).json',
    '_metadata.json/inner.md', '_metadata (member).json/inner.md',
    'notes.md', '_metadata.md', 'sub/_metadata.json',
  ]
  const copies = members.map(f => backupCopyName(f))
  // Paths that are distinct for the member (by case on a case-sensitive disk) keep distinct copies.
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (caseless(members[i]) === caseless(members[j])) continue // one file on a Mac
      assert.notEqual(caseless(copies[i]), caseless(copies[j]), `${members[i]} / ${members[j]}`)
    }
  }
  for (const c of copies) assert.notEqual(caseless(c.split('/')[0]), caseless(BACKUP_METADATA_FILE), c)
  // Names outside the family and anything below the root stay as they are; a private folder's copies too.
  assert.equal(backupCopyName('notes.md'), 'notes.md')
  assert.equal(backupCopyName('sub/_metadata.json'), 'sub/_metadata.json')
  assert.equal(backupCopyName('_metadata.json', '人事/評価/'), '_metadata.json')
  assert.equal(backupCopyName('_metadata (MEMBER).json'), '_metadata (MEMBER) (member).json')
})
