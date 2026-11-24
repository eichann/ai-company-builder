// 「会議のあと」's card rules (4b-4 PR6-A): what leaves the PC, never twice, never more than ticked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_MARK, itemKey, itemStatus, type AfterMeetingMark, type ResultItem, type SetUpdateItem } from '../../../shared/after-meeting'
import {
  addedItem, applyAsk, createSkipped, defaultPick, handedOf, cardNotes, cardOffers, draftsFrom, editorOf, isWeeklyReportTask, itemsToApply, newPressId, occurrenceOfTask, statusText, type DraftItem,
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
  const old: AfterMeetingMark = { ...EMPTY_MARK, applies: [{ id: 'a-0000000000000003', at: new Date(NOW - 121 * 60_000).toISOString(), kind: 'apply', keys: [k2] }] }
  assert.equal(itemStatus(k2, old, [], NOW).kind, 'stopped')
  assert.deepEqual(itemsToApply(drafts, statusOf(old)).map(d => d.key), [k0, k1, k2])
})

test('a card opened again shows what was applied: the value handed on, and an item added there', () => {
  const added = { 書き先: 'hubspot' as const, 取引: '123', 項目: '次のアクション', 値: '見積を送る' }
  const applies = [{ id: 'a-0000000000000001', at: new Date(NOW).toISOString(), kind: 'apply' as const, keys: [itemKey(items[1]), itemKey(added)], items: [{ ...items[1], 値: 280000 }, added] }]
  const drafts = draftsFrom(items, applies)
  assert.equal(drafts.find(d => d.項目 === '金額')?.値, 280000)
  assert.equal(drafts.find(d => d.項目 === '金額')?.proposed, 300000)
  assert.deepEqual(drafts.find(d => d.項目 === '次のアクション'), { key: itemKey(added), ...added, proposed: null, on: true, shareReason: false, shareQuote: false })
})

test('an undo that failed or stopped never makes a written item appliable again', () => {
  const k = itemKey(items[2])
  const mark: AfterMeetingMark = { ...EMPTY_MARK, applies: [
    { id: 'a-0000000000000001', at: new Date(NOW - 5 * 60 * 60_000).toISOString(), kind: 'apply', keys: [k] },
    { id: 'u-0000000000000001', at: new Date(NOW - 4 * 60 * 60_000).toISOString(), kind: 'undo', keys: [k] },
  ] }
  const written: ResultItem = { 回: 'a-0000000000000001', 書き先: '係数表', 取引: '123', 項目: '計上月', 状態: '済み', 前の値: 1, 書いた値: 2 }
  const drafts = draftsFrom(items)
  // The undo's consultation said it did not write back: still written.
  const failedUndo = statusOf(mark, [written, { ...written, 回: 'u-0000000000000001', 状態: '失敗' }])
  assert.deepEqual(itemsToApply(drafts, failedUndo).map(d => d.key).includes(k), false)
  assert.equal(cardOffers(drafts, failedUndo).sheetUndo, true, 'the undo may be asked again')
  // The undo stopped half-way: still written, not appliable.
  assert.deepEqual(itemsToApply(drafts, statusOf(mark, [written])).map(d => d.key).includes(k), false)
  // Taken back (戻した): neither applied again nor undone again.
  const back = statusOf(mark, [written, { ...written, 回: 'u-0000000000000001', 状態: '戻した' }])
  assert.equal(itemsToApply(drafts, back).some(d => d.key === k), false)
  assert.equal(cardOffers(drafts, back).sheetUndo, false)
})

