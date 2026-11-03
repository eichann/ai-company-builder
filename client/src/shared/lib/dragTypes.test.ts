import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropEffectAllowed, FILE_TREE_EFFECT_ALLOWED } from './dragTypes'

// A file dragged from the tree onto a record card's 「つながっているもの」 (dropEffect `link`) was
// silently refused when the tree allowed `move` only: the browser fires no drop event.
test('a file tree drag can be dropped to link and to move', () => {
  assert.equal(dropEffectAllowed(FILE_TREE_EFFECT_ALLOWED, 'link'), true)
  assert.equal(dropEffectAllowed(FILE_TREE_EFFECT_ALLOWED, 'move'), true)
})

test('dropEffectAllowed follows the browser rule', () => {
  assert.equal(dropEffectAllowed('move', 'link'), false)
  assert.equal(dropEffectAllowed('copyLink', 'link'), true)
  assert.equal(dropEffectAllowed('all', 'copy'), true)
})
