// The history and hand-off calls keep their ids in the contract's order: company and
// conversation ids are both strings, so a swap would type-check and patch or summarise
// the wrong conversation. (Answers take (id, value) of different types; tsc catches a swap.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchChatSession, recordHandoffTurn, type ChatHistoryWrites, type HandoffOutbound } from './api'

const NO_WRITES = {
  saveChatSession: async () => { throw new Error('not expected') },
  flushChatSession: () => { throw new Error('not expected') },
  deleteChatSession: async () => { throw new Error('not expected') },
}

test('a patch reaches the named conversation of the named company, unchanged', async () => {
  const calls: unknown[] = []
  const writes: ChatHistoryWrites = { ...NO_WRITES, patchChatSession: async (...args) => { calls.push(args); return null } }
  assert.equal(await patchChatSession('company-1', 'session-1', { title: '見積もり' }, writes), null)
  assert.deepEqual(calls, [['company-1', 'session-1', { title: '見積もり' }]])
})

test('a finished turn goes to the hand-off writer with its receipt', async () => {
  const calls: unknown[] = []
  const outbound: HandoffOutbound = {
    updateHandoff: async () => { throw new Error('not expected') },
    completeHandoffTurn: async (...args) => { calls.push(args) },
  }
  const receipt = { messageId: 'm1', content: '回答', provider: 'claude-code' as const }
  await recordHandoffTurn('company-1', 'session-1', receipt, outbound)
  assert.deepEqual(calls, [['company-1', 'session-1', receipt]])
})
