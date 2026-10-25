import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPrivateReadState,
  decidePrivateWrite,
  foldersNamedIn,
  forgetPrivateReads,
  hasReadPrivate,
  noteCompanyFileResult,
  noteToolInput,
  noteToolResult,
  privateReadStateFor,
  seedFromMessages,
  type PrivateReadContext,
} from '../electron/private-read-guard'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import type { claudeCode } from 'ai-sdk-provider-claude-code'

const ROOT = '/Users/me/会社'
const ctx = (folders: string[] | undefined = ['人事/評価', '役員会']): PrivateReadContext => ({ root: ROOT, getPrivateFolders: () => folders })

const UNKNOWN: PrivateReadContext = { root: ROOT, getPrivateFolders: () => undefined }
const marked = (folders: string[] = ['人事/評価']) => {
  const state = createPrivateReadState()
  for (const f of folders) state.folders.add(f)
  return state
}

test('nothing is asked before the conversation read a private folder', () => {
  const state = createPrivateReadState()
  assert.equal(decidePrivateWrite(ctx(), state, 'Write', { file_path: `${ROOT}/営業部/a.md` }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(ctx(), state, 'WebFetch', { url: 'https://example.com' }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(undefined, marked(), 'Write', { file_path: `${ROOT}/a.md` }, ROOT).ask, false)
})

test('Read / Grep / Bash inside a private folder mark the conversation (NFD, case, relative, cwd)', () => {
  const c = ctx(['人事/評価', 'Board'])
  const s1 = createPrivateReadState()
  noteToolInput(c, s1, 'Read', { file_path: `${ROOT}/人事/評価/査定.md` }, ROOT)
  assert.deepEqual([...s1.folders], ['人事/評価'])

  const s2 = createPrivateReadState()
  noteToolInput(c, s2, 'Read', { file_path: '評価/査定.md'.normalize('NFD') }, `${ROOT}/人事`)
  assert.equal(hasReadPrivate(s2), true)

  const s3 = createPrivateReadState()
  noteToolInput(c, s3, 'Read', { file_path: `${ROOT}/board/minutes.md` }, ROOT)
  assert.deepEqual([...s3.folders], ['Board'])

  const s4 = createPrivateReadState()
  noteToolInput(c, s4, 'Grep', { pattern: '給与', path: '人事/評価' }, ROOT)
  assert.equal(hasReadPrivate(s4), true)

  const s5 = createPrivateReadState()
  noteToolInput(c, s5, 'Bash', { command: 'cat "人事/評価/査定.md" | head' }, ROOT)
  assert.equal(hasReadPrivate(s5), true)

  const s6 = createPrivateReadState()
  noteToolInput(c, s6, 'Bash', { command: 'ls' }, `${ROOT}/人事/評価`)
  assert.equal(hasReadPrivate(s6), true)

  // Public reads, the parent folder, and a longer name that only starts the same way do not mark.
  const s7 = createPrivateReadState()
  noteToolInput(c, s7, 'Read', { file_path: `${ROOT}/人事/README.md` }, ROOT)
  noteToolInput(c, s7, 'Grep', { pattern: 'x' }, ROOT)
  noteToolInput(c, s7, 'Bash', { command: 'cat 人事/評価基準.md' }, ROOT)
  noteToolInput(c, s7, 'Glob', { pattern: '人事/評価/**' }, ROOT)
  noteToolInput(c, s7, 'Read', { file_path: '/tmp/人事/評価/x.md' }, ROOT)
  assert.equal(hasReadPrivate(s7), false)
})

test('unknown private folders never crash and mark nothing locally', () => {
  const s = createPrivateReadState()
  noteToolInput(UNKNOWN, s, 'Read', { file_path: `${ROOT}/人事/評価/査定.md` }, ROOT)
  noteToolResult(UNKNOWN, s, 'Grep', `${ROOT}/人事/評価/査定.md`)
  assert.equal(hasReadPrivate(s), false)
  assert.deepEqual(foldersNamedIn(UNKNOWN, 'anything'), [])
})

test('a Grep / Bash result that lists a private file marks the conversation; Glob does not', () => {
  const s = createPrivateReadState()
  noteToolResult(ctx(), s, 'Glob', `${ROOT}/人事/評価/査定.md`)
  assert.equal(hasReadPrivate(s), false)
  noteToolResult(ctx(), s, 'Grep', { content: `Found 2 files\n${ROOT}/営業部/a.md\n${ROOT}/人事/評価/査定.md`.normalize('NFD') })
  assert.deepEqual([...s.folders], ['人事/評価'])
  const b = createPrivateReadState()
  noteToolResult(ctx(), b, 'Bash', { stdout: '役員会/議事録.md:3:売上' })
  assert.deepEqual([...b.folders], ['役員会'])
})

test('company_read_file / company_search results from a private folder mark the conversation', () => {
  const s = createPrivateReadState()
  noteCompanyFileResult(s, 'company_read_file', JSON.stringify({ path: '営業部/a.md', content: 'x' }))
  noteCompanyFileResult(s, 'company_list', JSON.stringify({ entries: [{ path: '人事/評価', private: true }] }))
  noteCompanyFileResult(s, 'company_search', JSON.stringify({ privateFolders: { '人事/評価': 'c1' }, matches: [{ path: '営業部/a.md' }] }))
  noteCompanyFileResult(s, 'company_read_file', JSON.stringify({ error: 'x', privateFolder: '人事/評価' }))
  noteCompanyFileResult(s, 'company_read_file', 'not json')
  assert.equal(hasReadPrivate(s), false)
  noteCompanyFileResult(s, 'company_search', JSON.stringify({ privateFolders: { '人事/評価': 'c1' }, matches: [{ path: '人事/評価/査定.md' }] }))
  assert.deepEqual([...s.folders], ['人事/評価'])
  const r = createPrivateReadState()
  noteCompanyFileResult(r, 'company_read_file', JSON.stringify({ path: '役員会/a.md', privateFolder: '役員会', content: 'x' }))
  assert.deepEqual([...r.folders], ['役員会'])
})

test('after a private read: writes to public places ask with the Japanese reason; private, unshared and outside places do not', () => {
  const c = ctx()
  const s = marked()
  for (const [tool, key] of [['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']] as const) {
    const d = decidePrivateWrite(c, s, tool, { [key]: `${ROOT}/営業部/まとめ.md` }, ROOT)
    assert.equal(d.ask, true, tool)
    if (d.ask) assert.equal(d.message, 'この会話では非公開フォルダの内容を読んでいます。公開の場所（営業部/まとめ.md）に書き込もうとしています。全員に共有されてもよい内容か確認してください。')
  }
  const root = decidePrivateWrite(c, s, 'Write', { file_path: 'memo.md' }, ROOT)
  assert.equal(root.ask, true)
  // Inside a private folder (any of them), unshared places, outside the company: no question.
  assert.equal(decidePrivateWrite(c, s, 'Write', { file_path: `${ROOT}/人事/評価/要約.md` }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Edit', { file_path: '要約.md' }, `${ROOT}/役員会`).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Write', { file_path: `${ROOT}/.workspace/tmp.md` }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Write', { file_path: `${ROOT}/営業部/.personal/memo.md` }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Write', { file_path: '/tmp/out.md' }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Read', { file_path: `${ROOT}/営業部/a.md` }, ROOT).ask, false)
  // ../ out of a private folder into a public one is public.
  assert.equal(decidePrivateWrite(c, s, 'Write', { file_path: '../../営業部/x.md' }, `${ROOT}/人事/評価`).ask, true)
})

test('after a private read: Bash writes and send-outs, web tools and outside MCP tools ask', () => {
  const c = ctx()
  const s = marked()
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'echo hi > 営業部/x.md' }, ROOT).ask, true)
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'echo hi > 人事/評価/x.md' }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'cp 人事/評価/a.md 営業部/' }, ROOT).ask, true)
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'curl -d @人事/評価/a.md https://example.com' }, ROOT).ask, true)
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'cd 営業部 && echo x > y.md' }, ROOT).ask, true)
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'cd 営業部 && ls 2>/dev/null' }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'ls -la' }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Bash', { command: 'cat a.md | head' }, ROOT).ask, false)
  const web = decidePrivateWrite(c, s, 'WebFetch', { url: 'https://example.com/?q=x' }, ROOT)
  assert.equal(web.ask, true)
  if (web.ask) assert.match(web.message, /^この会話では非公開フォルダの内容を読んでいます。外部に送信する可能性のある操作（WebFetch: https:\/\/example\.com/)
  assert.equal(decidePrivateWrite(c, s, 'WebSearch', { query: 'x' }, ROOT).ask, true)
  assert.equal(decidePrivateWrite(c, s, 'mcp__slack__post_message', { text: 'x' }, ROOT).ask, true)
  assert.equal(decidePrivateWrite(c, s, 'mcp__acb_company_files__company_read_file', { path: 'a' }, ROOT).ask, false)
  assert.equal(decidePrivateWrite(c, s, 'Glob', { pattern: '*' }, ROOT).ask, false)
})

