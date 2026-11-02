import { test } from 'node:test'
import assert from 'node:assert/strict'
import { similarBundles } from './similarBundles'

const choice = (id: string, title: string) => ({ id, title, typeLabel: '案件' })

test('an existing one sharing a word of the new name is offered before making another; unrelated ones are not', () => {
  const choices = [choice('a', 'Ｃ社 保守の相談（2025年）'), choice('b', 'A社 研修導入'), choice('c', 'B社 新人研修')]
  assert.deepEqual(similarBundles('C社 導入の検討', choices).map(c => c.id), ['a'])
  assert.deepEqual(similarBundles('新人研修の見直し', choices).map(c => c.id), [])
  assert.deepEqual(similarBundles('B社 新人研修 2026', choices).map(c => c.id), ['c'])
  assert.deepEqual(similarBundles('', choices), [])
})
