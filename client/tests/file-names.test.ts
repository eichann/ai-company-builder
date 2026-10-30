// Names typed into the file tree's 新規ファイル / 新しいフォルダ / 名前を変更
// (shared/file-names.ts): a name one of the members' computers cannot hold
// would break every teammate's sync on that computer, so it is refused before
// anything is written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileNameProblem, folderPathProblem } from '../shared/file-names'

test('names every Mac and Windows PC can hold are accepted, Japanese and spaces included', () => {
  for (const ok of ['議事録 10月.md', 'README', '.gitignore', '2026春 (1).pdf', 'a.b.c', '－全角－.txt', 'con-notes.md', 'x'.repeat(255)]) {
    assert.equal(fileNameProblem(ok), null, ok)
  }
})

test('names that break a folder on some computer, or the repository, are refused with a reason', () => {
  const refused = [
    '', '  ', 'a/b.md', 'a\\b.md', '.', '..', '.git', '.GIT',
    '会議:10月.md', 'what?.md', 'a*b', 'a<b>', 'a"b', 'a|b', 'tab\there',
    'trailing.', 'trailing ', 'CON', 'con.txt', 'Lpt1.md', 'NUL',
    'あ'.repeat(86), // 258 bytes in UTF-8
  ]
  for (const bad of refused) assert.notEqual(fileNameProblem(bad), null, JSON.stringify(bad))
})

test('a new folder may be nested with "/", each part checked; empty parts are refused', () => {
  assert.equal(folderPathProblem('2026/10月'), null)
  assert.notEqual(folderPathProblem('2026//10月'), null)
  assert.notEqual(folderPathProblem('/2026'), null)
  assert.notEqual(folderPathProblem('2026/a:b'), null)
})
