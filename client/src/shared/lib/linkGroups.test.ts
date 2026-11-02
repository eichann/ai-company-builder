import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldLinks, groupLinks } from './linkGroups'
import type { ThingKind } from '../../../shared/thing-words'

const item = (key: string, name: string, kind: ThingKind) => ({ key, name, kind })

test('「つながっているもの」 is one group per kind, in the fixed order, items in their order', () => {
  const groups = groupLinks([
    item('c1', 'AIへの相談', 'consultation'), item('t1', 'やること', 'task'), item('m1', '会議の記録', 'meeting'),
    item('d1', '案件', 'bundle'), item('t2', 'やること', 'task'), item('f1', 'ファイル', 'file'),
  ])
  assert.deepEqual(groups.map(g => g.title), ['案件', 'やること', '会議の記録', 'ファイル', 'AIへの相談'])
  assert.deepEqual(groups[1].items.map(i => i.key), ['t1', 't2'])
})

test('two kinds of bundle (案件 and プロジェクト) are two groups, never one general word', () => {
  const groups = groupLinks([item('a', '案件', 'bundle'), item('p', 'プロジェクト', 'bundle')])
  assert.deepEqual(groups.map(g => g.title), ['案件', 'プロジェクト'])
})

test('a 案件 puts its own やること first', () => {
  const groups = groupLinks([item('m', '会議の記録', 'meeting'), item('t', 'やること', 'task'), item('x', '顧客', 'counterpart')], 'task')
  assert.equal(groups[0].title, 'やること')
})

test('three per kind, the rest folded as 「ほか n 件」 until opened', () => {
  const four = [1, 2, 3, 4]
  assert.deepEqual(foldLinks(four, false), { shown: [1, 2, 3], more: 1 })
  assert.deepEqual(foldLinks(four, true), { shown: four, more: 0 })
  assert.deepEqual(foldLinks([1, 2, 3], false), { shown: [1, 2, 3], more: 0 })
})
