/**
 * The chat AI's read-only company files (electron/company-files/): the
 * server client (session from the main process, brief per-member cache,
 * clear offline / sign-in errors), the tool handlers against a fake server,
 * and the wiring into Claude Code (in-process SDK MCP server) and Codex
 * (loopback MCP endpoint).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LanguageModel } from 'ai'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createCompanyFilesApi, CompanyFilesApiError, OFFLINE_MESSAGE } from '../electron/company-files/api'
import {
  COMPANY_FILE_TOOL_NAMES,
  companyFileDescriptions,
  companyFilesInstructions,
  createCompanyFileTools,
  startCompanyFilesMcp,
  toCompanyPath,
  TOOL_OUTPUT_MAX_BYTES,
  type CompanyFileTools,
} from '../electron/company-files/tools'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createCodexConnection, type CodexTransport } from '../electron/agents/codex'
import type { RpcMessage } from '../electron/agents/codex-rpc'

const COMMIT = 'a'.repeat(40)

/** A fake API server: records requests, answers like routes/company-files.ts. */
function fakeServer(options: { status?: number; body?: unknown; fail?: boolean } = {}) {
  const requests: Array<{ url: URL; cookie: string | null }> = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, cookie: new Headers(init?.headers).get('cookie') })
    if (options.fail) throw new TypeError('fetch failed')
    if (options.status) return new Response(JSON.stringify(options.body ?? {}), { status: options.status })
    const route = url.pathname.split('/').pop()
    const path = url.searchParams.get('path') ?? ''
    let data: unknown
    if (route === 'tree') data = { commit: COMMIT, path, depth: Number(url.searchParams.get('depth') ?? 1), entries: [{ name: 'a.md', path: path ? `${path}/a.md` : 'a.md', type: 'file', size: 3 }], truncated: false }
    else if (route === 'content') data = { commit: COMMIT, path, size: 3, startLine: 1, endLine: 1, totalLines: 1, hasMore: false, truncated: false, content: 'abc' }
    else data = { commit: COMMIT, path, query: url.searchParams.get('q'), regex: false, caseSensitive: false, matches: [{ path: 'a.md', line: 1, text: 'abc' }], files: 1, truncated: false, timedOut: false }
    return new Response(JSON.stringify({ success: true, data }), { status: 200 })
  }) as typeof fetch
  return { requests, fetch: fetchImpl }
}

function api(server = fakeServer(), extra: Partial<Parameters<typeof createCompanyFilesApi>[0]> = {}) {
  let cookies = ['session=one']
  let now = 1000
  const client = createCompanyFilesApi({ baseUrl: () => 'https://acb.example', cookies: () => cookies, fetch: server.fetch, now: () => now, ...extra })
  return { client, server, setCookies: (c: string[]) => { cookies = c }, advance: (ms: number) => { now += ms } }
}

test('api: sends the session cookie, caches briefly per member, clears', async () => {
  const { client, server, setCookies, advance } = api()
  const a = await client.get('co', 'tree', { path: '営業部', depth: 2 })
  assert.equal((a as { commit: string }).commit, COMMIT)
  assert.equal(server.requests[0].cookie, 'session=one')
  assert.equal(server.requests[0].url.pathname, '/api/companies/co/files/tree')
  assert.equal(server.requests[0].url.searchParams.get('path'), '営業部')
  await client.get('co', 'tree', { depth: 2, path: '営業部' }) // same query, other order
  assert.equal(server.requests.length, 1)
  setCookies(['session=two']) // another member: never the previous answers
  await client.get('co', 'tree', { path: '営業部', depth: 2 })
  assert.equal(server.requests.length, 2)
  advance(31_000)
  await client.get('co', 'tree', { path: '営業部', depth: 2 })
  assert.equal(server.requests.length, 3)
  client.clear()
  await client.get('co', 'tree', { path: '営業部', depth: 2 })
  assert.equal(server.requests.length, 4)
})

test('api: offline, signed out, server errors and not-found are clear errors', async () => {
  await assert.rejects(api(fakeServer({ fail: true })).client.get('co', 'tree', {}), (e: CompanyFilesApiError) => e.code === 'OFFLINE' && e.message === OFFLINE_MESSAGE)
  await assert.rejects(api(fakeServer(), { baseUrl: () => '' }).client.get('co', 'tree', {}), (e: CompanyFilesApiError) => e.code === 'OFFLINE')
  const signedOut = api()
  signedOut.setCookies([])
  await assert.rejects(signedOut.client.get('co', 'tree', {}), (e: CompanyFilesApiError) => e.code === 'NOT_SIGNED_IN')
  assert.equal(signedOut.server.requests.length, 0)
  await assert.rejects(api(fakeServer({ status: 401 })).client.get('co', 'tree', {}), (e: CompanyFilesApiError) => e.code === 'NOT_SIGNED_IN')
  await assert.rejects(api(fakeServer({ status: 500 })).client.get('co', 'tree', {}), (e: CompanyFilesApiError) => e.code === 'SERVER_ERROR')
  await assert.rejects(api(fakeServer({ status: 404, body: { error: 'そのパスは見つかりません', code: 'NOT_FOUND' } })).client.get('co', 'content', { path: 'x' }),
    (e: CompanyFilesApiError) => e.code === 'NOT_FOUND' && e.message === 'そのパスは見つかりません')
})

