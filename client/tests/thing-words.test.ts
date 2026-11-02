import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CORE_TYPE_FILES } from '../../shared/core/core-types'
import { parseTypeFile, type TypeDefinition } from '../../shared/core/record-types'
import { bundleWords, stateWord, thingKindOf, thingName } from '../shared/thing-words'
import { summaryView } from '../shared/record-views'

// 言葉の決まり 1.: no 「型」, no category word, no machine name on a member's screen.
const NEVER = ['タスク', 'やりとり', 'まとまり', '送るもの', '型']
function def(type: string): TypeDefinition {
  const r = parseTypeFile(type, CORE_TYPE_FILES[type])
  assert.ok(r.ok)
  return r.definition
}

test('every core type is named in members\' words, never its definition label, a category or its id', () => {
  for (const type of Object.keys(CORE_TYPE_FILES)) {
    const d = def(type)
    for (const state of [...d.states, null]) {
      const name = thingName({ type, typeLabel: d.label, implements: d.implements, state })
      assert.ok(!NEVER.includes(name), `${type}/${state}: ${name}`)
      assert.notEqual(name, type)
    }
  }
  assert.equal(thingName({ type: 'task' }), 'やること')
  assert.equal(thingName({ type: 'task', minutesCheck: true }), '議事録を確認する')
  assert.equal(thingName({ type: 'interaction', typeLabel: 'やりとり' }), '来た連絡')
  assert.equal(thingName({ type: 'meeting', typeLabel: '会議' }), '会議の記録')
})

test('a plugin\'s bundle type shows its own label; a type without one never shows its id', () => {
  assert.equal(thingKindOf({ type: 'deal', typeLabel: '案件', implements: ['bundle'] }), 'bundle')
  assert.equal(thingName({ type: 'deal', typeLabel: '案件', implements: ['bundle'] }), '案件')
  assert.equal(thingName({ type: 'x_custom_type', typeLabel: '' }), '記録')
})

test('a message to send reads by its channel and state: a mail draft, a Slack reply, then what was sent', () => {
  assert.equal(thingName({ type: 'outbound_message', state: 'draft' }), '送るメールの下書き')
  assert.equal(thingName({ type: 'outbound_message', state: 'draft', channel: 'slack' }), '送る Slack の返事')
  assert.equal(thingName({ type: 'outbound_message', state: 'sent' }), '送ったもの')
})

test('the same state word reads per type: a task in review is not an approval waiting', () => {
  assert.equal(stateWord('review', 'task'), '確かめてもらっている')
  assert.equal(stateWord('pending', 'approval'), '承認待ち')
  assert.equal(stateWord('cancelled', 'task'), 'やめた（しまった）')
  assert.equal(stateWord('read', 'meeting'), 'AI が読み終えた')
  assert.equal(stateWord('custom_state', 'deal'), 'custom_state')
  assert.equal(stateWord(null), null)
})

test('where bundles of several kinds mix, the kinds there are named, each once', () => {
  assert.equal(bundleWords(['案件', '案件']), '案件')
  assert.equal(bundleWords(['案件', 'プロジェクト']), '案件・プロジェクト')
  assert.equal(bundleWords([], '取り組み'), '取り組み')
})

test('search hits and cards carry the plain name and the per-type state', () => {
  const v = summaryView({ id: 'task-1', type: 'task', title: 't', summary: '', state: 'review', fields: {}, links: {}, version: 1, updatedAt: '' } as never, def('task'))
  assert.equal(v.typeLabel, 'やること')
  assert.equal(v.stateLabel, '確かめてもらっている')
})
