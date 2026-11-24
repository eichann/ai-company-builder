// 「会議のあと」's card rules (4b-4 PR6-A): what leaves the PC, never twice, never more than ticked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_MARK, itemKey, itemStatus, type AfterMeetingMark, type ResultItem, type SetUpdateItem } from '../../../shared/after-meeting'
import {
  addedItem, applyAsk, cardNotes, cardOffers, draftsFrom, editorOf, isWeeklyReportTask, itemsToApply, newPressId, occurrenceOfTask, statusText, type DraftItem,
} from './model'

const QUOTE = '来月から月額で始めたいと先方の部長が言った'
const items: SetUpdateItem[] = [
  { 書き先: 'hubspot', 取引: '123', 項目: '確度', 値: 'B', 根拠: QUOTE, 理由: '導入時期が決まった' },
  { 書き先: 'hubspot', 取引: '123', 項目: '金額', 値: 300000 },
  { 書き先: '係数表', 取引: '123', 項目: '計上月', 値: [{ 月: '2026-12', 金額: 300000 }] },
]
const NOW = Date.parse('2026-11-24T10:00:00Z')
const statusOf = (mark: AfterMeetingMark, results: ResultItem[] = []) => (key: string) => itemStatus(key, mark, results, NOW)

test('an apply hands only the ticked items, the reason only when shared and the minutes\' quote only when chosen', () => {
  const drafts = draftsFrom(items)
  assert.equal(drafts[0].shareQuote, false, 'the quote is off at first')
  const unticked: DraftItem[] = drafts.map((d, i) => (i === 1 ? { ...d, on: false } : d))
  const chosen = itemsToApply(unticked, statusOf(EMPTY_MARK))
  assert.deepEqual(chosen.map(d => d.項目), ['確度', '計上月'])
  const ask = applyAsk({ pressId: 'a-0123456789abcdef', folder: '営業/.personal/提案書/2026-11-24_A社', meetingId: 'meeting-abc123', minutesDocVersion: 'notes:7', items: chosen })
  assert.ok(!ask.includes(QUOTE), 'no quote unless the member chose it')
  assert.ok(ask.includes('導入時期が決まった'))
  assert.ok(!ask.includes('"項目": "金額"'), 'an unticked item is not handed on')
  assert.match(ask, /a-0123456789abcdef/)
  assert.match(ask, /docVersion が「notes:7」と違えば/)
  const withQuote = applyAsk({ pressId: 'a-0123456789abcdef', folder: 'x/.personal/y/z', meetingId: null, minutesDocVersion: null, items: [{ ...chosen[0], shareQuote: true, shareReason: false }] })
  assert.ok(withQuote.includes(QUOTE))
  assert.ok(!withQuote.includes('導入時期が決まった'), 'a reason not shared stays here')
})

test('an edited value is what is handed on; an invalid one is not handed on at all', () => {
  const drafts = draftsFrom(items).map(d => (d.項目 === '確度' ? { ...d, 値: 'A' } : d.項目 === '金額' ? { ...d, 値: Number.NaN } : d))
  const chosen = itemsToApply(drafts, statusOf(EMPTY_MARK))
  assert.deepEqual(chosen.map(d => d.項目), ['確度', '計上月'])
  assert.match(applyAsk({ pressId: 'a-0123456789abcdef', folder: 'a/.personal/b/c', meetingId: null, minutesDocVersion: null, items: chosen }), /"値": "A"/)
})

