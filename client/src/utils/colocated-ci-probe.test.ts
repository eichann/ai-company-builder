// Temporary: proves CI runs colocated renderer tests (removed before merge).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePathSeparators } from './path'

test('colocated renderer tests run in CI (probe)', () => {
  console.log('[colocated-ci-probe] ran from client/src/utils')
  assert.equal(normalizePathSeparators('a\\b'), 'a/b')
  assert.equal(process.env.COLOCATED_PROBE_PASS, '1', 'deliberate failure: proves a failing colocated test turns CI red')
})
