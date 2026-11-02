/**
 * 「もう一方の AI に聞く」 (chat-and-agents.md "Asking the other AI"). The guards, each with the
 * bug it catches:
 * - the other agent runs read-only: no tools, no settings, no MCP; a CLI that starts with a tool
 *   anyway, or asks for one, is killed (runner flags and stream checks, both agents);
 * - it sees only what the member can see: files inside the company folder (symlinks resolved),
 *   downloaded, not secret-looking, capped; the consultation's visible text only; a private
 *   folder is asked about first, for every agent;
 * - it runs only when the member asked: the tool exists only in a turn whose member message names
 *   the other agent;
 * - time and stop: the turn's stop kills it; the runner's time limit ends it.
 * The real CLIs are never started: a scripted child process and an injected Codex generator.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SECOND_OPINION_PART_TYPE, askedTargets, cleanSecondOpinionAnswer, latestMemberText, readSecondOpinionRecord, secondOpinionTargetOf,
  secondOpinionToolId, validateSecondOpinionInput, visibleConversation, type ConversationMessage,
} from '../shared/agents/second-opinion'
import { claudeSecondOpinionArgs, readClaudeSecondOpinionMessage, runClaudeSecondOpinion } from '../electron/agents/claude-second-opinion'
import { CODEX_SECOND_OPINION_ITEMS, runCodexSecondOpinion } from '../electron/agents/codex-second-opinion'
import { SecondOpinionError, type SecondOpinionJob } from '../electron/agents/second-opinion-runner'
import { createSecondOpinionBudget, createSecondOpinionTools, type SecondOpinionToolsOptions } from '../electron/agents/second-opinion'
import { runSecondOpinion } from '../electron/agents/registry'
import type { CodexTextRequest } from '../electron/agents/codex-text'
import { createPrivateReadState, decidePrivateWrite } from '../electron/private-read-guard'
import { acbToolDisplay } from '../shared/acb-tool-displays'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'
import type { UIMessage } from 'ai'

// ---------------------------------------------------------------------------
// A scripted `claude` process: it writes the given stream lines and records what it got.
// ---------------------------------------------------------------------------

function scriptedClaude(lines: unknown[], { close = true }: { close?: boolean } = {}) {
  const calls: { args: string[]; options: { cwd?: string; env?: Record<string, string> }; stdin: string; killed?: string }[] = []
  const spawn = ((_cli: string, args: string[], options: { cwd?: string; env?: Record<string, string> }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: (signal: string) => void }
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    const call: (typeof calls)[number] = { args, options, stdin: '' }
    calls.push(call)
    child.stdin.on('data', chunk => { call.stdin += String(chunk) })
    child.kill = signal => { call.killed = signal; child.stdout.end(); child.emit('close', null) }
    setImmediate(() => {
      for (const line of lines) if (!call.killed) child.stdout.write(`${JSON.stringify(line)}\n`)
      if (close) { child.stdout.end(); setImmediate(() => { if (!call.killed) child.emit('close', 0) }) }
    })
    return child
  }) as unknown as Parameters<typeof runClaudeSecondOpinion>[1]
  return { spawn, calls }
}

const job = (over: Partial<SecondOpinionJob> = {}): SecondOpinionJob => ({
  material: { question: 'q' }, signal: new AbortController().signal, host: { getCli: () => '/bin/claude', env: { PATH: '/bin', OPENAI_API_KEY: 'sk-secret' } },
  model: 'm', cwd: '/tmp/empty', timeoutMs: 5000, ...over,
})
const init = (tools: string[] = [], servers: unknown[] = []) => ({ type: 'system', subtype: 'init', tools, mcp_servers: servers })
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text })

test('Claude is asked with no tools, no settings, no MCP, one turn — and never with an allow list', () => {
  const args = claudeSecondOpinionArgs('claude-x')
  const flag = (name: string) => args[args.indexOf(name) + 1]
  assert.equal(flag('--tools'), '')
  assert.equal(flag('--setting-sources'), '')
  assert.equal(flag('--permission-mode'), 'dontAsk')
  assert.equal(flag('--max-turns'), '1')
  for (const f of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(f), f)
  assert.ok(!args.includes('--allowedTools') && !args.includes('--mcp-config') && !args.includes('--dangerously-skip-permissions'))
})

test('a Claude that starts with a tool or an MCP server, or asks for a tool, is killed before it answers', async () => {
  for (const lines of [
    [init(['Read']), result('x')],
    [init([], [{ name: 'company' }]), result('x')],
    [init(), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }, result('x')],
  ]) {
    const { spawn, calls } = scriptedClaude(lines, { close: false })
    await assert.rejects(runClaudeSecondOpinion(job(), spawn), (e: unknown) => e instanceof SecondOpinionError && e.code === 'failed')
    assert.equal(calls[0].killed, 'SIGKILL')
  }
  // The stream check itself: an init without the tool list is not accepted as tool-free.
  assert.ok(readClaudeSecondOpinionMessage({ type: 'system', subtype: 'init' }, {}))
})

test('Claude answers from the material on stdin, in the given folder, with the secret-free environment', async () => {
  const { spawn, calls } = scriptedClaude([init(), result('2つ気になりました。①…')])
  const answer = await runClaudeSecondOpinion(job({ material: { question: '見積書は？' } }), spawn)
  assert.equal(answer.answer, '2つ気になりました。①…')
  assert.deepEqual(JSON.parse(calls[0].stdin), { question: '見積書は？' })
  assert.equal(calls[0].options.cwd, '/tmp/empty')
  assert.equal(calls[0].options.env?.OPENAI_API_KEY, undefined)
})

test('Claude not signed in → unavailable without starting it; a stop kills it; the time limit ends it', async () => {
  const { spawn, calls } = scriptedClaude([init(), result('x')])
  await assert.rejects(runClaudeSecondOpinion(job({ host: { getCli: () => '/bin/claude', env: {}, claudeReady: () => false } }), spawn), (e: unknown) => (e as SecondOpinionError).code === 'unavailable')
  assert.equal(calls.length, 0)

  const stop = new AbortController()
  const hanging = scriptedClaude([init()], { close: false })
  const running = runClaudeSecondOpinion(job({ signal: stop.signal }), hanging.spawn)
  setTimeout(() => stop.abort(), 20)
  await assert.rejects(running, (e: unknown) => (e as SecondOpinionError).code === 'cancelled')
  assert.equal(hanging.calls[0].killed, 'SIGKILL')

  const slow = scriptedClaude([init()], { close: false })
  await assert.rejects(runClaudeSecondOpinion(job({ timeoutMs: 30 }), slow.spawn), (e: unknown) => (e as SecondOpinionError).code === 'timeout')
  assert.equal(slow.calls[0].killed, 'SIGKILL')
})

test('Codex is asked through the locked one-shot: text items only, no web search, no shell', async () => {
  let seen: CodexTextRequest | undefined
  const answer = await runCodexSecondOpinion(job({ model: '' }), async request => { seen = request; return 'Codex の意見' })
  assert.equal(answer.answer, 'Codex の意見')
  const textJob = seen!.job!
  assert.deepEqual([...textJob.allowedItems].sort(), ['agentMessage', 'reasoning', 'userMessage'])
  for (const item of ['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall']) assert.ok(!CODEX_SECOND_OPINION_ITEMS.includes(item))
  assert.ok(textJob.overrides.includes('web_search="disabled"'))
  assert.ok(textJob.overrides.includes('features.shell_tool=false'))
  assert.equal(seen!.cwd, '/tmp/empty')
  assert.deepEqual(JSON.parse(seen!.text), { question: 'q' })
  // A tool item stops the one-shot (codex-text.ts) → the tool reports a failure, never an answer.
  await assert.rejects(runCodexSecondOpinion(job(), async () => { throw new Error('tool') }), (e: unknown) => (e as SecondOpinionError).code === 'failed')
  await assert.rejects(runCodexSecondOpinion(job(), async () => { throw new Error('CodexにChatGPTアカウントでログインしてください。') }), (e: unknown) => (e as SecondOpinionError).code === 'unavailable')
})

test('an agent that cannot answer a second opinion is never started', async () => {
  await assert.rejects(runSecondOpinion('api-key', { material: {}, signal: new AbortController().signal, host: { getCli: () => '/x', env: {} } }), /no second opinion/)
})

// ---------------------------------------------------------------------------
// Only when the member asked
// ---------------------------------------------------------------------------

const user = (text: string, metadata?: unknown): ConversationMessage => ({ role: 'user', parts: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) })
const ai = (text: string): ConversationMessage => ({ role: 'assistant', parts: [{ type: 'text', text }, { type: 'tool-Read', text: 'SECRET TOOL OUTPUT' }] })

test('the tool exists only in a turn whose member message names the other agent', () => {
  assert.deepEqual(askedTargets('claude-code', [user('Codex はどう言ってる？')]), ['codex'])
  assert.deepEqual(askedTargets('codex', [user('クロードならどう？')]), ['claude-code'])
  assert.deepEqual(askedTargets('claude-code', [user('見積書を作って')]), [])
  // Named earlier, not now: not asked in this turn.
  assert.deepEqual(askedTargets('claude-code', [user('Codex はどう？'), ai('…'), user('では直して')]), [])
  // A message the app composed is not the member's request.
  assert.deepEqual(askedTargets('claude-code', [user('Codex に聞いて', { appInstruction: { kind: 'task', recordId: 'r', title: 't' } })]), [])
  assert.equal(latestMemberText([user('Codex？'), ai('はい')]), '')
  // Never itself, never the API key.
  assert.deepEqual(askedTargets('claude-code', [user('Claude ならどう？')]), [])
  assert.deepEqual(askedTargets('codex', [user('API キーで')]), [])
})

// ---------------------------------------------------------------------------
// What the other agent may see
// ---------------------------------------------------------------------------

async function company() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'acb-second-'))
  const root = path.join(base, 'company')
  await mkdir(path.join(root, '営業'), { recursive: true })
  await mkdir(path.join(root, '経営'), { recursive: true })
  await mkdir(path.join(root, '.git'), { recursive: true })
  // A file left on disk in a folder the member chose not to download: never shown.
  await mkdir(path.join(root, '資料'), { recursive: true })
  await writeFile(path.join(root, '資料', 'a.md'), '残っていた古いファイル')
  await writeFile(path.join(root, '営業', '見積書.md'), '合計 1,500,000 円')
  await writeFile(path.join(root, '営業', 'big.md'), 'あ'.repeat(30_000))
  await writeFile(path.join(root, '営業', '.env'), 'KEY=1')
  await writeFile(path.join(root, '営業', 'logo.png'), Buffer.from([0x89, 0x50, 0, 1]))
  await writeFile(path.join(root, '.git', 'config'), '[core]')
  await writeFile(path.join(root, '経営', '計画.md'), '非公開の計画')
  await writeFile(path.join(base, 'outside.md'), '外')
  await symlink(path.join(base, 'outside.md'), path.join(root, '営業', 'link.md'))
  return { base, root }
}

function tools(root: string, over: Partial<SecondOpinionToolsOptions> = {}) {
  const runs: Array<{ target: string; material: Record<string, unknown> }> = []
  const answers: unknown[] = []
  const created = createSecondOpinionTools({
    asker: 'claude-code', targets: ['codex'], conversationId: 'c1',
    messages: [user('見積書 v2 を作って', { appInstruction: { kind: 'task', recordId: 'r', title: 't' } }), ai('作りました'), user('Codex はどう言ってる？')],
    root, notDownloaded: () => ['資料'], budget: createSecondOpinionBudget(), signal: new AbortController().signal,
    run: async (target, request) => { runs.push({ target, material: request.material as Record<string, unknown> }); return { answer: '1つ気になりました。①交通費' } },
    onAnswer: record => answers.push(record), log: () => {},
    ...over,
  })!
  return { tools: created, runs, answers }
}

test('the other agent sees only files the member can read here — never outside, secrets, .git, not-downloaded or binary', async () => {
  const { base, root } = await company()
  try {
    for (const file of ['../outside.md', path.join(base, 'outside.md'), '~/.ssh/id_rsa', '営業/link.md', '営業/.env', '.git/config', '資料/a.md', '営業/logo.png', '営業/none.md']) {
      const { tools: t, runs } = tools(root)
      const answer = await t.execute('ask_codex', { question: '見て', files: [file] })
      assert.match(answer, /"error"/, file)
      assert.equal(runs.length, 0, `${file} must not be sent`)
    }
    const { tools: t, runs, answers } = tools(root)
    const answer = await t.execute('ask_codex', { question: '見積書は？', summary: '窓口3つ', files: ['営業/見積書.md', path.join(root, '営業', 'big.md')] })
    assert.match(answer, /【Codex の答え】/)
    const material = runs[0].material as { files: Array<{ path: string; text: string; note?: string }>; conversation: Array<{ text: string }> }
    assert.deepEqual(material.files.map(f => f.path), ['営業/見積書.md', '営業/big.md'])
    assert.ok(Buffer.byteLength(material.files[1].text) <= 40_000 && material.files[1].note)
    // The consultation as shown: no app-composed message, no tool output.
    assert.deepEqual(material.conversation.map(m => m.text), ['作りました', 'Codex はどう言ってる？'])
    assert.ok(!JSON.stringify(material).includes('SECRET TOOL OUTPUT'))
    assert.equal((answers[0] as { agent: string }).agent, 'codex')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('a private folder is asked about first, for every agent; declined → nothing is sent; allowed once → not asked again', async () => {
  const { base, root } = await company()
  try {
    const context = { root, getPrivateFolders: () => ['経営'] }
    const state = createPrivateReadState()
    const asked: string[] = []
    let allow = false
    const make = () => tools(root, { privateReads: { context, state }, requestApproval: async (_id, message) => { asked.push(message); return allow } })
    const first = make()
    assert.match(await first.tools.execute('ask_codex', { question: '計画は？', files: ['経営/計画.md'] }), /許可しませんでした/)
    assert.equal(first.runs.length, 0)
    assert.match(asked[0], /非公開フォルダ/)
    assert.match(asked[0], /Codex（別の会社の AI）/)
    allow = true
    const second = make()
    assert.match(await second.tools.execute('ask_codex', { question: '計画は？', files: ['経営/計画.md'] }), /【Codex の答え】/)
    const third = make()
    await third.tools.execute('ask_codex', { question: 'もう一度', files: ['経営/計画.md'] })
    assert.equal(asked.length, 2)
    // Without anyone to ask, a private read is refused, never sent.
    const lone = tools(root, { privateReads: { context, state: createPrivateReadState() } })
    assert.match(await lone.tools.execute('ask_codex', { question: '計画は？', files: ['経営/計画.md'] }), /"error"/)
    assert.equal(lone.runs.length, 0)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('Claude\'s own private-read hook names the other AI, not a raw tool id', () => {
  const state = createPrivateReadState()
  state.folders.add('経営')
  const decision = decidePrivateWrite({ root: '/c', getPrivateFolders: () => ['経営'] }, state, secondOpinionToolId('codex'), {})
  assert.ok(decision.ask && decision.kind === 'send' && /Codex（別の会社の AI）/.test(decision.message) && !decision.message.includes('mcp__'))
})

test('no named agent → no tool; an unnamed tool is refused; limits per turn and per conversation', async () => {
  assert.equal(createSecondOpinionTools({ ...({} as SecondOpinionToolsOptions), targets: [] }), undefined)
  const { base, root } = await company()
  try {
    const { tools: t, runs } = tools(root)
    assert.match(await t.execute('ask_claude_code', { question: 'x', summary: 's' }), /"error"/)
    await t.execute('ask_codex', { question: 'x', summary: 's' })
    await t.execute('ask_codex', { question: 'y', summary: 's' })
    assert.match(await t.execute('ask_codex', { question: 'z', summary: 's' }), /2回まで/)
    assert.equal(runs.length, 2)
    const budget = createSecondOpinionBudget(1)
    await tools(root, { budget }).tools.execute('ask_codex', { question: 'x', summary: 's' })
    assert.match(await tools(root, { budget }).tools.execute('ask_codex', { question: 'x', summary: 's' }), /上限/)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('unavailable → one plain sentence for the AI to relay; a stopped turn stops the call', async () => {
  const { base, root } = await company()
  try {
    const unavailable = tools(root, { run: async () => { throw new SecondOpinionError('unavailable', 'x') } })
    assert.match(await unavailable.tools.execute('ask_codex', { question: 'x', summary: 's' }), /Codex がこの PC で使えないので聞けませんでした/)
    const stop = new AbortController()
    const stopped = tools(root, { signal: stop.signal, run: async () => { stop.abort(); throw new SecondOpinionError('cancelled', 'x') } })
    await assert.rejects(stopped.tools.execute('ask_codex', { question: 'x', summary: 's' }))
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('input checks', () => {
  assert.equal(validateSecondOpinionInput({}).ok, false)
  assert.equal(validateSecondOpinionInput({ question: 'x', stance: 'attack' }).ok, false)
  assert.equal(validateSecondOpinionInput({ question: 'x', files: ['a', 'b', 'c', 'd', 'e', 'f'] }).ok, false)
  assert.equal(validateSecondOpinionInput({ question: 'x', includeConversation: false }).ok, false)
  const ok = validateSecondOpinionInput({ question: ' x ' })
  assert.ok(ok.ok && ok.input.stance === 'review' && ok.input.includeConversation)
})

// ---------------------------------------------------------------------------
// What the member sees
// ---------------------------------------------------------------------------

test('the row reads 「Codex に聞きました」 with what was shown, and the folded quote survives a restart', () => {
  const display = acbToolDisplay(secondOpinionToolId('codex'))!
  assert.equal(display.label, 'Codex に聞きました')
  assert.equal(acbToolDisplay(secondOpinionToolId('claude-code'))!.label, 'Claude に聞きました')
  assert.equal(display.describe?.({ question: '秘密の質問', files: ['a', 'b'] }, {}), 'この相談とファイル 2 件を見せました')
  assert.equal(secondOpinionTargetOf('mcp__acb_second_opinion__ask_api_key'), undefined)

  const record = { id: 'codex-1', agent: 'codex', answer: '①交通費\u202E' }
  const live: UIMessage = { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'Codex は1つ言っています。' }, { type: SECOND_OPINION_PART_TYPE, id: 'second-opinion-codex-1', data: record } as UIMessage['parts'][number]] }
  const stored = uiMessageToSessionMessage(live, new Date())
  assert.equal(stored.secondOpinions?.[0].answer, '①交通費')
  const restored = sessionMessageToUIMessage(stored)
  assert.ok(restored.parts.some(p => p.type === SECOND_OPINION_PART_TYPE))
  assert.equal(readSecondOpinionRecord({ id: 'x', agent: 'someone', answer: 'a' }), undefined)
  assert.equal(cleanSecondOpinionAnswer('a\u200Bb\u0007c'), 'abc')
  assert.equal(visibleConversation([user('a'), ai('b')]).length, 2)
})
