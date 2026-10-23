import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateWrite, isWriteAccess, normalizeRepoPath, readOnlyMessage, repoRelativePath, type WriteAccess } from '../shared/write-access'

// The server's RESTRICTED fixture (server/tests/unit/permissions.test.ts) as
// GET /me/write-access returns it for the member "bob" (writeAccessSummary).
const BOB: WriteAccess = {
  version: 'v1', role: 'member', all: false,
  scopes: [
    { path: '', write: false },
    { path: 'コンテンツ', write: true },
    { path: 'コンテンツ/受講生情報', write: false },
    { path: '人事部', write: true },
    { path: '人事部/給与', write: false },
    { path: '経理部', write: false },
  ],
}

// Whether the app lets a member write a path is compared with the server's push
// gate in rule-parity-write-access.test.ts (generated companies, NFC/NFD and
// A–Z spellings). What only the app uses is checked here: the deciding folder
// named in the refusal (scopePath) and path spellings the chat tools produce.
test('evaluateWrite names the deciding folder; slashes, backslashes and common prefixes', () => {
  const cases: Array<[string, boolean, string | null]> = [
    ['総務/x', false, ''], // decided by the company root
    ['人事部/評価', true, '人事部'],
    ['コンテンツ/受講生情報/添付/a.pdf', false, 'コンテンツ/受講生情報'], // transparent scopes are not listed
    ['/コンテンツ\\受講生情報//', false, 'コンテンツ/受講生情報'], // slashes / backslashes normalised
    ['コンテンツ受講生', false, ''], // a sibling with a common prefix is not a child
  ]
  for (const [path, write, scopePath] of cases) {
    assert.deepEqual(evaluateWrite(BOB, path), { write, scopePath }, path)
  }
})

test('nested exception: a writable folder inside a read-only one, read-only inside that', () => {
  const access: WriteAccess = { version: 'v', role: 'member', all: false, scopes: [
    { path: '', write: true }, { path: '営業部', write: false }, { path: '営業部/下書き', write: true }, { path: '営業部/下書き/確定', write: false },
  ] }
  assert.equal(evaluateWrite(access, '営業部/契約書/a.md').write, false)
  assert.equal(evaluateWrite(access, '営業部/下書き/a.md').write, true)
  assert.equal(evaluateWrite(access, '営業部/下書き/確定/a.md').write, false)
  assert.equal(evaluateWrite(access, '総務/a.md').write, true)
})

test('A–Z case variants are judged like the push check (both spellings must be writable)', () => {
  const access: WriteAccess = { version: 'v', role: 'member', all: false, scopes: [
    { path: '', write: true }, { path: 'Sales', write: false },
  ] }
  assert.equal(evaluateWrite(access, 'Sales/a.md').write, false)
  assert.equal(evaluateWrite(access, 'sales/a.md').write, false)
  assert.equal(evaluateWrite(access, 'SALES/a.md').write, false)
  assert.equal(evaluateWrite(access, 'Salesforce/a.md').write, true)
})

test('all: true and no ruled scope', () => {
  assert.equal(evaluateWrite({ version: 'v', role: 'owner', all: true, scopes: [] }, 'anything').write, true)
  assert.deepEqual(evaluateWrite({ version: 'v', role: 'member', all: false, scopes: [] }, 'x'), { write: false, scopePath: null })
  assert.equal(evaluateWrite(BOB, '../x').write, false)
})

test('normalizeRepoPath and isWriteAccess', () => {
  assert.equal(normalizeRepoPath('a//b/'), 'a/b')
  assert.equal(normalizeRepoPath('a/../b'), null)
  assert.equal(normalizeRepoPath('ガ'.normalize('NFD')), 'ガ')
  assert.equal(isWriteAccess(BOB), true)
  assert.equal(isWriteAccess({ version: 'v', all: false, scopes: [] }), false)
  assert.equal(isWriteAccess({ version: 'v', role: 'm', all: false, scopes: [{ path: 1, write: true }] }), false)
})

test('repoRelativePath resolves lexically against the root', () => {
  const root = '/Users/me/会社'
  assert.equal(repoRelativePath(root, '/Users/me/会社/営業部/a.md'), '営業部/a.md')
  assert.equal(repoRelativePath(root, 'a.md', '/Users/me/会社/営業部'), '営業部/a.md')
  assert.equal(repoRelativePath(root, '../契約書/a.md', '/Users/me/会社/営業部/下書き'), '営業部/契約書/a.md')
  assert.equal(repoRelativePath(root, '/Users/me/会社/営業部/../総務/./a.md'), '総務/a.md')
  assert.equal(repoRelativePath(root, '/Users/me/会社/../other/a.md'), null) // traversal out of the root
  assert.equal(repoRelativePath(root, '/Users/me/会社2/a.md'), null) // a sibling with a common prefix
  assert.equal(repoRelativePath(root, '/tmp/a.md'), null)
  assert.equal(repoRelativePath(root, '/users/ME/会社/営業部/a.md'), '営業部/a.md') // case-insensitive volume
  assert.equal(repoRelativePath(root.normalize('NFD'), '/Users/me/会社/営業部'.normalize('NFD') + '/a.md'), '営業部/a.md')
  assert.equal(repoRelativePath('C:\\Users\\me\\会社', 'C:\\Users\\me\\会社\\営業部\\a.md'), '営業部/a.md')
  assert.equal(repoRelativePath(root, root), '')
})

test('the denial message names the folder and tells the AI to ask instead of retrying', () => {
  assert.equal(readOnlyMessage('営業部/契約書'),
    'このフォルダ（営業部/契約書）は閲覧のみのため、編集できません。編集が必要な場合はフォルダの管理者に依頼してください。別の場所に保存する場合は、ユーザーに確認してください。')
  assert.match(readOnlyMessage(''), /会社フォルダのトップ/)
})
