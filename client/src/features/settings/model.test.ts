import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envChangesToSave, envDraftsFromText, envStatusLabel, normalizeEnvName } from './model'

test('a saved entry shows set / last four characters only', () => {
  assert.equal(envStatusLabel(undefined), '未設定')
  assert.equal(envStatusLabel({ set: false }), '未設定')
  assert.equal(envStatusLabel({ set: true }), '設定済み')
  assert.equal(envStatusLabel({ set: true, last4: 'ab12' }), '設定済み（末尾 ab12）')
})

test('a save sends typed values and removals, nothing for untouched names', () => {
  assert.deepEqual(envChangesToSave({ A: ' new ', B: '   ', C: 'x' }, new Set(['C', 'D'])), { A: 'new', C: null, D: null })
  assert.deepEqual(envChangesToSave({}, []), {})
})

test('pasted lines become values to set; empty values never clear a saved key', () => {
  assert.deepEqual(envDraftsFromText('# note\nA=1\nB=\nC="two words"\n'), { A: '1', C: 'two words' })
})

test('typed names become .env names, or are refused', () => {
  assert.deepEqual(normalizeEnvName(' my-key '), { name: 'MY_KEY' })
  assert.ok('error' in normalizeEnvName('1KEY'))
})