test('item words: an approval waits for its person, another assignee\'s deal is not written', () => {
  const st = (r: Partial<ResultItem>) => statusText({ kind: 'result', undone: false, via: 'apply', written: null, result: { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '1', 項目: '金額', 状態: '済み', ...r } })
  assert.equal(st({ 状態: '承認待ち', 承認する人: '田中' }), '田中さんの承認待ち')
  assert.equal(st({ 状態: '担当が違う', 担当: '佐藤' }), 'この取引の担当は佐藤さんです。反映しませんでした')
  assert.equal(statusText({ kind: 'pending', written: null, entry: { id: 'a-0000000000000001', at: '', kind: 'apply', keys: [] } }), '反映中…（相談の中で進めています）')
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

test('受注予定日 is a day: the apply hands the member\'s date and says to write the deal\'s close_date; no day, not handed on', () => {
  const drafts = draftsFrom([...items, { 書き先: 'hubspot', 取引: '123', 項目: '受注予定日', 値: '2026-12-15' }])
  const close = drafts.find(d => d.項目 === '受注予定日')!
  assert.equal(editorOf(close), 'date')
  const picked = drafts.map(d => (d === close ? { ...d, 値: '2027-01-20' } : d))
  const ask = applyAsk({ pressId: 'a-0123456789abcdef', folder: 'a/.personal/b/c', meetingId: null, minutesDocVersion: null, items: itemsToApply(picked, statusOf(EMPTY_MARK)) })
  assert.ok(ask.includes('"項目": "受注予定日"') && ask.includes('"値": "2027-01-20"'))
  assert.match(ask, /close_date/)
  assert.doesNotMatch(applyAsk({ pressId: 'a-0123456789abcdef', folder: 'a/.personal/b/c', meetingId: null, minutesDocVersion: null, items: draftsFrom(items) }), /close_date/)
  for (const bad of ['', '2027/01/20', '2027-02-30']) {
    assert.ok(!itemsToApply(picked.map(d => (d === picked[3] ? { ...d, 値: bad } : d)), statusOf(EMPTY_MARK)).some(d => d.項目 === '受注予定日'), bad)
  }
})

test('a coefficient sheet item hands on no reason or quote (no HubSpot, no approval there: owner FB #41)', () => {
  const sheet = { ...draftsFrom([{ ...items[2], 理由: '月はカードで選び直してください', 根拠: QUOTE }])[0], shareQuote: true }
  assert.deepEqual(Object.keys(handedOf(sheet)).sort(), ['書き先', '取引', '値', '項目'].sort())
})

const SAMPLE = { id: 'deal-sample01', title: 'サンプル/研修', assignee: '高杉', confidence: 'B（中）', amount: 300000, why: 'name' as const }
const LINKED = { ...SAMPLE, id: 'deal-linked01', title: 'サンプル/既存', why: 'linked' as const }

test('the 案件 chosen at first: an earlier press\'s, the one named, the meeting\'s, the best match; 「新しく作る」 only with none found', () => {
  assert.equal(defaultPick('新規:株式会社サンプル', [SAMPLE, LINKED], undefined), 'deal-linked01', 'the meeting\'s own comes first')
  assert.equal(defaultPick('新規:株式会社サンプル', [SAMPLE, LINKED], 'deal-sample01'), 'deal-sample01', 'what an earlier press chose stays')
  assert.equal(defaultPick('deal-sample01', [LINKED, SAMPLE], undefined), 'deal-sample01', 'the one the file names')
  assert.equal(defaultPick('新規:株式会社サンプル', [SAMPLE], undefined), 'deal-sample01', 'an existing 案件 rather than a second one')
  assert.equal(defaultPick('新規:株式会社サンプル', [], undefined), null)
  assert.equal(defaultPick('123', [], undefined), undefined, 'nothing to choose: the ask stays as it was')
  assert.equal(defaultPick('123', [{ ...SAMPLE, why: 'customer' }], undefined), undefined, 'a 取引 the AI named otherwise is never moved to a guess')
  const other = { ...SAMPLE, id: 'deal-other001', title: 'ほか社/研修', for: '新規:株式会社ほか' }
  assert.equal(defaultPick('新規:株式会社サンプル', [other], undefined), null, 'another company\'s 案件 found by its name is never chosen')
})

test('an existing 案件 chosen: the ask names its id and links the meeting first, and 「取引を作る」 is not handed on', () => {
  const deal = '新規:株式会社サンプル'
  const drafts = draftsFrom([
    { 書き先: 'hubspot', 取引: deal, 項目: '確度', 値: 'B（中）' },
    { 書き先: 'hubspot', 取引: deal, 項目: '取引を作る', 値: '株式会社サンプル/山田様' },
  ])
  const chosen = itemsToApply(drafts, statusOf(EMPTY_MARK)).filter(d => !createSkipped(d, { [deal]: SAMPLE.id }))
  assert.deepEqual(chosen.map(d => d.項目), ['確度'])
  const ask = applyAsk({ pressId: 'a-0123456789abcdef', folder: 'a/.personal/b/c', meetingId: 'meeting-abc123', minutesDocVersion: null, items: chosen, deals: [{ 取引: deal, deal: SAMPLE }], meetingBundle: null })
  assert.match(ask, /案件 deal-sample01 に書いてください/)
  assert.match(ask, /minutes_link_bundle で会議（meeting-abc123）をこの案件 deal-sample01 につないで/)
  assert.match(ask, /"案件"\?: 書いた案件の番号/)
  const linkedElsewhere = applyAsk({ pressId: 'a-0123456789abcdef', folder: 'a/.personal/b/c', meetingId: 'meeting-abc123', minutesDocVersion: null, items: chosen, deals: [{ 取引: deal, deal: SAMPLE }], meetingBundle: 'deal-linked01' })
  assert.doesNotMatch(linkedElsewhere, /minutes_link_bundle/, 'a meeting already linked to another 案件 is never linked again without asking')
  const two = applyAsk({ pressId: 'a-0123456789abcdef', folder: 'a/.personal/b/c', meetingId: 'meeting-abc123', minutesDocVersion: null, items: [...chosen, { ...chosen[0], key: 'x', 取引: 'x' }], deals: [{ 取引: deal, deal: SAMPLE }, { 取引: 'x', deal: LINKED }], meetingBundle: null })
  assert.doesNotMatch(two, /minutes_link_bundle/, 'a meeting is linked only when one 案件 is written to (a second link would replace the first)')
  // 「新しく作る」: today's path, 取引を作る handed on.
  assert.equal(itemsToApply(drafts, statusOf(EMPTY_MARK)).filter(d => !createSkipped(d, { [deal]: null })).length, 2)
  assert.match(applyAsk({ pressId: 'a-0123456789abcdef', folder: 'a/.personal/b/c', meetingId: 'meeting-abc123', minutesDocVersion: null, items: drafts, deals: [{ 取引: deal, deal: null }] }), /「新しく作る」を選びました/)
})
