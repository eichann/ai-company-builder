/**
 * The operator's screen image of 「ブラウザ操作」 (agent-browser.md "The operator sees the screen";
 * client/shared/browser-screen-marks.ts). What is protected: each element the operator is shown in text is found on the
 * picture by the same number at its own place (the marks follow the page's boxes, scaled to the image); an element off
 * the screen gets no mark; nothing is drawn outside the bitmap; and the page's boxes are read only in their checked form.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawScreenMarks, markLabelSize, screenMarks } from '../shared/browser-screen-marks'
import { browseMaterial, readBrowserPageSnapshot } from '../shared/browser-browse'

const HOST = 'shop.example.test'

const snapshot = (elements: unknown[], viewport: unknown = [1000, 500]) => readBrowserPageSnapshot(JSON.stringify({
  address: `https://${HOST}/folders`, title: 'folders', text: '', truncated: false, elements, viewport,
}), HOST)!

test('a mark follows its element\'s box scaled to the image; an element off the screen or without a box gets none', () => {
  const page = snapshot([
    { ref: 0, role: 'item', name: 'キャンペーン', logLabel: '', box: [100, 50, 200, 40] },
    { ref: 1, role: 'item', name: '未分類', logLabel: '' },
    { ref: 2, role: 'button', name: '保存', logLabel: '保存', box: [-300, 10, 100, 20] },
    { ref: 3, role: 'link', name: '右端', logLabel: '', box: [950, 480, 200, 100] },
  ])
  // The image is half the viewport's width (a 2000-pixel-wide window drawn at 1000 CSS pixels → resized).
  const marks = screenMarks(page, 500, 250)
  assert.deepEqual(marks, [
    { ref: 0, x: 50, y: 25, w: 100, h: 20 },
    { ref: 3, x: 475, y: 240, w: 24, h: 9 },
  ])
  // No viewport from the page: no marks at all (never a guess at the scale).
  assert.deepEqual(screenMarks(snapshot([{ ref: 0, role: 'item', name: 'x', logLabel: '', box: [1, 1, 5, 5] }], null), 500, 250), [])
})

test('the page\'s boxes and viewport are kept only as whole numbers of a sane size', () => {
  const page = snapshot([
    { ref: 0, role: 'item', name: 'a', logLabel: '', box: [1, 2, 3, 4] },
    { ref: 1, role: 'item', name: 'b', logLabel: '', box: [1, 2, 0, 4] },
    { ref: 2, role: 'item', name: 'c', logLabel: '', box: [1.5, 2, 3, 4] },
    { ref: 3, role: 'item', name: 'd', logLabel: '', box: [1, 2, 3] },
    { ref: 4, role: 'item', name: 'e', logLabel: '', box: ['1', 2, 3, 4] },
    { ref: 5, role: 'item', name: 'f', logLabel: '', box: [1, 2, 3, 99_999] },
  ], [0, 500])
  assert.deepEqual(page.elements.map(e => e.box ?? null), [[1, 2, 3, 4], null, null, null, null, null])
  assert.equal(page.viewport, undefined)
  // An unknown role is read as `other`; `item` (a clickable that is no control) is kept.
  assert.deepEqual(snapshot([{ ref: 0, role: 'item', name: 'x', logLabel: '' }, { ref: 1, role: 'banner', name: 'y', logLabel: '' }]).elements.map(e => e.role), ['item', 'other'])
})

test('the number is drawn on the pixels at the box\'s corner, the outline on its edges, and nothing outside the bitmap', () => {
  const width = 120
  const height = 80
  const bitmap = new Uint8Array(width * height * 4).fill(255)
  drawScreenMarks(bitmap, width, height, [{ ref: 7, x: 20, y: 40, w: 60, h: 30 }])
  const px = (x: number, y: number) => Array.from(bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
  const MARK = [0x20, 0x20, 0xe0, 0xff]
  // The outline, on all four edges.
  assert.deepEqual(px(20, 55), MARK)
  assert.deepEqual(px(79, 55), MARK)
  assert.deepEqual(px(50, 69), MARK)
  // Inside the box, the page itself.
  assert.deepEqual(px(50, 55), [255, 255, 255, 255])
  // The label above the box (there is room): the mark's colour with the digit 7 in white (its top row is 3 cells wide).
  const label = markLabelSize(7)
  assert.deepEqual(px(20, 40 - label.h), MARK)
  assert.deepEqual(px(20 + 2, 40 - label.h + 2), [255, 255, 255, 255])
  assert.deepEqual(px(20 + 2 + 8, 40 - label.h + 2), [255, 255, 255, 255])
  // The 7's second row lights only its right cell: its left is the label's colour.
  assert.deepEqual(px(20 + 2, 40 - label.h + 2 + 3), MARK)
  // A mark at the very corner of a small bitmap draws what fits and nothing past it (no throw, no byte past the end).
  const small = new Uint8Array(10 * 10 * 4 + 8).fill(9)
  drawScreenMarks(small, 10, 10, [{ ref: 123, x: 5, y: 5, w: 20, h: 20 }])
  assert.deepEqual(Array.from(small.subarray(400)), [9, 9, 9, 9, 9, 9, 9, 9])
  // A bitmap shorter than its size says is left alone.
  const short = new Uint8Array(10).fill(1)
  drawScreenMarks(short, 10, 10, [{ ref: 1, x: 0, y: 0, w: 5, h: 5 }])
  assert.deepEqual(Array.from(short), new Array(10).fill(1))
})

test('the first element\'s mark is drawn on top (the snapshot lists an open menu\'s elements first): where two overlap, the first one\'s label shows', () => {
  const width = 120
  const height = 80
  const bitmap = new Uint8Array(width * height * 4).fill(255)
  // ref 0 (the menu's choice) and ref 8 (the row behind it) share a corner: the 0's label must not be painted over.
  drawScreenMarks(bitmap, width, height, [{ ref: 0, x: 20, y: 40, w: 60, h: 30 }, { ref: 8, x: 20, y: 40, w: 60, h: 30 }])
  const px = (x: number, y: number) => Array.from(bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
  const label = markLabelSize(0)
  // The 0's middle row lights its left and right cells and leaves its centre dark; an 8 lights the centre of its middle row.
  assert.deepEqual(px(20 + 2 + 4, 40 - label.h + 2 + 6 + 1), [0x20, 0x20, 0xe0, 0xff])
})

test('the snapshot counts the usable elements left out past the cap (told to the operator as elementsLeftOut)', () => {
  const many = Array.from({ length: 405 }, (_, i) => ({ ref: i, role: 'button', name: `b${i}`, logLabel: '' }))
  const page = readBrowserPageSnapshot(JSON.stringify({ address: 'https://shop.example.test/a', title: 't', text: '', elements: many, omitted: 20, viewport: [1000, 500] }), 'shop.example.test')!
  assert.equal(page.elements.length, 400)
  assert.equal(page.omitted, 25)
  const material = browseMaterial({ task: 't', items: [], page, history: [], round: 0 }) as { page: { elementsLeftOut?: number } }
  assert.equal(material.page.elementsLeftOut, 25)
  const none = readBrowserPageSnapshot(JSON.stringify({ address: 'https://shop.example.test/a', title: 't', text: '', elements: [], omitted: -3 }), 'shop.example.test')!
  assert.equal(none.omitted, undefined)
  assert.equal((browseMaterial({ task: 't', items: [], page: none, history: [], round: 0 }) as { page: Record<string, unknown> }).page.elementsLeftOut, undefined)
})