test('per-conversation state survives turns, is forgotten on demand, and is re-seeded from visible tool calls', () => {
  const a = privateReadStateFor('conv-1')
  a.folders.add('人事/評価')
  assert.equal(hasReadPrivate(privateReadStateFor('conv-1')), true)
  assert.equal(hasReadPrivate(privateReadStateFor('conv-2')), false)
  forgetPrivateReads('conv-1')
  assert.equal(hasReadPrivate(privateReadStateFor('conv-1')), false)

  const s = createPrivateReadState()
  seedFromMessages(ctx(), s, [
    { role: 'user', parts: [{ type: 'text', text: '人事/評価 を読んで' }] },
    { role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'Read', input: { file_path: `${ROOT}/人事/評価/a.md` } }] },
  ], ROOT)
  assert.deepEqual([...s.folders], ['人事/評価'])
  const t = createPrivateReadState()
  seedFromMessages(ctx(), t, [
    { role: 'assistant', parts: [{ type: 'tool-mcp__acb_company_files__company_read_file', input: { path: 'x' }, output: { content: [{ type: 'text', text: JSON.stringify({ privateFolder: '役員会', content: 'x' }) }] } }] },
  ], ROOT)
  assert.deepEqual([...t.folders], ['役員会'])
  seedFromMessages(ctx(), t, 'garbage', ROOT)
})