test('paths: company-relative, absolute inside the company folder, nothing outside', () => {
  assert.equal(toCompanyPath(undefined, '/Users/m/会社'), '')
  assert.equal(toCompanyPath('/Users/m/会社', '/Users/m/会社'), '')
  assert.equal(toCompanyPath('/Users/m/会社/営業部/a.md', '/Users/m/会社'), '営業部/a.md')
  assert.equal(toCompanyPath('./営業部//a.md', '/Users/m/会社'), '営業部/a.md')
  assert.equal(toCompanyPath('営業部\\a.md', '/Users/m/会社'), '営業部/a.md')
  assert.equal(toCompanyPath('/etc/passwd', '/Users/m/会社'), null)
  assert.equal(toCompanyPath('../外', '/Users/m/会社'), null)
})

test('tools: map to the API, cap reads, report errors as JSON (never throw at the model)', async () => {
  const { client, server } = api()
  const tools = createCompanyFileTools({ api: client, companyId: 'co', companyRoot: '/Users/m/会社' })
  const list = JSON.parse(await tools.execute('company_list', { path: '/Users/m/会社/営業部', depth: 3 }))
  assert.equal(list.entries[0].path, '営業部/a.md')
  assert.equal(server.requests.at(-1)!.url.searchParams.get('depth'), '3')
  const read = JSON.parse(await tools.execute('company_read_file', { path: '営業部/a.md', offset: 10, limit: 5 }))
  assert.equal(read.content, 'abc')
  const q = server.requests.at(-1)!.url.searchParams
  assert.deepEqual([q.get('path'), q.get('offset'), q.get('limit'), q.get('maxBytes')], ['営業部/a.md', '10', '5', '50000'])
  const search = JSON.parse(await tools.execute('company_search', { query: 'カリキュラム'.normalize('NFD'), path: 'コンテンツ', caseSensitive: true }))
  assert.equal(search.matches.length, 1)
  const sq = server.requests.at(-1)!.url.searchParams
  assert.equal(sq.get('q'), 'カリキュラム') // NFC
  assert.equal(sq.get('caseSensitive'), 'true')
  assert.equal(sq.get('limit'), '50')

  assert.match(JSON.parse(await tools.execute('company_read_file', { path: '/etc/passwd' })).error, /会社フォルダの外/)
  assert.equal(JSON.parse(await tools.execute('company_read_file', {})).code, 'INVALID_INPUT')
  assert.equal(JSON.parse(await tools.execute('company_list', { depth: 9 })).code, 'INVALID_INPUT')
  assert.equal(JSON.parse(await tools.execute('company_write_file', { path: 'a' })).code, 'UNKNOWN_TOOL')
  const offline = createCompanyFileTools({ api: api(fakeServer({ fail: true })).client, companyId: 'co' })
  assert.deepEqual(JSON.parse(await offline.execute('company_search', { query: 'x' })), { error: OFFLINE_MESSAGE, code: 'OFFLINE' })
})

test('tools: big listings are cut to fit and say so', async () => {
  const entries = Array.from({ length: 3000 }, (_, i) => ({ name: `f${i}.md`, path: `深い/フォルダ/f${i}.md`, type: 'file', size: i }))
  const big: Parameters<typeof createCompanyFileTools>[0]['api'] = { get: async () => ({ commit: COMMIT, path: '', depth: 5, entries, truncated: false }), clear() {} }
  const out = await createCompanyFileTools({ api: big, companyId: 'co' }).execute('company_list', { depth: 5 })
  assert.ok(Buffer.byteLength(out) <= TOOL_OUTPUT_MAX_BYTES)
  const parsed = JSON.parse(out)
  assert.equal(parsed.truncated, true)
  assert.ok(parsed.entries.length > 0 && parsed.entries.length < 3000)
  assert.match(parsed.note, /省略/)
})

test('tools: a turn has a call budget and stops when the chat is stopped', async () => {
  const controller = new AbortController()
  const tools = createCompanyFileTools({ api: api().client, companyId: 'co', signal: controller.signal })
  for (let i = 0; i < 60; i++) assert.ok(!JSON.parse(await tools.execute('company_list', {})).error)
  assert.equal(JSON.parse(await tools.execute('company_list', {})).code, 'BUDGET')
  controller.abort()
  await assert.rejects(tools.execute('company_list', {}))
})

