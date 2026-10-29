/**
 * 「確認をお願いする」 (shared/review-request.ts, electron/review/tools.ts): the
 * request's rules, the tool, the conversation's pending request, its place in
 * history, and the wiring into Claude Code and Codex.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel, UIMessage } from 'ai'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createCodexConnection, type CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'
import { REVIEW_PART_TYPE, REVIEW_TOOL_ID, companyRelativePath, readReviewRecord, readReviewRequest, type ReviewRecord } from '../shared/review-request'
import { REVIEW_ACCEPTED, createReviewTools } from '../electron/review/tools'
import { pendingReviewOf } from '../src/lib/reviewRequest'
import { deriveConsultationStatus, toolActivity } from '../src/lib/consultationStatus'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/components/chat/chatSessionMessages'

const ROOT = '/Users/demo/会社'

test('files are company-relative: absolute paths only inside the company folder, no escaping it', () => {
  assert.equal(companyRelativePath('営業部/企画/骨子.md', ROOT), '営業部/企画/骨子.md')
  assert.equal(companyRelativePath(`${ROOT}/営業部/企画/骨子.md`, ROOT), '営業部/企画/骨子.md')
  assert.equal(companyRelativePath('/etc/passwd', ROOT), null)
  assert.equal(companyRelativePath('~/secret.md', ROOT), null)
  assert.equal(companyRelativePath('営業部/../../secret.md', ROOT), null)
  assert.equal(companyRelativePath(ROOT, ROOT), null)
  assert.equal(companyRelativePath('', ROOT), null)
})

test('a request reads leniently (Codex sends JSON strings) and within its limits', () => {
  const request = readReviewRequest(JSON.stringify({
    title: '  企画書の骨子  ',
    files: ['営業部/企画/骨子.md', '/etc/passwd', 3],
    points: ['ターゲット', '', '価格', 'a', 'b', 'c', 'd'],
  }), ROOT)
  assert.deepEqual(request, { title: '企画書の骨子', files: ['営業部/企画/骨子.md'], points: ['ターゲット', '価格', 'a', 'b', 'c'] })
  assert.equal(readReviewRequest({ files: ['a.md'] }), undefined)
  assert.equal(readReviewRequest('not json'), undefined)
  assert.equal(readReviewRecord({ title: 'x' }), undefined)
  assert.deepEqual(readReviewRecord({ id: 'r1', title: 'x' }), { id: 'r1', title: 'x', files: [], points: [] })
})

test('the tool refuses bad input, and an accepted request reaches the conversation with relative paths', async () => {
  const shown: ReviewRecord[] = []
  const tools = createReviewTools(ROOT, record => shown.push(record))
  assert.match(await tools.execute({ files: ['a.md'] }), /"error"/)
  assert.match(await tools.execute({ title: '骨子', files: ['/etc/passwd'] }), /"error"/)
  assert.match(await tools.execute({ title: '骨子', unknown: 1 }), /"error"/)
  assert.equal(shown.length, 0)

  assert.equal(await tools.execute({ title: '企画書の骨子', files: [`${ROOT}/営業部/企画/骨子.md`], points: ['価格の前提'] }), REVIEW_ACCEPTED)
  assert.equal(shown.length, 1)
  assert.equal(typeof shown[0].id, 'string')
  assert.deepEqual({ ...shown[0], id: '' }, { id: '', title: '企画書の骨子', files: ['営業部/企画/骨子.md'], points: ['価格の前提'] })
})

const record: ReviewRecord = { id: 'r1', title: '企画書の骨子', files: ['営業部/企画/骨子.md'], points: ['価格の前提'] }
const reply = (parts: UIMessage['parts']): UIMessage => ({ id: 'a1', role: 'assistant', parts })
const withReview = reply([{ type: 'text', text: '骨子を作りました。' }, { type: REVIEW_PART_TYPE, id: 'review-r1', data: record } as UIMessage['parts'][number]])

test('the request waits while it is in the latest reply; anything the member sends answers it', () => {
  assert.deepEqual(pendingReviewOf(withReview), record)
  assert.equal(pendingReviewOf({ id: 'u1', role: 'user', parts: [{ type: 'text', text: '確認しました' }] }), undefined)
  assert.equal(pendingReviewOf(reply([{ type: 'text', text: 'こんにちは' }])), undefined)
  assert.equal(pendingReviewOf(undefined), undefined)
})

test('a pending review is 「あなたの番」 (kind review) once the turn has ended', () => {
  const derive = (status: string, lastMessage?: UIMessage) => deriveConsultationStatus({ status, unseen: false, lastMessage, rootPath: ROOT })
  assert.deepEqual(derive('ready', withReview), { state: 'needs-you', kind: 'review', line: '確認をお願いします：企画書の骨子' })
  assert.equal(derive('streaming', withReview).state, 'working')
  assert.equal(derive('ready', reply([{ type: 'text', text: 'done' }])).state, 'idle')
  assert.equal(toolActivity(REVIEW_TOOL_ID, {}), '確認のお願いを出しています')
})

test('history keeps the request, so it is still the member\'s turn after a restart', () => {
  const stored = uiMessageToSessionMessage(withReview, new Date('2026-10-29T00:00:00Z'))
  assert.deepEqual(stored.reviewRequests, [record])
  assert.equal(stored.content, '骨子を作りました。')
  const restored = sessionMessageToUIMessage(stored)
  assert.deepEqual(pendingReviewOf(restored), record)
  assert.equal(pendingReviewOf(sessionMessageToUIMessage({ ...stored, reviewRequests: undefined })), undefined)
})

// ---------------------------------------------------------------------------
// Wiring: Claude Code (in-process SDK MCP server) and Codex (loopback endpoint)
// ---------------------------------------------------------------------------

const claudeConfig: ClaudeConnectionConfig = {
  getPermissionMode: () => 'default',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/test/claude',
  getShellEnv: () => ({ PATH: '/test' }),
}

test('Claude session: 「確認をお願いする」 is an app MCP server, pre-approved, never asking the member', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  let approvals = 0
  const connection = createClaudeConnection({ ...claudeConfig, requestToolApproval: async () => { approvals++; return { approved: false } } }, factory)
  const shown: ReviewRecord[] = []
  connection.createChatModel({ workingDirectory: ROOT, review: createReviewTools(ROOT, r => shown.push(r)) })
  assert.deepEqual(Object.keys(options.mcpServers), ['acb_review'])
  assert.deepEqual(options.allowedTools, [REVIEW_TOOL_ID])
  assert.equal((await options.canUseTool(REVIEW_TOOL_ID, { title: 'x' }, {})).behavior, 'allow')
  assert.equal(approvals, 0)

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await options.mcpServers.acb_review.instance.connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(t => t.name), ['request_review'])
    const result = await client.callTool({ name: 'request_review', arguments: { title: '企画書の骨子', files: ['営業部/企画/骨子.md'] } })
    assert.deepEqual(result.content, [{ type: 'text', text: REVIEW_ACCEPTED }])
    assert.equal(shown.length, 1)
  } finally {
    await client.close()
  }

  connection.createChatModel({ workingDirectory: ROOT })
  assert.equal(options.mcpServers, undefined)
})

class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  calls: { method: string; params: Record<string, unknown> }[] = []
  async initialize() {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    const results: Record<string, unknown> = {
      'account/read': { account: { type: 'chatgpt' } },
      'model/list': { data: [{ model: 'test-model', displayName: 'Test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] },
      'thread/start': { thread: { id: 'thread-a' } },
      'turn/start': { turn: { id: 'turn-a' } },
    }
    return results[method] as T
  }
  send() {}
  close() {}
}

test('Codex session: the tool is a loopback MCP server for the turn, closed afterwards', async () => {
  const rpc = new FakeRpc()
  const connection = createCodexConnection({ getShellEnv: () => ({}) }, () => rpc)
  const model = connection.createChatModel({ workingDirectory: ROOT, appSessionId: 'app', review: createReviewTools(ROOT, () => {}) }) as Extract<LanguageModel, { specificationVersion: 'v3' }>
  const response = model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: '企画書を書いて' }] }] })
  for (let i = 0; i < 200 && !rpc.calls.some(c => c.method === 'turn/start'); i++) await new Promise(r => setTimeout(r, 5))
  const start = rpc.calls.find(c => c.method === 'thread/start')!
  const config = (start.params.config as { mcp_servers: Record<string, { url: string }> }).mcp_servers.acb_review
  assert.match(config.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.equal((await fetch(config.url, { method: 'POST' })).status, 403)
  rpc.onMessage({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { status: 'completed' } } })
  await response
  await assert.rejects(fetch(config.url, { method: 'POST' }))
})
