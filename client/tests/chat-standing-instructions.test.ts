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

// 「返事の形」 (reply-style.ts): ふつう adds nothing to what the AI is told; リッチ one line with the turn (so switching
// takes effect at the next message), and only for an agent the registry says takes it.
test('「返事の形」: the plain reply adds nothing, a rich one adds the diagram line to this turn only, and only for an agent that takes it', async () => {
  const plain = await turnOf({})
  assert.doesNotMatch(plain.system + plain.standing, /mermaid/)
  const rich = await turnOf({ replyStyle: 'rich' })
  assert.match(rich.system, /mermaid か ```svg/)
  assert.doesNotMatch(rich.standing, /mermaid/)
  const unknown = await turnOf({ replyStyle: 'fancy' })
  assert.doesNotMatch(unknown.system, /mermaid/)
  const apiKey = await turnOf({ replyStyle: 'rich', authMode: 'api-key' })
  assert.doesNotMatch(apiKey.system + apiKey.standing, /mermaid/)
})

// A rich reply's page goes to the member's 今日のフォルダ only (reply-style.ts: never synced, the member's alone until
// moved). A request cannot point the AI anywhere else: a today folder not of the app's shape gives no page line.
test('「返事の形：リッチ」 names the member\'s 今日のフォルダ as where a page goes; no today folder, another shape or ふつう: no page line', async () => {
  const today = '営業部/.personal/inbox/日付別/2026/20261128'
  const rich = await turnOf({ replyStyle: 'rich', todayFolder: today })
  assert.ok(rich.system.includes(`「${os.tmpdir().replace(/[\\/]+$/, '')}/${today}/ページ/」に作り`), rich.system)
  assert.doesNotMatch(rich.standing, /HTML ファイル/)
  for (const todayFolder of [undefined, '営業部/共有/ページ', '../.ssh', '営業部/.personal/inbox/日付別/2026/20261128/../../../共有']) {
    const other = await turnOf({ replyStyle: 'rich', todayFolder })
    assert.match(other.system, /mermaid か ```svg/)
    assert.doesNotMatch(other.system, /HTML ファイル/, String(todayFolder))
  }
  const plain = await turnOf({ todayFolder: today })
  assert.doesNotMatch(plain.system + plain.standing, /HTML ファイル/)
  const apiKey = await turnOf({ replyStyle: 'rich', todayFolder: today, authMode: 'api-key' })
  assert.doesNotMatch(apiKey.system + apiKey.standing, /HTML ファイル/)
})
