// 今日のフォルダ (client/shared/today-folder.ts, tasks-ui.md "今日のフォルダ"): the path is the company's
// day under the department's `.personal/`; which department (the member's choice when downloaded,
// else the first 所属 one downloaded, else the first downloaded); made when missing; and what main
// accepts from the screen for the AI's instructions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureTodayFolder, fileNameFromTitle, isPersonalPath, isTodayFolderPath, todayFolderDepartment, todayFolderPath } from '../shared/today-folder'

test('the path is <department>/.personal/inbox/日付別/YYYY/YYYYMMDD of the company\'s day (Japan time)', () => {
  // 2026-11-02 23:30 UTC is already 11/03 in Tokyo.
  assert.equal(todayFolderPath('コンテンツ', Date.parse('2026-11-02T23:30:00Z')), 'コンテンツ/.personal/inbox/日付別/2026/20261103')
  assert.equal(todayFolderPath('営業', Date.parse('2026-12-31T14:59:00Z')), '営業/.personal/inbox/日付別/2026/20261231')
  assert.equal(todayFolderPath('営業', Date.parse('2026-12-31T15:00:00Z')), '営業/.personal/inbox/日付別/2027/20270101')
})

const depts = [
  { id: 'sales', folder: '営業', name: '営業部' },
  { id: 'contents', folder: 'コンテンツ', name: 'コンテンツ部' },
  { id: 'hr', folder: '人事', name: '人事部' },
]
const downloaded = (...folders: string[]) => (f: string) => folders.includes(f)

test('default: the first department the member belongs to that is downloaded here', () => {
  const pick = todayFolderDepartment({ departments: depts, chosenId: null, myDepartmentIds: ['hr', 'contents'], isDownloaded: downloaded('コンテンツ', '人事') })
  assert.equal(pick.department?.id, 'contents')
  assert.equal(pick.chosen, false)
  // 所属 not downloaded here → the next one that is.
  assert.equal(todayFolderDepartment({ departments: depts, chosenId: null, myDepartmentIds: ['contents', 'hr'], isDownloaded: downloaded('人事') }).department?.id, 'hr')
  // No 所属 here, or not known (offline) → the first downloaded department.
  assert.equal(todayFolderDepartment({ departments: depts, chosenId: null, myDepartmentIds: [], isDownloaded: downloaded('人事', 'コンテンツ') }).department?.id, 'contents')
  assert.equal(todayFolderDepartment({ departments: depts, chosenId: null, myDepartmentIds: null, isDownloaded: downloaded('人事') }).department?.id, 'hr')
  assert.equal(todayFolderDepartment({ departments: depts, chosenId: null, myDepartmentIds: ['sales'], isDownloaded: downloaded() }).department, null)
})

test('the member\'s choice wins while it is downloaded; otherwise the default is used and the choice is reported missing', () => {
  const chosen = todayFolderDepartment({ departments: depts, chosenId: 'hr', myDepartmentIds: ['sales'], isDownloaded: downloaded('営業', '人事') })
  assert.deepEqual([chosen.department?.id, chosen.chosen, chosen.chosenMissing], ['hr', true, null])
  const missing = todayFolderDepartment({ departments: depts, chosenId: 'hr', myDepartmentIds: ['sales'], isDownloaded: downloaded('営業') })
  assert.deepEqual([missing.department?.id, missing.chosen, missing.chosenMissing?.id], ['sales', false, 'hr'])
  // A department deleted since: the default, nothing reported.
  assert.equal(todayFolderDepartment({ departments: depts, chosenId: 'gone', myDepartmentIds: ['sales'], isDownloaded: downloaded('営業') }).chosenMissing, null)
})

test('today\'s folder is made when missing, left as it is when there, and a failure answers null', async () => {
  const made: string[] = []
  const fs = (present: boolean, ok = true) => ({
    exists: async () => present,
    createDirectory: async (p: string) => { made.push(p); return ok },
  })
  assert.equal(await ensureTodayFolder('/c', '営業/.personal/inbox/日付別/2026/20261103', fs(false)), '/c/営業/.personal/inbox/日付別/2026/20261103')
  assert.deepEqual(made, ['/c/営業/.personal/inbox/日付別/2026/20261103'])
  assert.equal(await ensureTodayFolder('/c', '営業/.personal/inbox/日付別/2026/20261103', fs(true)), '/c/営業/.personal/inbox/日付別/2026/20261103')
  assert.equal(made.length, 1)
  assert.equal(await ensureTodayFolder('/c', 'x/.personal/inbox/日付別/2026/20261103', fs(false, false)), null)
  assert.equal(await ensureTodayFolder('/c', 'x', { exists: async () => { throw new Error('gone') }, createDirectory: async () => true }), null)
})

test('only a today folder as the app builds it is accepted for the AI\'s instructions', () => {
  assert.ok(isTodayFolderPath('コンテンツ/.personal/inbox/日付別/2026/20261103'))
  for (const bad of ['コンテンツ', '../x/.personal/inbox/日付別/2026/20261103', '.claude/.personal/inbox/日付別/2026/20261103',
    'a/b/.personal/inbox/日付別/2026/20261103', 'a/.personal/inbox/日付別/2026/20251103', 'a/.personal/inbox/日付別/2026/20261103/x', 42, null]) {
    assert.equal(isTodayFolderPath(bad), false, String(bad))
  }
})

test('a .personal folder at any depth, A–Z folded; a file named .personal is not one', () => {
  assert.ok(isPersonalPath('営業/.personal/inbox/a.md'))
  assert.ok(isPersonalPath('.Personal/a.md'))
  assert.ok(isPersonalPath('a/b/.PERSONAL/c/d.md'))
  assert.equal(isPersonalPath('営業/personal/a.md'), false)
  assert.equal(isPersonalPath('営業/.personal'), false)
})

test('the name offered from a task title has no characters a name cannot hold', () => {
  assert.equal(fileNameFromTitle('A社 見積書を 150万円 で作り直す'), 'A社 見積書を 150万円 で作り直す.md')
  assert.equal(fileNameFromTitle('見積/請求: 確認?'), '見積 請求 確認.md')
  assert.equal(fileNameFromTitle('   '), 'メモ.md')
})
