// A member's first time without choices (管理画面の見直し 2-2): which company opens by itself and
// which departments download without asking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  companyToJoinWithoutChoosing, firstDepartmentChoice, joinStart, membershipFolders, needsDepartmentChoice, NOTHING_PICKED,
  offersCompanyCreation, pickedDownload, samePlaceCheck, togglePick, type PickableDepartment, type PlaceCheck,
} from './model.ts'

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

test('only a single company skips the list, and never beside a remembered one', () => {
  assert.equal(companyToJoinWithoutChoosing(['A'], false), 'A')
  assert.equal(companyToJoinWithoutChoosing(['A'], true), null)
  assert.equal(companyToJoinWithoutChoosing(['A', 'B'], false), null)
  assert.equal(companyToJoinWithoutChoosing([], false), null)
})

test('［始める］ never downloads without a place that was checked and a department choice (never 「すべて」 by itself)', () => {
  const fresh = (mine: string[]): PlaceCheck => ({ kind: 'firstSetup', departments, mine })
  // Not checked yet, or refused: nothing to start.
  assert.equal(joinStart(null, ['営業部']), null)
  assert.equal(joinStart({ kind: 'error', message: '別の会社のフォルダです。' }, 'all'), null)
  // 所属 known: it is the starting choice, and only those folders download.
  assert.deepEqual(firstDepartmentChoice(fresh(['営業部'])), ['営業部'])
  assert.deepEqual(joinStart(fresh(['営業部']), ['営業部']), { kind: 'firstSetup', folders: ['営業部'] })
  // No 所属: nothing chosen, the picker comes first and ［始める］ waits.
  assert.equal(firstDepartmentChoice(fresh([])), null)
  assert.equal(needsDepartmentChoice(fresh([]), null), true)
  assert.equal(joinStart(fresh([]), null), null)
  // 「すべて」 only when chosen; a company without departments downloads whole without a question.
  assert.deepEqual(joinStart(fresh([]), 'all'), { kind: 'firstSetup', folders: [] })
  assert.equal(needsDepartmentChoice({ kind: 'firstSetup', departments: [], mine: [] }, null), false)
  assert.deepEqual(joinStart({ kind: 'firstSetup', departments: [], mine: [] }, null), { kind: 'firstSetup', folders: [] })
  // This company's existing folder keeps its own choices: nothing is sent, whatever was chosen.
  assert.deepEqual(joinStart({ kind: 'reopen' }, ['営業部']), { kind: 'reopen', folders: [] })
  assert.deepEqual(joinStart({ kind: 'working' }, null), { kind: 'working' })
})

test('「新しい会社を作成」 is hidden only when the server says the account may not create a company', () => {
  assert.equal(offersCompanyCreation({ canCreateCompany: false }), false)
  assert.equal(offersCompanyCreation({ canCreateCompany: true }), true)
  // An older server sends no answer: offered as before (the server still refuses).
  assert.equal(offersCompanyCreation({}), true)
})

test('この PC に置く部署: nothing chosen downloads nothing yet (never 「すべて」); 「すべて」 is its own choice', () => {
  const ALL = { all: true } as const
  const one = (folder: string) => ({ folder })
  const depts: PickableDepartment[] = [{ id: 'a', name: '営業部', folder: '営業部' }, { id: 'b', name: '総務部', folder: '総務部' }, { id: 'c', name: 'all', folder: 'all' }]
  assert.equal(pickedDownload(depts, NOTHING_PICKED), null)
  const all = togglePick(NOTHING_PICKED, ALL)
  assert.equal(pickedDownload(depts, all), 'all')
  // Choosing a department leaves 「すべて」; the list's order, whatever the order of the presses.
  const some = togglePick(togglePick(all, one('総務部')), one('営業部'))
  assert.deepEqual(pickedDownload(depts, some), ['営業部', '総務部'])
  assert.deepEqual(pickedDownload(depts, togglePick(togglePick(togglePick(NOTHING_PICKED, one('営業部')), one('営業部')), one('総務部'))), ['総務部'])
  // A department named 「all」 is that department, never 「すべて」.
  assert.deepEqual(pickedDownload(depts, togglePick(NOTHING_PICKED, one('all'))), ['all'])
  // 「すべて」 after some: everything, the single picks dropped; pressed again: nothing chosen.
  assert.equal(pickedDownload(depts, togglePick(some, ALL)), 'all')
  assert.equal(pickedDownload(depts, togglePick(togglePick(some, ALL), ALL)), null)
})

test('a place is started only as it was shown: another kind or another department list is not the same place', () => {
  const fresh: PlaceCheck = { kind: 'firstSetup', departments, mine: [] }
  assert.equal(samePlaceCheck({ kind: 'reopen' }, { kind: 'reopen' }), true)
  assert.equal(samePlaceCheck(fresh, { ...fresh, mine: ['営業部'] }), true)
  // An existing folder emptied meanwhile (it would download everything), or files put in.
  assert.equal(samePlaceCheck({ kind: 'reopen' }, fresh), false)
  assert.equal(samePlaceCheck(fresh, { kind: 'error', message: '別の会社のフォルダです。' }), false)
  assert.equal(samePlaceCheck(fresh, { kind: 'firstSetup', departments: departments.slice(1), mine: [] }), false)
})