test('descriptions say read-only, when to use them, and where to write', () => {
  for (const name of COMPANY_FILE_TOOL_NAMES) {
    assert.match(companyFileDescriptions[name], /読み取り専用/)
    assert.match(companyFileDescriptions[name], /Read-only/)
    assert.match(companyFileDescriptions[name], /ダウンロードしていない/)
  }
  assert.match(companyFileDescriptions.company_read_file, /ダウンロード済みの場所に書く/)
  assert.match(companyFilesInstructions(['コンテンツ/動画']), /コンテンツ\/動画/)
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const claudeConfig: ClaudeConnectionConfig = {
  getPermissionMode: () => 'default',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/test/claude',
  getShellEnv: () => ({ PATH: '/test' }),
}

const recordingTools = () => {
  const calls: Array<[string, unknown]> = []
  const tools: CompanyFileTools = { execute: async (name, input) => { calls.push([name, input]); return JSON.stringify({ ok: name }) } }
  return { calls, tools }
}

test('Claude session: the in-process MCP server carries the three tools, pre-approved and auto-allowed', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  let approvals = 0
  const connection = createClaudeConnection({ ...claudeConfig, requestToolApproval: async () => { approvals++; return { approved: false } } }, factory)
  const { calls, tools } = recordingTools()
  connection.createChatModel({ workingDirectory: '/Users/m/会社', companyFiles: tools })

  const ids = ['mcp__acb_company_files__company_search', 'mcp__acb_company_files__company_read_file', 'mcp__acb_company_files__company_list']
  assert.deepEqual(Object.keys(options.mcpServers), ['acb_company_files'])
  assert.deepEqual(options.allowedTools, ids)
  for (const id of ids) assert.equal((await options.canUseTool(id, { path: 'a' }, {})).behavior, 'allow')
  assert.equal(approvals, 0)

  const server = options.mcpServers.acb_company_files
  assert.equal(server.type, 'sdk')
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(t => t.name).sort(), ['company_list', 'company_read_file', 'company_search'])
    assert.ok(listed.tools.every(t => t.annotations?.readOnlyHint === true))
    const result = await client.callTool({ name: 'company_read_file', arguments: { path: '営業部/a.md' } })
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ ok: 'company_read_file' }) }])
    assert.deepEqual(calls, [['company_read_file', { path: '営業部/a.md' }]])
  } finally {
    await client.close()
  }

  // Without the tools, no MCP server at all (and still none from the repository).
  connection.createChatModel({ workingDirectory: '/Users/m/会社' })
  assert.equal(options.mcpServers, undefined)
  assert.equal(options.allowedTools, undefined)
})

test('Claude session: consultations and company files together', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  createClaudeConnection(claudeConfig, factory).createChatModel({ references: { execute: async () => '{}' }, companyFiles: recordingTools().tools })
  assert.deepEqual(Object.keys(options.mcpServers).sort(), ['acb_company_files', 'acb_consultations'])
  assert.equal(options.allowedTools.length, 5)
})

class FakeRpc implements CodexTransport {
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  calls: { method: string; params: Record<string, unknown> }[] = []
  closed = false
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
  close() { this.closed = true }
}

async function mcpPost(config: { url: string; http_headers: Record<string, string> }, body: unknown) {
  const res = await fetch(config.url, { method: 'POST', headers: { ...config.http_headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) })
  return { status: res.status, json: res.status === 200 ? await res.json() : null }
}

test('Codex session: the tools are a token-protected loopback MCP server for the turn, closed afterwards', async () => {
  const rpc = new FakeRpc()
  const connection = createCodexConnection({ getShellEnv: () => ({}) }, () => rpc)
  const { calls, tools } = recordingTools()
  const model = connection.createChatModel({ workingDirectory: '/Users/m/会社', appSessionId: 'app', companyFiles: tools }) as Extract<LanguageModel, { specificationVersion: 'v3' }>
  const response = model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: '質問' }] }] })
  for (let i = 0; i < 200 && !rpc.calls.some(c => c.method === 'turn/start'); i++) await new Promise(r => setTimeout(r, 5))
  const start = rpc.calls.find(c => c.method === 'thread/start')!
  const config = (start.params.config as { mcp_servers: Record<string, { url: string; http_headers: Record<string, string> }> }).mcp_servers.acb_company_files
  assert.match(config.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.equal((await fetch(config.url, { method: 'POST' })).status, 403)
  const init = await mcpPost(config, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  assert.equal(init.status, 200)
  const listed = await mcpPost(config, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  assert.deepEqual(listed.json.result.tools.map((t: { name: string }) => t.name).sort(), ['company_list', 'company_read_file', 'company_search'])
  const called = await mcpPost(config, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'company_search', arguments: { query: '教材' } } })
  assert.equal(called.json.result.content[0].text, JSON.stringify({ ok: 'company_search' }))
  assert.deepEqual(calls, [['company_search', { query: '教材' }]])

  rpc.onMessage({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { status: 'completed' } } })
  await response
  await assert.rejects(fetch(config.url, { method: 'POST' }))
})

test('the loopback endpoint stands alone too', async () => {
  const server = await startCompanyFilesMcp(recordingTools().tools)
  try {
    assert.equal((await fetch(server.config.url, { method: 'POST' })).status, 403)
  } finally {
    server.close()
  }
})
