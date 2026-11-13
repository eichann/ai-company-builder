import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makePrivateWords } from './makePrivate'

const offer = { parent: '営業部', tasks: 2, people: [{ id: 'u-a', name: '佐藤' }], blocked: false, version: 1 }

test('the window names who will see it afterwards, the やること that follow and what stays', () => {
  const w = makePrivateWords(offer, 'プロジェクト')
  assert.match(w.who, /参加者だけ/)
  assert.match(w.who, /佐藤さん/)
  assert.equal(w.tasks, 'つながっているやること（2件）も、参加者だけに見えるようになります。')
  assert.match(w.stays, /ファイル.*動きません/)
  assert.equal(w.blocked, null)
})

test('no やること line without any; a blocked plan says why it cannot be done', () => {
  const w = makePrivateWords({ ...offer, tasks: 0, people: [], blocked: true }, '案件')
  assert.equal(w.tasks, null)
  assert.doesNotMatch(w.who, /かかわる/)
  assert.match(w.blocked ?? '', /非公開にできません/)
})