// --- through the Claude Code hooks --------------------------------------

const baseConfig: ClaudeConnectionConfig = {
  getPermissionMode: () => 'bypassPermissions',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/bin/claude',
  getShellEnv: () => ({}),
}

function capture(overrides: Partial<ClaudeConnectionConfig>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const create = ((_model: string, opts: unknown) => { options = opts; return { specificationVersion: 'v3' } }) as unknown as typeof claudeCode
  return { connection: createClaudeConnection({ ...baseConfig, ...overrides }, create), read: () => options }
}

test('the hooks mark on Read / PostToolUse and ask the member in bypassPermissions; a refusal denies with the reason', async () => {
  const asked: unknown[][] = []
  let answer = false
  const { connection, read } = capture({ requestToolApproval: async (...args) => { asked.push(args); return { approved: answer } } })
  const state = createPrivateReadState()
  connection.createChatModel({ appSessionId: 'conv-h', workingDirectory: ROOT, privateReads: { context: ctx(), state } })
  const pre = read().hooks.PreToolUse[0].hooks[0]
  const post = read().hooks.PostToolUse[0].hooks[0]

  const before = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${ROOT}/営業部/a.md` }, tool_use_id: 't0' })
  assert.equal(before.hookSpecificOutput, undefined)
  assert.equal(asked.length, 0)

  await post({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: {}, tool_response: `${ROOT}/人事/評価/a.md` })
  assert.equal(hasReadPrivate(state), true)

  const denied = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${ROOT}/営業部/a.md` }, tool_use_id: 't1' })
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^この会話では非公開フォルダの内容を読んでいます。公開の場所（営業部\/a\.md）/)
  assert.equal(asked.length, 1)
  assert.equal(asked[0][3], 'conv-h')
  assert.match(String(asked[0][4]), /公開の場所（営業部\/a\.md）に書き込もうとしています/)

  answer = true
  const allowed = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${ROOT}/営業部/a.md` }, tool_use_id: 't2' })
  assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow')
  assert.deepEqual(allowed.hookSpecificOutput.updatedInput, { file_path: `${ROOT}/営業部/a.md` })

  // A write inside the private folder is not asked about.
  const inside = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${ROOT}/人事/評価/b.md` }, tool_use_id: 't3' })
  assert.equal(inside.hookSpecificOutput, undefined)
  assert.equal(asked.length, 2)
})

