import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LAYOUT, MIDDLE_MIN, PANE_LIMITS, dragPane, fitLayout, layoutAfterResize, paneRange, paneSize, parseLayout, serializeLayout, sizeText, withPaneSize,
  type PaneView, type WorkspaceLayout,
} from './layoutTree'

const saved = (trees: unknown, version: unknown = 2) => JSON.stringify({ version, trees })
const sized = (chat: number, fileTree: number): WorkspaceLayout => ({
  screen: withPaneSize(DEFAULT_LAYOUT.screen, 'chat', chat),
  files: withPaneSize(DEFAULT_LAYOUT.files, 'fileTree', fileTree),
})
const ALL: PaneView = { leftShown: true, chatShown: true, middleShown: true }
// What the window gives the middle: the rest after the left column, the consultation and two 4 px dividers.
const middleOf = (l: WorkspaceLayout, width: number) => width - paneSize(l.files, 'fileTree')! - 4 - paneSize(l.screen, 'chat')! - 4
const chatOf = (l: WorkspaceLayout) => paneSize(l.screen, 'chat')!
const treeOf = (l: WorkspaceLayout) => paneSize(l.files, 'fileTree')!

test('what the member set comes back exactly', () => {
  const layout = sized(512, 333)
  assert.deepEqual(parseLayout(serializeLayout(layout)), layout)
})

test('nothing saved, unreadable JSON or a version this app does not know: the usual look', () => {
  const changed = sized(600, 300)
  for (const raw of [null, '', 'not json', 'null', '[]', saved(changed, 3), saved(changed, '2'), saved(null)]) {
    assert.deepEqual(parseLayout(raw, 1280), DEFAULT_LAYOUT, String(raw))
  }
})

test('a saved size is stale input: clamped to the static limits when read, a non-number keeps the default', () => {
  const huge = parseLayout(saved({ screen: { ...DEFAULT_LAYOUT.screen, sizes: [null, 0] }, files: { ...DEFAULT_LAYOUT.files, sizes: [99999, null] } }))
  assert.deepEqual(huge.screen.sizes, [null, PANE_LIMITS.chat.min])
  assert.deepEqual(huge.files.sizes, [720, null])
  const junk = parseLayout(saved({ screen: { ...DEFAULT_LAYOUT.screen, sizes: [400, 'wide'] }, files: { ...DEFAULT_LAYOUT.files, sizes: [Number.NaN, null] } }))
  assert.deepEqual(junk.screen.sizes, [null, 416], 'the side never gets a fixed width from storage')
  assert.deepEqual(junk.files.sizes, [260, null])
})

test('a tree of another shape (panes renamed, added or reordered) is ignored, split by split', () => {
  const swapped = { ...DEFAULT_LAYOUT.screen, children: [...DEFAULT_LAYOUT.screen.children].reverse(), sizes: [700, null] }
  const extra = { ...DEFAULT_LAYOUT.files, children: [...DEFAULT_LAYOUT.files.children, { type: 'pane', id: 'preview' }], sizes: [300, null, null] }
  assert.deepEqual(parseLayout(saved({ screen: swapped, files: extra })), DEFAULT_LAYOUT)
  const layout = parseLayout(saved({ screen: swapped, files: { ...DEFAULT_LAYOUT.files, sizes: [300, null] } }))
  assert.deepEqual(layout.screen, DEFAULT_LAYOUT.screen)
  assert.deepEqual(layout.files.sizes, [300, null])
})

test('version 1 (the side was fixed) reads as the same look in this window: the consultation keeps the width it had', () => {
  const v1 = (side: unknown, tree: unknown) => saved({
    screen: { type: 'split', id: 'screen', direction: 'row', children: [{ type: 'pane', id: 'side' }, { type: 'pane', id: 'chat' }], sizes: [side, null] },
    files: { ...DEFAULT_LAYOUT.files, sizes: [tree, null] },
  }, 1)
  const l = parseLayout(v1(710, 300), 1280)
  assert.equal(chatOf(l), 1280 - 710 - 4)
  assert.equal(treeOf(l), 300)
  // Drawn in that window, every divider stays where it was.
  const drawn = fitLayout(l, 1280, ALL)
  assert.equal(1280 - chatOf(drawn) - 4, 710)
  // A side so wide that the consultation had less than its minimum: the minimum.
  assert.equal(chatOf(parseLayout(v1(1200, 200), 1280)), PANE_LIMITS.chat.min)
  // No window width, or no usable side: the usual consultation.
  assert.equal(chatOf(parseLayout(v1(710, 360))), 416)
  assert.equal(chatOf(parseLayout(v1('x', 360), 1280)), 416)
  assert.equal(treeOf(parseLayout(v1('x', 360), 1280)), 360)
})

test('a first start on a 1280 px notebook looks as before: left 260, the consultation after 860 px, the middle the rest (I.8)', () => {
  const l = fitLayout(parseLayout(null, 1280), 1280, ALL)
  assert.equal(treeOf(l), 260)
  assert.equal(1280 - chatOf(l) - 4, 860)
  assert.ok(middleOf(l, 1280) >= 560, `middle ${middleOf(l, 1280)}`)
})

