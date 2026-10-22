import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffSelection, downloadedBytes, folderCheckState, formatBytes, sameSelection, toggleFolder } from '../src/lib/download-selection'

test('tri-state: checked, partial (something inside left out), unchecked, inherited (inside a folder left out)', () => {
  const ex = ['コンテンツ/動画', '営業部']
  assert.equal(folderCheckState(ex, 'コンテンツ'), 'partial')
  assert.equal(folderCheckState(ex, 'コンテンツ/動画'), 'unchecked')
  assert.equal(folderCheckState(ex, 'コンテンツ/動画/2025'), 'inherited')
  assert.equal(folderCheckState(ex, 'コンテンツ/記事'), 'checked')
  assert.equal(folderCheckState(ex, '営業部/顧客'), 'inherited')
  assert.equal(folderCheckState(ex, 'コンテンツ/動画編集'), 'checked')
  assert.equal(folderCheckState(['Media/Raw'], 'media/raw'), 'unchecked') // A–Z folded
})

test('toggling: leaving a folder out folds the exclusions inside it; checking it again downloads it; inherited rows do nothing', () => {
  assert.deepEqual(toggleFolder([], 'コンテンツ/動画'), ['コンテンツ/動画'])
  assert.deepEqual(toggleFolder(['コンテンツ/動画', '営業部'], 'コンテンツ'), ['営業部', 'コンテンツ'])
  assert.deepEqual(toggleFolder(['コンテンツ/動画', '営業部'], 'コンテンツ/動画'), ['営業部'])
  assert.deepEqual(toggleFolder(['営業部'], '営業部/顧客'), ['営業部'])
})

test('diff, equality and downloaded size', () => {
  assert.deepEqual(diffSelection(['a', 'b'], ['b', 'c/d']), { excluded: ['c/d'], included: ['a'] })
  assert.equal(sameSelection(['A/b', 'c'], ['c', 'a/B']), true)
  assert.equal(downloadedBytes(1000, ['a', 'b'], { a: 100, b: 50 }), 850)
  assert.equal(downloadedBytes(1000, ['a'], { a: null }), null)
  assert.equal(downloadedBytes(null, [], {}), null)
  assert.equal(downloadedBytes(1000, ['a', 'a/b'], { a: 100, 'a/b': 40 }), 900) // nested entries are not counted twice
})

test('sizes read like the rest of the app', () => {
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(42 * 1024 ** 2), '42 MB')
  assert.equal(formatBytes(3.2 * 1024 ** 3), '3.2 GB')
  assert.equal(formatBytes(1.5 * 1024 ** 2), '1.5 MB')
})
