import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampWidth, createResizeDrag, dragWidth, leftPanelDrag } from './panelResize'

// A fake frame scheduler: callbacks run only when the test calls frame().
function frames() {
  let next = 1
  const pending = new Map<number, () => void>()
  return {
    schedule: (callback: () => void) => { const id = next++; pending.set(id, callback); return id },
    cancel: (id: number) => { pending.delete(id) },
    frame: () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(c => c()) },
    get pending() { return pending.size },
  }
}

test('width follows the pointer exactly: start width + total offset, clamped', () => {
  assert.equal(dragWidth(200, 37, 120, 400), 237)
  assert.equal(dragWidth(200, -500, 120, 400), 120)
  assert.equal(dragWidth(200, 500, 120, 400), 400)
  assert.equal(clampWidth(50, 300, 200), 300, 'a max below the min (tiny window) never goes below the min')
})

test('many pointer events before a render land where the pointer is, not several times further', () => {
  // The old handler applied each event's delta against a start position that
  // only updated on re-render: five 10px moves before a render moved the
  // panel 10+20+30+40+50 = 150px. Width is now derived from the drag's start.
  const widths: number[] = []
  const f = frames()
  const startWidth = 200
  const drag = createResizeDrag(500, { ...f, onResize: offset => widths.push(dragWidth(startWidth, offset, 120, 400)) })
  for (const x of [510, 520, 530, 540, 550]) drag.move(x)
  assert.equal(f.pending, 1, 'one frame scheduled for the burst')
  f.frame()
  assert.deepEqual(widths, [250])
  // Moving back and forth within a frame reports only the latest position.
  drag.move(560); drag.move(470); drag.move(480)
  f.frame()
  assert.deepEqual(widths, [250, 180])
  // Over the max and back: no permanent offset between pointer and divider.
  drag.move(900); f.frame()
  drag.move(520); f.frame()
  assert.deepEqual(widths, [250, 180, 400, 220])
})

test('release flushes the final position; nothing is applied after the drag ends', () => {
  const offsets: number[] = []
  const f = frames()
  const drag = createResizeDrag(100, { ...f, onResize: offset => offsets.push(offset) })
  drag.move(130)
  drag.end(142)
  assert.deepEqual(offsets, [42], 'the pending frame is replaced by the release position')
  assert.equal(f.pending, 0)
  drag.move(300); f.frame(); drag.end(400)
  assert.deepEqual(offsets, [42])
})

test('a cancelled or unmounted drag drops its pending frame', () => {
  const offsets: number[] = []
  const f = frames()
  const drag = createResizeDrag(0, { ...f, onResize: offset => offsets.push(offset) })
  drag.move(10); f.frame()
  drag.move(20)
  drag.dispose()
  f.frame()
  assert.deepEqual(offsets, [10])
  assert.equal(f.pending, 0)
})

test('a release without movement does not report a resize', () => {
  const offsets: number[] = []
  const f = frames()
  createResizeDrag(50, { ...f, onResize: offset => offsets.push(offset) }).end(50)
  assert.deepEqual(offsets, [])
})

test('editor ↔ chat: clamps to min/max and collapses the chat ~60px past the max', () => {
  const limits = { min: 300, max: 900, collapseAfter: 60 }
  assert.deepEqual(leftPanelDrag(550, 100, limits), { width: 650, collapse: false })
  assert.deepEqual(leftPanelDrag(550, -400, limits), { width: 300, collapse: false })
  assert.deepEqual(leftPanelDrag(550, 400, limits), { width: 900, collapse: false }, '50px past the max stays open')
  assert.deepEqual(leftPanelDrag(550, 410, limits), { width: 900, collapse: true })
  // Starting at the max, a fast burst of moves collapses exactly once the pointer is 60px past.
  const f = frames()
  const results: Array<{ width: number; collapse: boolean }> = []
  const drag = createResizeDrag(1000, { ...f, onResize: offset => results.push(leftPanelDrag(900, offset, limits)) })
  for (const x of [1010, 1020, 1030]) drag.move(x)
  f.frame()
  for (const x of [1040, 1050, 1059]) drag.move(x)
  f.frame()
  assert.deepEqual(results.map(r => r.collapse), [false, false])
  drag.move(1060); f.frame()
  assert.deepEqual(results.at(-1), { width: 900, collapse: true })
})