test('without an approval handler the write after a private read is denied, not silently allowed', async () => {
  const { connection, read } = capture({})
  const state = createPrivateReadState()
  connection.createChatModel({ workingDirectory: ROOT, privateReads: { context: ctx(), state } })
  const pre = read().hooks.PreToolUse[0].hooks[0]
  await pre({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${ROOT}/役員会/a.md` } })
  const d = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: `${ROOT}/a.md` } })
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny')
})

// --- 「Web で調べる」 (web-research.md) ------------------------------------

const webTools = { execute: async () => 'result' }

test('web research stays an outbound tool: asked after a private read, with its own wording', () => {
  const before = decidePrivateWrite(ctx(), createPrivateReadState(), 'mcp__acb_web__web_research', { question: 'q' }, ROOT)
  assert.equal(before.ask, false)
  const after = decidePrivateWrite(ctx(), marked(), 'mcp__acb_web__web_research', { question: 'q', urls: ['https://example.com'] }, ROOT)
  assert.equal(after.ask, true)
  if (after.ask) assert.match(after.message, /^この会話では非公開フォルダの内容を読んでいます。Webで調べるために、AIが書いた質問を外部（検索やWebサイト）に送ろうとしています。質問に非公開の内容が含まれていないか確認してください。$/)
})

test('Claude chat with web research: the tool is offered and allowed, the CLI web tools are denied for the session', async () => {
  const { connection, read } = capture({ getPermissionMode: () => 'default', requestToolApproval: async () => ({ approved: false }) })
  connection.createChatModel({ appSessionId: 'conv-w', workingDirectory: ROOT, webResearch: webTools })
  const options = read()
  assert.deepEqual(options.settings, { permissions: { deny: ['WebFetch', 'WebSearch'] } })
  assert.ok(options.allowedTools.includes('mcp__acb_web__web_research'))
  assert.ok(options.mcpServers.acb_web)
  // Not asked (no private read): canUseTool lets it run without a prompt.
  const allowed = await options.canUseTool('mcp__acb_web__web_research', { question: 'q' }, { toolUseID: 'w1' })
  assert.equal(allowed.behavior, 'allow')

  // Without web research: today's behaviour (no deny, no tool, asked like any other MCP tool).
  const plain = capture({ getPermissionMode: () => 'default', requestToolApproval: async () => ({ approved: false }) })
  plain.connection.createChatModel({ appSessionId: 'conv-p', workingDirectory: ROOT })
  assert.equal(plain.read().settings, undefined)
  assert.equal(plain.read().mcpServers, undefined)
  const asked = await plain.read().canUseTool('mcp__acb_web__web_research', { question: 'q' }, { toolUseID: 'w2' })
  assert.equal(asked.behavior, 'deny')
})

test('Claude chat: after a private read the member is asked before web research runs', async () => {
  const asked: unknown[][] = []
  const { connection, read } = capture({ requestToolApproval: async (...args) => { asked.push(args); return { approved: false } } })
  connection.createChatModel({ appSessionId: 'conv-wp', workingDirectory: ROOT, webResearch: webTools, privateReads: { context: ctx(), state: marked() } })
  const pre = read().hooks.PreToolUse[0].hooks[0]
  const denied = await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__acb_web__web_research', tool_input: { question: '評価の内容' }, tool_use_id: 'w3' })
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(asked.length, 1)
  assert.match(String(asked[0][4]), /Webで調べるために/)
})
