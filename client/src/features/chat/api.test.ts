// The history, hand-off and answer calls keep their arguments in the contract's order:
// a swapped id would patch, summarise or answer the wrong conversation or question.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchChatSession, recordHandoffTurn, respondAgentInteraction, respondToolApproval, type AgentAnswers, type ChatHistoryWrites, type HandoffOutbound } from './api'

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

test('an answer reaches the question or approval it was given for', async () => {
  const calls: unknown[] = []
  const answers: AgentAnswers = {
    respondAgentInteraction: async (...args) => { calls.push(['interaction', ...args]); return true },
    respondToolApproval: async (...args) => { calls.push(['approval', ...args]); return true },
  }
  assert.equal(await respondAgentInteraction('q1', { cancelled: true }, answers), true)
  await respondToolApproval('tool-1', false, answers)
  assert.deepEqual(calls, [['interaction', 'q1', { cancelled: true }], ['approval', 'tool-1', false]])
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
