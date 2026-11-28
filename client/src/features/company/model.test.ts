// A member's first time without choices (管理画面の見直し 2-2): which company opens by itself and
// which departments download without asking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companyToOpenWithoutChoosing, membershipFolders, NOTHING_PICKED, offersCompanyCreation, pickedDownload, togglePick, type PickableDepartment } from './model.ts'

const departments: PickableDepartment[] = [
  { id: 'd-sales', name: '営業部', folder: '営業部' },
  { id: 'd-dev', name: '開発部', folder: '開発部' },
  { id: 'd-support', name: 'サポート部', folder: 'サポート部' },
]

test('only the departments the member belongs to download by themselves, in the list order', () => {
  assert.deepEqual(membershipFolders(departments, ['d-support', 'd-sales']), ['営業部', 'サポート部'])
  // an id that is not a pickable department (nested, deleted, another company's) is not downloaded
  assert.deepEqual(membershipFolders(departments, ['d-gone']), [])
})

test('nothing known about 所属 → nothing chosen (the member is asked, not given everything)', () => {
  assert.deepEqual(membershipFolders(departments, []), [])
  assert.deepEqual(membershipFolders(departments, null), [])
  assert.deepEqual(membershipFolders(departments, undefined), [])
})

test('only a single company opens by itself, and never beside a remembered one', () => {
  assert.equal(companyToOpenWithoutChoosing(['A'], false), 'A')
  assert.equal(companyToOpenWithoutChoosing(['A'], true), null)
  assert.equal(companyToOpenWithoutChoosing(['A', 'B'], false), null)
  assert.equal(companyToOpenWithoutChoosing([], false), null)
})

test('「新しい会社を作成」 is hidden only when the server says the account may not create a company', () => {
  assert.equal(offersCompanyCreation({ canCreateCompany: false }), false)
  assert.equal(offersCompanyCreation({ canCreateCompany: true }), true)
  // An older server sends no answer: offered as before (the server still refuses).
  assert.equal(offersCompanyCreation({}), true)
})

test('この PC に置く部署: nothing chosen downloads nothing yet (never 「すべて」); 「すべて」 is its own choice', () => {
  const depts: PickableDepartment[] = [{ id: 'a', name: '営業部', folder: '営業部' }, { id: 'b', name: '総務部', folder: '総務部' }]
  assert.equal(pickedDownload(depts, NOTHING_PICKED), null)
  const all = togglePick(NOTHING_PICKED, 'all')
  assert.equal(pickedDownload(depts, all), 'all')
  // Choosing a department leaves 「すべて」; the list's order, whatever the order of the presses.
  const some = togglePick(togglePick(all, '総務部'), '営業部')
  assert.deepEqual(pickedDownload(depts, some), ['営業部', '総務部'])
  assert.equal(pickedDownload(depts, togglePick(togglePick(togglePick(NOTHING_PICKED, '営業部'), '営業部'), '総務部'))?.toString(), '総務部')
  // 「すべて」 after some: everything, the single picks dropped; pressed again: nothing chosen.
  assert.equal(pickedDownload(depts, togglePick(some, 'all')), 'all')
  assert.equal(pickedDownload(depts, togglePick(togglePick(some, 'all'), 'all')), null)
})
