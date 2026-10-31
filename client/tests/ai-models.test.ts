// Stays in client/tests/: it names model ids, which agent-registry.test.ts allows nowhere in src/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AI_EFFORT, DEFAULT_AI_MODEL, MODEL_EFFORT_OPTIONS, resolveSavedEffort, resolveSavedModel } from '../src/shared/lib/aiModels'

test('defaults: Opus 5.5 + medium for members who never chose; saved choices win', () => {
  assert.equal(DEFAULT_AI_MODEL, 'opus-5-5')
  assert.equal(DEFAULT_AI_EFFORT, 'medium')
  assert.ok(MODEL_EFFORT_OPTIONS[DEFAULT_AI_MODEL].includes(DEFAULT_AI_EFFORT))
  assert.equal(resolveSavedModel(null), 'opus-5-5')
  assert.equal(resolveSavedModel('opus'), 'opus-5-5')
  assert.equal(resolveSavedModel('toString'), 'opus-5-5')
  assert.equal(resolveSavedModel('sonnet'), 'sonnet')
  assert.equal(resolveSavedModel('fable-5'), 'fable-5')
  assert.equal(resolveSavedEffort(null), 'medium')
  assert.equal(resolveSavedEffort('bogus'), 'medium')
  assert.equal(resolveSavedEffort('max'), 'max')
  assert.equal(resolveSavedEffort('low'), 'low')
})
