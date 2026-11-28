import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepUnsavedEdits, registerUnsavedEditsKeeper } from './unsavedEdits'

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
