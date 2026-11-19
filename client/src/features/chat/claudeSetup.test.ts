// Whether the chat asks the member to sign in (claudeSetup.ts): never for an answer the app could not read.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ClaudeCodeStatus } from '../../../shared/ipc-contract'
import { claudeSetupStep } from './claudeSetup'

describe('what the chat shows', () => {
  const base: ClaudeCodeStatus = { available: true, authenticated: true, cliPath: '/x/claude', version: 'installed', error: null, checkedAt: 0 }
  it('asks to sign in only when the CLI said so; unknown keeps the chat open as before', () => {
    assert.equal(claudeSetupStep({ ...base, available: false }), 'install')
    assert.equal(claudeSetupStep({ ...base, authenticated: false, signIn: { state: 'signed-out' }, signInSupported: true }), 'sign-in')
    assert.equal(claudeSetupStep({ ...base, signIn: { state: 'unknown' }, signInSupported: false }), 'ready')
    assert.equal(claudeSetupStep(base), 'ready')
  })
})
