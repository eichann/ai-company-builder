// Folding groups of the 「AIへの相談」 list must never hide what the member is looking for or
// what waits for them: a bad stored value opens everything, 「あなたの番」 never folds, and a
// search shows its matches in every group.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCollapsedGroups, shownCollapsedGroups } from './conversationGroups'

test('an unreadable or foreign stored value folds nothing', () => {
  for (const raw of [null, '', '{', '"done"', '{"done":true}', '[1, null, "nonsense"]']) {
    assert.deepEqual([...parseCollapsedGroups(raw)], [], raw ?? 'null')
  }
  assert.deepEqual([...parseCollapsedGroups('["done","pinned"]')].sort(), ['done', 'pinned'])
})

test('「あなたの番」 stays open even if the stored value says it was folded', () => {
  assert.deepEqual([...parseCollapsedGroups('["needs-you","open"]')], ['open'])
})

test('while searching every group is open, so a match in a folded group is shown', () => {
  const folded = parseCollapsedGroups('["open","done"]')
  assert.deepEqual([...shownCollapsedGroups(folded, '見積')], [])
  assert.deepEqual([...shownCollapsedGroups(folded, '  ')].sort(), ['done', 'open'])
})
