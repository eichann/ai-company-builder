// Guards: an older answer arriving after a newer request was made is never used (the task list
// would otherwise go back — a task just completed could come back until the next read).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLatestOnly } from './latestOnly'

test('only the newest request\'s answer is used, whatever order the answers arrive in', () => {
  const latest = createLatestOnly()
  const look = latest.begin()
  const afterPress = latest.begin()
  assert.equal(latest.isLatest(afterPress), true)
  assert.equal(latest.isLatest(look), false, 'the older look, answered later, is dropped')
})
