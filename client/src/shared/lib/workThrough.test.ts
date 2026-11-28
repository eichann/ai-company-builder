// Working through a list (tasks-ui.md "Working through a list"): which item ↑ ↓ reach, which one takes the place of
// an item done with — the last one included —, 「3 / 11」, and that the order and the place are kept per list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetAllWork, nextAfterLeaving, noticeOf, orderOf, placeOf, setWorkNotice, positionIn, publishOrder, rememberPlace, stepIn, subscribeWork, undoOfEnded } from './workThrough'
import { endCompanyEra } from './companyEra'

/** What appStore does when the company on screen changes or a sign-out clears it (`leaveCompanyOnScreen`). */
const leaveCompany = () => { endCompanyEra(); forgetAllWork() }

function heldUndo() {
  let answer: (failure: string | null) => void = () => {}
  let refuse: () => void = () => {}
  let calls = 0
  const undo = () => { calls++; return new Promise<string | null>((resolve, reject) => { answer = resolve; refuse = () => reject(new Error('offline')) }) }
  return { undo, answer: (f: string | null) => answer(f), refuse: () => refuse(), calls: () => calls }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('取り消す answered after another company or a sign-out: the old item is not shown and its 件名 never reaches the new list', async () => {
  for (const outcome of ['undone', 'refused', 'failed'] as const) {
    const shown: string[] = []
    const held = heldUndo()
    const takeBack = undoOfEnded('tasks', 'a', '見積を直す', held.undo, id => shown.push(id))
    takeBack()
    assert.equal(noticeOf('tasks')?.text, '「見積を直す」を元に戻しています…', outcome)
    leaveCompany()
    if (outcome === 'failed') held.refuse()
    else held.answer(outcome === 'refused' ? '「見積を直す」は元に戻せませんでした' : null)
    await settle()
    assert.deepEqual(shown, [], outcome)
    assert.equal(noticeOf('tasks'), null, outcome)
  }
})

test('取り消す kept on screen past a company change does nothing when pressed; in the same company it puts the item back', async () => {
  const shown: string[] = []
  const stale = heldUndo()
  const old = undoOfEnded('tasks', 'a', '見積を直す', stale.undo, id => shown.push(id))
  leaveCompany()
  old()
  assert.equal(stale.calls(), 0)
  assert.equal(noticeOf('tasks'), null)

  const now = heldUndo()
  undoOfEnded('tasks', 'b', '請求書を送る', now.undo, id => shown.push(id))()
  now.answer(null)
  await settle()
  assert.deepEqual(shown, ['b'])
  assert.equal(noticeOf('tasks')?.text, '「請求書を送る」を元に戻しました')
  forgetAllWork()
})

test('取り消す whose put-back has more to say (the inbox\'s 「メールは Gmail でアーカイブされたままです」) shows those words, the item again', async () => {
  const shown: string[] = []
  const said = '元に戻しました（返事のお願いも連絡も）。メールは Gmail でアーカイブされたままです'
  undoOfEnded('inbox', 'contact:x', 'A社 見積のご相談', async () => ({ done: said }), id => shown.push(id))()
  await settle()
  assert.deepEqual(shown, ['contact:x'])
  assert.equal(noticeOf('inbox')?.text, said)
  forgetAllWork()
})

const ORDER = ['a', 'b', 'c', 'd']

test('「3 / 11」: counted from 1 over the items listed; an item not listed has no place', () => {
  assert.deepEqual(positionIn(ORDER, 'c'), { at: 3, total: 4 })
  assert.equal(positionIn(ORDER, 'x'), null)
  assert.equal(positionIn(ORDER, null), null)
})

test('↑ ↓ go to the neighbour and stop at either end', () => {
  assert.equal(stepIn(ORDER, 'b', 1), 'c')
  assert.equal(stepIn(ORDER, 'b', -1), 'a')
  assert.equal(stepIn(ORDER, 'd', 1), 'd')
  assert.equal(stepIn(ORDER, 'a', -1), 'a')
})

test('with nothing of the list shown, ↑ ↓ go back to where the member was, else the first / last item', () => {
  assert.equal(stepIn(ORDER, null, 1, 'c'), 'c')
  assert.equal(stepIn(ORDER, 'x', -1, 'c'), 'c')
  assert.equal(stepIn(ORDER, null, 1, 'gone'), 'a')
  assert.equal(stepIn(ORDER, null, -1, null), 'd')
  assert.equal(stepIn([], null, 1, 'a'), null)
})

test('an item done with is followed by the next one; the last one by the one before; the only one by nothing', () => {
  assert.equal(nextAfterLeaving(ORDER, 'b'), 'c')
  assert.equal(nextAfterLeaving(ORDER, 'd'), 'c')
  assert.equal(nextAfterLeaving(['a'], 'a'), null)
  assert.equal(nextAfterLeaving(ORDER, 'x'), null)
})

test('each list keeps its own order and place; publishing the same order again tells nobody', () => {
  let told = 0
  const stop = subscribeWork(() => { told++ })
  publishOrder('test:one', ['a', 'b'])
  publishOrder('test:two', ['x'])
  publishOrder('test:one', ['a', 'b'])
  assert.equal(told, 2)
  assert.deepEqual(orderOf('test:one'), ['a', 'b'])
  assert.deepEqual(orderOf('test:two'), ['x'])
  assert.deepEqual(orderOf('test:none'), [])
  rememberPlace('test:one', 'b')
  assert.equal(placeOf('test:one'), 'b')
  assert.equal(placeOf('test:two'), null)
  stop()
})

// Codex review: a 取り消す kept from one company must not show — or act — on the next company's screen.
test('another company or a sign-out forgets every list\'s order, place and notice (its 取り消す with it)', () => {
  publishOrder('test:three', ['a'])
  rememberPlace('test:three', 'a')
  setWorkNotice('test:three', { text: '「a」を片づけました。次の件です', undo: () => {} })
  forgetAllWork()
  assert.deepEqual(orderOf('test:three'), [])
  assert.equal(placeOf('test:three'), null)
  assert.equal(noticeOf('test:three'), null)
})
