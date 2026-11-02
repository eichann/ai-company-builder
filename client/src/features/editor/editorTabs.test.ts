import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPANY_ROOT_LABEL, departmentOfFile, fileTabsOf, looksOfOpenTabs, parseRecordLooks, recordIdOfTab, recordTabKey, tabDepartmentLabels } from './editorTabs'

const root = '/Users/me/ACB/会社'
const departments = [
  { id: 'd-content', name: 'コンテンツG', folder: 'コンテンツG' },
  { id: 'd-sales', name: '営業', folder: 'sales' },
  { id: 'd-sales-x', name: '営業X', folder: 'sales-x' },
]
const script = `${root}/コンテンツG/台本.md`
const proposal = `${root}/sales/提案.md`
const salesX = `${root}/sales-x/memo.md`
const rootReadme = `${root}/README.md`

test('a file belongs to the department whose folder contains it; prefixes alone do not count', () => {
  assert.equal(departmentOfFile(script, root, departments)?.id, 'd-content')
  assert.equal(departmentOfFile(salesX, root, departments)?.id, 'd-sales-x', 'sales-x is not inside sales')
  assert.equal(departmentOfFile(rootReadme, root, departments), null)
  assert.equal(departmentOfFile('C:\\ACB\\会社\\sales\\a.md', 'C:/ACB/会社/', departments)?.id, 'd-sales', 'Windows separators')
})

test('switching department keeps every tab; tabs from other departments are labelled', () => {
  const openFiles = [script, proposal, salesX, rootReadme]
  assert.deepEqual(tabDepartmentLabels(openFiles, { rootPath: root, departments, selectedDeptId: 'd-sales' }), {
    [script]: 'コンテンツG',
    [salesX]: '営業X',
    [rootReadme]: COMPANY_ROOT_LABEL,
  })
  assert.deepEqual(tabDepartmentLabels(openFiles, { rootPath: root, departments, selectedDeptId: 'd-content' }), {
    [proposal]: '営業',
    [salesX]: '営業X',
    [rootReadme]: COMPANY_ROOT_LABEL,
  })
})

test('the company-wide tab shows every department, so no tab is labelled', () => {
  assert.deepEqual(tabDepartmentLabels([script, proposal], { rootPath: root, departments, selectedDeptId: null }), {})
})

test('files outside the company folder are not labelled', () => {
  assert.deepEqual(tabDepartmentLabels(['/tmp/other.md', `${root}-old/x.md`], { rootPath: root, departments, selectedDeptId: 'd-sales' }), {})
})

test('a record tab is never taken for a file: only file tabs load text, and no file path reads as a record', () => {
  const tabs = [script, recordTabKey('task-abc123'), proposal]
  assert.deepEqual(fileTabsOf(tabs), [script, proposal])
  assert.equal(recordIdOfTab(recordTabKey('task-abc123')), 'task-abc123')
  assert.equal(recordIdOfTab(script), null)
  assert.equal(recordIdOfTab('C:\\ACB\\会社\\a.md'), null)
  assert.deepEqual(tabDepartmentLabels(tabs, { rootPath: root, departments, selectedDeptId: 'd-sales' }), { [script]: 'コンテンツG' })
})

test('saved record titles: only the open record tabs keep theirs; a malformed entry is dropped', () => {
  const looks = { 'task-a00001': { title: 'A', type: 'task' }, 'task-b00002': { title: 'B', type: 'task' } }
  assert.deepEqual(looksOfOpenTabs([recordTabKey('task-a00001'), script], looks), { 'task-a00001': looks['task-a00001'] })
  assert.deepEqual(parseRecordLooks({ ok: { title: 'x', type: 'deal', typeLabel: '案件', implements: ['bundle', 3] }, bad: { title: 1 }, nul: null }), {
    ok: { title: 'x', type: 'deal', typeLabel: '案件', implements: ['bundle'] },
  })
  assert.deepEqual(parseRecordLooks('nonsense'), {})
})
