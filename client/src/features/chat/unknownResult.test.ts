// A press whose answer never came (the approval card, the job proposal card): the card reads the server again by itself
// and stops at the first answer; when nothing can be read it says so and offers 「結果を確かめる」 — never 「開き直すと分かります」.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askAfterUnknown, unknownMessage, type PressOutcome } from './unknownResult'

const reads = (answers: Array<PressOutcome | null | Error>) => {
  const calls: number[] = []
  let i = 0
  return {
    calls,
    read: async () => {
      calls.push(i)
      const a = answers[i++]
      if (a instanceof Error) throw a
      return a ?? null
    },
  }
}
const waited: number[] = []
const wait = async (ms: number) => { waited.push(ms) }

test('reads again after each wait until one answers, then stops (it never reads more than needed)', async () => {
  waited.length = 0
  const r = reads([null, 'done', 'not-done'])
  assert.equal(await askAfterUnknown(r.read, [0, 10, 20], wait), 'done')
  assert.equal(r.calls.length, 2)
  assert.deepEqual(waited, [10])
})

test('"not done yet" is never final before the last read: a press still running on the server shows as done when it settles', async () => {
  // An approval waits for its outside write before its state moves: an early read still says pending (Codex review).
  const settled = reads(['not-done', 'not-done', 'done'])
  assert.equal(await askAfterUnknown(settled.read, [0, 10, 20, 30], wait), 'done')
  assert.equal(settled.calls.length, 3)
  // Still not done at the last read: the member is asked to press again.
  const never = reads(['not-done', null, 'not-done'])
  assert.equal(await askAfterUnknown(never.read, [0, 10, 20], wait), 'not-done')
  assert.equal(never.calls.length, 3)
  // One answer and then nothing readable: still that answer, not "unknown".
  assert.equal(await askAfterUnknown(reads(['not-done', null]).read, [0, 10], wait), 'not-done')
})

test('nothing readable (offline, a thrown read) → unreadable after every wait', async () => {
  waited.length = 0
  const r = reads([null, new Error('offline'), null])
  assert.equal(await askAfterUnknown(r.read, [0, 10, 20], wait), 'unreadable')
  assert.equal(r.calls.length, 3)
  assert.deepEqual(waited, [10, 20])
})

test('the words: never 「開き直す」, the button named when nothing could be read, press again only when it did not happen', () => {
  const words = { whether: '承認できたかどうか', notDone: '承認はまだ届いていません' }
  const all = (['checking', 'unreadable', 'not-done'] as const).map(at => unknownMessage(words, at))
  for (const text of all) assert.doesNotMatch(text, /開き直/)
  assert.match(all[1], /［結果を確かめる］/)
  assert.doesNotMatch(all[1], /もう一度押してください/)
  assert.match(all[2], /もう一度押してください/)
})
