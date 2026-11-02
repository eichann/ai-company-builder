// A member's first time without choices (管理画面の見直し 2-2): which company opens by itself and
// which departments download without asking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companyToOpenWithoutChoosing, membershipFolders, type PickableDepartment } from './model.ts'

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
