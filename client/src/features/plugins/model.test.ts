// Which plugin screen goes in which slot (plugin-frame.md "The four slots").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginFileKindsOf } from '../../../../shared/core/plugin-file-kinds'
import type { PluginScreens } from '../../../shared/plugin-screens'
import type { TaskListItem } from '../../../shared/tasks'
import { fileActionsFor, peekItems, pluginTabId, pluginTabs, recordSectionsFor } from './model'

const screens = (over: Partial<PluginScreens> & { id: string }): PluginScreens => ({
  plugin: { id: over.id, version: '0.1.0' }, label: over.id,
  tab: null, peek: null, recordSections: [], fileActions: [], ...over,
})
const PLANNING = screens({
  id: 'planning',
  tab: { label: '番組', icon: 'FilmSlate', entry: 'ui/index.html' },
  peek: { implements: 'request', stateGroup: 'mine' },
  recordSections: [{ type: 'program_plan', label: '構成', entry: 'ui/plan.html' }],
  fileActions: [{ label: '企画の資料にする', entry: 'ui/attach.html', kinds: ['pdf', 'markdown'] }],
})
const SALES = screens({
  id: 'sales',
  recordSections: [{ type: 'program_plan', label: '見積', entry: 'ui/q.html' }, { type: 'deal', label: '提案', entry: 'ui/d.html' }],
  fileActions: [{ label: 'フォルダを案件にする', entry: 'ui/f.html', kinds: ['folder'] }],
})

const item = (id: string, turn: TaskListItem['turn'], impl?: string[]): TaskListItem => ({
  id, type: 'task', typeLabel: 'タスク', title: id, state: 'open', stateLabel: null, version: 1, due: null, tags: [],
  turn, waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null,
  ...(impl ? { implements: impl } : {}),
})

test('① a tab only for a plugin that declares one; one id per plugin whatever its version', () => {
  assert.deepEqual(pluginTabs([PLANNING, SALES]).map(s => s.plugin.id), ['planning'])
  assert.equal(pluginTabId({ id: 'planning' }), 'plugin:planning')
  assert.deepEqual(pluginTabs([]), [])
})

test('② the peek lists the task list items of its group whose type implements its interface', () => {
  const items = [item('a', 'mine', ['request']), item('b', 'acceptance', ['request']), item('c', 'others', ['request']),
    item('d', 'mine', ['outside_event']), item('e', 'mine'), item('f', 'ai', ['request'])]
  assert.deepEqual(peekItems(PLANNING.peek, items).map(i => i.id), ['a', 'b'])
  assert.deepEqual(peekItems({ implements: 'request', stateGroup: 'waiting' }, items).map(i => i.id), ['c'])
  assert.deepEqual(peekItems({ implements: 'request', stateGroup: 'ai_turn' }, items).map(i => i.id), ['f'])
  assert.deepEqual(peekItems(null, items), [])
  assert.deepEqual(peekItems({ implements: 'request', stateGroup: 'someday' }, items), [])
})

test('③ a record card shows every plugin\'s sections for its type, and none for another type', () => {
  assert.deepEqual(recordSectionsFor([PLANNING, SALES], 'program_plan').map(s => `${s.plugin.id}:${s.label}`), ['planning:構成', 'sales:見積'])
  assert.deepEqual(recordSectionsFor([PLANNING, SALES], 'deal').map(s => s.entry), ['ui/d.html'])
  assert.deepEqual(recordSectionsFor([PLANNING, SALES], 'task'), [])
})

test('④ file actions by the core\'s file kinds; none outside the company folder, on a not-downloaded folder or the app\'s folders', () => {
  const labels = (companyPath: string | null, isDirectory = false, notDownloaded = false) =>
    fileActionsFor([PLANNING, SALES], { companyPath, isDirectory, notDownloaded }).map(a => a.label)
  assert.deepEqual(labels('企画/台本.pdf'), ['企画の資料にする'])
  assert.deepEqual(labels('企画/メモ.MD'), ['企画の資料にする'])
  assert.deepEqual(labels('企画/表.xlsx'), [])
  assert.deepEqual(labels('企画', true), ['フォルダを案件にする'])
  assert.deepEqual(labels('企画', true, true), [])
  assert.deepEqual(labels(null), [])
  for (const p of ['/etc/a.pdf', '../a.pdf', '企画/../a.pdf', '.backups/x/a.pdf', '企画/.git/a.pdf', '企画//a.pdf']) assert.deepEqual(labels(p), [], p)
  assert.deepEqual(fileActionsFor([PLANNING], { companyPath: '企画/台本.pdf', isDirectory: false })[0], {
    plugin: { id: 'planning', version: '0.1.0' }, pluginLabel: 'planning', label: '企画の資料にする', entry: 'ui/attach.html',
  })
})

test('file kinds: a folder is only a folder; a file is `file` plus its extension\'s kind', () => {
  assert.deepEqual(pluginFileKindsOf('a/b', true), ['folder'])
  assert.deepEqual(pluginFileKindsOf('a/b.PDF', false), ['file', 'pdf'])
  assert.deepEqual(pluginFileKindsOf('a/.md', false), ['file'])
  assert.deepEqual(pluginFileKindsOf('a/b.exe', false), ['file'])
  assert.deepEqual(pluginFileKindsOf('a/b.docx', false), ['file', 'document'])
})