test('never twice: an item handed on and not answered, or written, is not offered again; failed and stopped ones are', () => {
  const drafts = draftsFrom(items)
  const [k0, k1, k2] = drafts.map(d => d.key)
  const pending: AfterMeetingMark = { ...EMPTY_MARK, applies: [{ id: 'a-0000000000000001', at: new Date(NOW - 60_000).toISOString(), kind: 'apply', keys: [k0, k1] }] }
  assert.deepEqual(itemsToApply(drafts, statusOf(pending)).map(d => d.key), [k2])
  assert.equal(cardOffers(drafts, statusOf(pending)).apply, null, 'nothing is pressed while a consultation still works on it')
  const answered: ResultItem[] = [
    { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '123', 項目: '確度', 状態: '済み' },
    { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '123', 項目: '金額', 状態: '失敗', 理由: 'HubSpot に届かなかった' },
  ]
  assert.deepEqual(itemsToApply(drafts, statusOf(pending, answered)).map(d => d.key), [k1, k2])
  assert.equal(cardOffers(drafts, statusOf(pending, answered)).apply, 'rest')
  // A result of an earlier press does not answer a later one: the later one is 反映中 until its own result comes.
  const again: AfterMeetingMark = { ...pending, applies: [...pending.applies, { id: 'a-0000000000000002', at: new Date(NOW - 1000).toISOString(), kind: 'apply', keys: [k1] }] }
  assert.equal(itemStatus(k1, again, answered, NOW).kind, 'pending')
  // Older than the wait, with no answer: stopped half-way, offered again.
  const old: AfterMeetingMark = { ...EMPTY_MARK, applies: [{ id: 'a-0000000000000003', at: new Date(NOW - 31 * 60_000).toISOString(), kind: 'apply', keys: [k2] }] }
  assert.equal(itemStatus(k2, old, [], NOW).kind, 'stopped')
  assert.deepEqual(itemsToApply(drafts, statusOf(old)).map(d => d.key), [k0, k1, k2])
})

test('item words: an approval waits for its person, another assignee\'s deal is not written', () => {
  const st = (r: Partial<ResultItem>) => statusText({ kind: 'result', undone: false, result: { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '1', 項目: '金額', 状態: '済み', ...r } })
  assert.equal(st({ 状態: '承認待ち', 承認する人: '田中' }), '田中さんの承認待ち')
  assert.equal(st({ 状態: '担当が違う', 担当: '佐藤' }), 'この取引の担当は佐藤さんです。反映しませんでした')
  assert.equal(statusText({ kind: 'pending', entry: { id: 'a-0000000000000001', at: '', kind: 'apply', keys: [] } }), '反映中…（相談の中で進めています）')
})

test('the card notes: the AI unsure, and an unapplied proposal after three days', () => {
  const s = draftsFrom(items).map(d => itemStatus(d.key, EMPTY_MARK, [], NOW))
  assert.match(cardNotes({ confidence: 0.3, runAt: new Date(NOW).toISOString(), statuses: s, now: NOW })[0], /迷いました/)
  assert.deepEqual(cardNotes({ confidence: 0.9, runAt: new Date(NOW - 2 * 86_400_000).toISOString(), statuses: s, now: NOW }), [])
  assert.match(cardNotes({ confidence: 0.9, runAt: new Date(NOW - 3 * 86_400_000).toISOString(), statuses: s, now: NOW })[0], /3日前に作られ、まだ反映していません/)
})

test('［項目を足す］: HubSpot\'s fixed items only, never the same deal\'s same item twice', () => {
  const drafts = draftsFrom(items)
  assert.deepEqual(addedItem(drafts, 'hubspot', '123', '確度'), { problem: '同じ取引の同じ項目が、もうあります。' })
  assert.ok('problem' in addedItem(drafts, 'hubspot', '123', '好きな欄'))
  const added = addedItem(drafts, '係数表', '123', '粗利')
  assert.ok(!('problem' in added) && added.key === itemKey({ 書き先: '係数表', 取引: '123', 項目: '粗利' }) && added.proposed === null)
})

test('editors, ids and which やること is which', () => {
  assert.equal(editorOf({ 書き先: 'hubspot', 項目: '確度', 値: 'B' }), 'stage')
  assert.equal(editorOf({ 書き先: 'hubspot', 項目: '金額', 値: 1 }), 'number')
  assert.equal(editorOf({ 書き先: '係数表', 項目: '計上月', 値: [{ 月: '2026-01', 金額: 1 }] }), 'months')
  assert.equal(editorOf({ 書き先: 'hubspot', 項目: '商談の記録', 値: 'x' }), 'long')
  assert.match(newPressId('apply'), /^a-[0-9a-f]{16}$/)
  assert.match(newPressId('undo'), /^u-[0-9a-f]{16}$/)
  assert.equal(occurrenceOfTask(`task-${'a'.repeat(32)}`), `occ.${'a'.repeat(32)}`)
  assert.equal(occurrenceOfTask('task-0001ab'), null)
  assert.equal(isWeeklyReportTask('今週の定例レポートを作る'), true)
  assert.equal(isWeeklyReportTask('11月23日の会議のたたき台を確かめる'), false)
})
