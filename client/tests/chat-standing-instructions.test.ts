// What ACB tells the AI, and where (chat-and-agents.md "What ACB tells the AI"): the conversation's standing
// instructions go to the agent's own instructions slot; this turn's words (the department on screen) go with the turn.
// Without the split, a Claude Code chat would lose ACB's tool and safety paragraphs, or carry the tab of the moment
// in its system prompt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

async function turnOf(body: Record<string, unknown>) {
  const { startChatServer } = await import('../electron/chat-server')
  let request: { standingInstructions?: string } | undefined
  let system = ''
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    getWriteGuard: () => ({ root: os.tmpdir(), getAccess: () => undefined }),
    createRecordTools: async () => ({ specs: [{ name: 'records_get' }], instructions: '\n\n【会社の記録】RECORD_RULES', close: async () => {}, execute: async () => '', readTask: async () => null }),
    createConnection: () => ({
      id: 'claude-code', ownsConversation: true, authenticationError: () => undefined, readMetadata: () => ({}),
      createTitleModel: () => { throw new Error('no title') },
      createChatModel: (req: { standingInstructions?: string }) => {
        request = req
        return new MockLanguageModelV3({
          doStream: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
            system = options.prompt.filter(m => m.role === 'system').map(m => String(m.content)).join('\n')
            return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }] as never }) }
          },
        })
      },
    }),
  } as never)
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST', headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', companyRootPath: os.tmpdir(), workingDirectory: os.tmpdir(), appSessionId: 'conv-standing-01', ...body }),
    })
    await res.text()
  } finally { server.server.close() }
  return { standing: request?.standingInstructions ?? '', system }
}

test('a consultation: ACB\'s standing rules reach the agent\'s own slot, the department on screen rides with the turn', async () => {
  const { standing, system } = await turnOf({ activeDepartment: { name: '営業部', folder: '営業部' } })
  assert.match(standing, /返事の読み手/)
  assert.match(standing, /作業ディレクトリ/)
  assert.match(standing, /RECORD_RULES/)
  assert.doesNotMatch(standing, /閲覧中の部署/)
  assert.match(system, /閲覧中の部署: 「営業部」/)
  assert.doesNotMatch(system, /RECORD_RULES/)
})
