// Working through a list (tasks-ui.md "Working through a list"): which item ↑ ↓ reach, which one takes the place of
// an item done with — the last one included —, 「3 / 11」, and that the order and the place are kept per list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetAllWork, nextAfterLeaving, noticeOf, orderOf, placeOf, setWorkNotice, positionIn, publishOrder, rememberPlace, stepIn, subscribeWork } from './workThrough'

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
