import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LAYOUT, firstLayout, paneSize, parseLayout, serializeLayout, withPaneSize } from './layoutTree'

const saved = (trees: unknown, version: unknown = 1) => JSON.stringify({ version, trees })

test('what the member set comes back exactly', () => {
  const layout = { ...DEFAULT_LAYOUT, screen: withPaneSize(DEFAULT_LAYOUT.screen, 'side', 712), files: withPaneSize(DEFAULT_LAYOUT.files, 'fileTree', 333) }
  assert.deepEqual(parseLayout(serializeLayout(layout)), layout)
})

test('nothing saved, unreadable JSON or another version: today\'s look', () => {
  const changed = { ...DEFAULT_LAYOUT, screen: withPaneSize(DEFAULT_LAYOUT.screen, 'side', 800) }
  for (const raw of [null, '', 'not json', 'null', '[]', saved(changed, 2), saved(changed, '1'), saved(null)]) {
    assert.deepEqual(parseLayout(raw), DEFAULT_LAYOUT, String(raw))
  }
})

test('a saved size can never push a pane outside its limits (no 0 px tree, no window-wide side)', () => {
  const layout = parseLayout(saved({
    screen: { ...DEFAULT_LAYOUT.screen, sizes: [99999, null] },
    files: { ...DEFAULT_LAYOUT.files, sizes: [0, null] },
  }))
  assert.deepEqual(layout.screen.sizes, [1200, null])
  assert.deepEqual(layout.files.sizes, [120, null])
})

test('a size that is not a number keeps that pane at its default; the flexible pane stays flexible', () => {
  const layout = parseLayout(saved({
    screen: { ...DEFAULT_LAYOUT.screen, sizes: ['wide', 400] },
    files: { ...DEFAULT_LAYOUT.files, sizes: [Number.NaN, null] },
  }))
  assert.deepEqual(layout.screen.sizes, [550, null], 'the chat never gets a fixed width from storage')
  assert.deepEqual(layout.files.sizes, [200, null])
})

test('a tree of another shape (panes renamed, added or reordered) is ignored, split by split', () => {
  const swapped = { ...DEFAULT_LAYOUT.screen, children: [...DEFAULT_LAYOUT.screen.children].reverse(), sizes: [700, null] }
  const extra = { ...DEFAULT_LAYOUT.files, children: [...DEFAULT_LAYOUT.files.children, { type: 'pane', id: 'preview' }], sizes: [300, null, null] }
  assert.deepEqual(parseLayout(saved({ screen: swapped, files: extra })), DEFAULT_LAYOUT)
  // One usable split is still used.
  const layout = parseLayout(saved({ screen: swapped, files: { ...DEFAULT_LAYOUT.files, sizes: [260, null] } }))
  assert.deepEqual(layout.screen, DEFAULT_LAYOUT.screen)
  assert.deepEqual(layout.files.sizes, [260, null])
})

test('a first start fits the window: on a 1280 px notebook the left tab, the middle and the consultation all fit (I.8)', () => {
  const l = firstLayout(1280)
  const side = paneSize(l.screen, 'side')!
  const tree = paneSize(l.files, 'fileTree')!
  // The consultation keeps ~420 px and the middle is wider than the narrow column.
  assert.equal(1280 - side, 420)
  assert.ok(side - tree >= 560, `middle ${side - tree}`)
  // Never smaller than today's look, never past the side's limit.
  assert.equal(paneSize(firstLayout(800).screen, 'side'), 550)
  assert.equal(paneSize(firstLayout(4000).screen, 'side'), 1200)
  // What the member saved wins; nothing saved takes the first look for the window.
  const saved = serializeLayout({ ...DEFAULT_LAYOUT, screen: withPaneSize(DEFAULT_LAYOUT.screen, 'side', 712) })
  assert.equal(paneSize(parseLayout(saved, 1280).screen, 'side'), 712)
  assert.deepEqual(parseLayout(null, 1280), l)
  assert.deepEqual(parseLayout('not json', 1280), l)
})