test('widening the window grows the middle; the consultation and the left column keep their widths', () => {
  const l = sized(480, 300)
  const narrow = fitLayout(l, 1280, ALL)
  const wide = fitLayout(l, 1920, ALL)
  assert.equal(chatOf(wide), chatOf(narrow))
  assert.equal(treeOf(wide), treeOf(narrow))
  assert.equal(middleOf(wide, 1920) - middleOf(narrow, 1280), 640)
})

test('the left column is never wider than half the window (at most 720 px), even when more was saved', () => {
  assert.equal(treeOf(fitLayout(sized(420, 720), 1000, { ...ALL, chatShown: false })), 500)
  assert.equal(treeOf(fitLayout(sized(300, 720), 2400, ALL)), 720)
  assert.equal(paneRange('fileTree', fitLayout(sized(280, 260), 1400, ALL), 1400, ALL).max, 700)
  // Below half when the consultation and the middle's minimum need the room.
  assert.equal(paneRange('fileTree', fitLayout(sized(280, 260), 1280, ALL), 1280, ALL).max, 1280 - 284 - MIDDLE_MIN - 4)
  assert.equal(paneRange('fileTree', fitLayout(sized(280, 260), 3000, ALL), 3000, ALL).max, 720)
})

test('every window from 848 px up: the middle keeps its minimum, nothing goes under its own, the left stays under half', () => {
  let seed = 7
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  for (let i = 0; i < 2000; i++) {
    const width = 848 + Math.floor(random() * 2400)
    const l = fitLayout(sized(280 + Math.floor(random() * 1500), 200 + Math.floor(random() * 520)), width, ALL)
    assert.ok(middleOf(l, width) >= MIDDLE_MIN, `middle ${middleOf(l, width)} at ${width}`)
    assert.ok(chatOf(l) >= 280 && treeOf(l) >= 200, `${chatOf(l)} / ${treeOf(l)} at ${width}`)
    assert.ok(treeOf(l) <= width / 2, `left ${treeOf(l)} at ${width}`)
  }
})

test('a smaller window takes the room from the consultation first, then the left column; the saved sizes stay', () => {
  const l = sized(600, 400)
  // 1280: 400 + 4 + 600 + 4 + 360 = 1368 → the consultation gives 88.
  const at1280 = fitLayout(l, 1280, ALL)
  assert.deepEqual([treeOf(at1280), chatOf(at1280)], [400, 512])
  // 1000: the consultation at its minimum, then the left column gives the rest (400 → 352).
  const at1000 = fitLayout(l, 1000, ALL)
  assert.deepEqual([treeOf(at1000), chatOf(at1000)], [352, 280])
  assert.equal(middleOf(at1000, 1000), MIDDLE_MIN)
  assert.deepEqual(l, sized(600, 400), 'what is saved is not changed by drawing it')
})

test('a hidden pane gives its room: the other keeps its width and the middle grows', () => {
  const l = sized(600, 400)
  assert.equal(chatOf(fitLayout(l, 1280, { ...ALL, leftShown: false })), 600)
  assert.equal(treeOf(fitLayout(l, 1000, { ...ALL, chatShown: false })), 400)
  // A wide left tab (スキル) covers the middle: the side only needs its own minimum.
  assert.equal(chatOf(fitLayout(sized(900, 260), 1280, { ...ALL, middleShown: false })), 900)
  assert.equal(paneRange('chat', fitLayout(sized(420, 260), 1280, { ...ALL, middleShown: false }), 1280, { ...ALL, middleShown: false }).max, 1280 - 300 - 4)
})

test('a drag stops where the middle would go under its minimum; only the consultation hides when dragged well under its own', () => {
  const shown = fitLayout(sized(420, 260), 1280, ALL)
  const chat = paneRange('chat', shown, 1280, ALL)
  assert.deepEqual(chat, { min: 280, max: 1280 - 264 - MIDDLE_MIN - 4 })
  assert.deepEqual(dragPane('chat', 420, 1000, chat), { size: chat.max, collapse: false })
  assert.deepEqual(dragPane('chat', 420, -190, chat), { size: 280, collapse: false })
  assert.deepEqual(dragPane('chat', 420, -200, chat), { size: 280, collapse: true })
  const tree = paneRange('fileTree', shown, 1280, ALL)
  assert.deepEqual(dragPane('fileTree', 260, -5000, tree), { size: 200, collapse: false }, 'the left column never hides by dragging')
})

test('one divider never moves another: a pane drawn smaller than saved stays as drawn when the other is resized', () => {
  const saved = sized(900, 700)
  const drawn = fitLayout(saved, 1280, ALL)
  assert.deepEqual([treeOf(drawn), chatOf(drawn)], [632, 280])
  const after = layoutAfterResize(saved, drawn, 'files', 'fileTree', 600)
  assert.deepEqual([treeOf(after), chatOf(after)], [600, 280])
  assert.equal(chatOf(fitLayout(after, 1280, ALL)), 280, 'the chat does not grow back to its saved width')
  // Nothing changes: what is saved stays the same object (nothing written).
  const fits = sized(416, 260)
  assert.equal(layoutAfterResize(fits, fitLayout(fits, 1280, ALL), 'files', 'fileTree', 260), fits)
})

test('the size shown while dragging: px and the share of the window', () => {
  assert.equal(sizeText(340, 1280), '340px（画面の 27%）')
})
