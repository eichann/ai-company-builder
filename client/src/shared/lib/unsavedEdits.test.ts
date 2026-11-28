import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepUnsavedEdits, publishUnsavedEdits, registerUnsavedEditsKeeper, registerUnsettledEditsCheck, unsettledEdits } from './unsavedEdits'

test('［保存せずに進む］: a path is kept only when a keeper says so; none holding it, or a keeper throwing, is not kept', async () => {
  const offA = registerUnsavedEditsKeeper(async paths => paths.filter(p => p === '/c/a.md'))
  const offB = registerUnsavedEditsKeeper(async () => { throw new Error('disk full') })
  try {
    assert.deepEqual(await keepUnsavedEdits(['/c/a.md', '/c/b.md']), ['/c/b.md'])
    assert.deepEqual(await keepUnsavedEdits([]), [])
  } finally {
    offA(); offB()
  }
  // No editor mounted: nothing could be kept.
  assert.deepEqual(await keepUnsavedEdits(['/c/a.md']), ['/c/a.md'])
})

test("the last word before leaving: every editor's check is asked; a check that throws counts as every unsaved tab", () => {
  publishUnsavedEdits(['/c/x.md'])
  const offA = registerUnsettledEditsCheck(() => ['/c/a.md'])
  try {
    assert.deepEqual(unsettledEdits(), ['/c/a.md'])
    const offB = registerUnsettledEditsCheck(() => { throw new Error('broken') })
    assert.deepEqual(unsettledEdits().sort(), ['/c/a.md', '/c/x.md'])
    offB()
  } finally {
    offA()
    publishUnsavedEdits([])
  }
  assert.deepEqual(unsettledEdits(), [])
})
