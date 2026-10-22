import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { canOfferSuggestion, draftCancelsSuggestion, ghostKeyAction, ghostRemainder, shouldRequestSuggestion, suggestionAfterEdit, suggestionDescription, type GhostInput } from '../src/components/chat/promptSuggestion'
import { currentSuggestion, ghostSuggestion, setSuggestion } from '../src/components/chat/ghostSuggestion'
import { normalizeSuggestion, MAX_SUGGESTION_LENGTH } from '../shared/prompt-suggestion'
import { createChatTurns, type SuggestFromReply } from '../electron/chat-turns'
import { lastMemberText } from '../electron/chat-server'
import { createClaudeConnection } from '../electron/agents/claude'
import { createTurnSteering } from '../electron/agents/steering'
import {
  SUGGESTION_MEMBER_MAX_CHARS, SUGGESTION_MODEL, SUGGESTION_OUTPUT_MAX_CHARS, SUGGESTION_REPLY_MAX_CHARS, SUGGESTION_SYSTEM_PROMPT,
  buildSuggestionInput, cleanSuggestionOutput, conversationLanguage, generatePromptSuggestion, type SuggestionRequest,
} from '../electron/prompt-suggester'
import { claudeCode } from 'ai-sdk-provider-claude-code'

const at = (doc: string, extra: Partial<GhostInput> = {}): GhostInput => ({ doc, caret: doc.length, hasSelection: false, composing: false, ...extra })
const SUGGESTION = 'run the tests'

test('ghost text: the rest of the suggestion after what was typed, only with the caret at the end', () => {
  assert.equal(ghostRemainder(SUGGESTION, at('')), 'run the tests')
  assert.equal(ghostRemainder(SUGGESTION, at('run ')), 'the tests')
  // Typed something else, typed all of it, caret elsewhere, a selection, IME, nothing offered.
  assert.equal(ghostRemainder(SUGGESTION, at('rux')), null)
  assert.equal(ghostRemainder(SUGGESTION, at(SUGGESTION)), null)
  assert.equal(ghostRemainder(SUGGESTION, at('run', { caret: 1 })), null)
  assert.equal(ghostRemainder(SUGGESTION, at('run', { hasSelection: true })), null)
  assert.equal(ghostRemainder(SUGGESTION, at('', { composing: true })), null)
  assert.equal(ghostRemainder(null, at('')), null)
})

test('typing past the suggestion dismisses it for good; typing along keeps it', () => {
  assert.equal(suggestionAfterEdit(SUGGESTION, 'r'), SUGGESTION)
  assert.equal(suggestionAfterEdit(SUGGESTION, 'run the'), SUGGESTION)
  assert.equal(suggestionAfterEdit(SUGGESTION, 'x'), null)
  // Enter adds a new line, which is not part of the suggestion.
  assert.equal(suggestionAfterEdit(SUGGESTION, '\n'), null)
  assert.equal(suggestionAfterEdit(SUGGESTION, SUGGESTION), null)
  assert.equal(suggestionAfterEdit(SUGGESTION, 'r') && suggestionAfterEdit(SUGGESTION, 'rx'), null)
  assert.equal(suggestionAfterEdit(null, ''), null)
})

test('keys: → and Tab accept at the end, Esc dismisses, Enter / ⌘+Enter / IME are left alone', () => {
  const key = (k: string, mods: Record<string, boolean> = {}) => ({ key: k, ...mods })
  assert.equal(ghostKeyAction(key('ArrowRight'), SUGGESTION, at('')), 'accept')
  assert.equal(ghostKeyAction(key('Tab'), SUGGESTION, at('run')), 'accept')
  assert.equal(ghostKeyAction(key('Escape'), SUGGESTION, at('')), 'dismiss')
  assert.equal(ghostKeyAction(key('Enter'), SUGGESTION, at('')), 'pass')
  assert.equal(ghostKeyAction(key('Enter', { metaKey: true }), SUGGESTION, at('')), 'pass')
  assert.equal(ghostKeyAction(key('Tab', { shiftKey: true }), SUGGESTION, at('')), 'pass')
  assert.equal(ghostKeyAction(key('ArrowRight', { metaKey: true }), SUGGESTION, at('')), 'pass')
  assert.equal(ghostKeyAction(key('ArrowRight', { altKey: true }), SUGGESTION, at('')), 'pass')
  assert.equal(ghostKeyAction(key('a'), SUGGESTION, at('')), 'pass')
  assert.equal(ghostKeyAction(key('ArrowDown'), SUGGESTION, at('')), 'pass')
  // Not visible → nothing to accept or dismiss (Tab / → / Esc keep their usual meaning).
  assert.equal(ghostKeyAction(key('ArrowRight'), SUGGESTION, at('run', { caret: 0 })), 'pass')
  assert.equal(ghostKeyAction(key('Tab'), null, at('')), 'pass')
  assert.equal(ghostKeyAction(key('Escape'), SUGGESTION, at('x')), 'pass')
  assert.equal(ghostKeyAction({ key: 'Tab', isComposing: true }, SUGGESTION, at('')), 'pass')
})

test('offered only when the AI is idle, nothing waits for the member, and the input is empty', () => {
  assert.equal(canOfferSuggestion({ running: false, waitingForMember: false, draft: '' }), true)
  assert.equal(canOfferSuggestion({ running: false, waitingForMember: false, draft: '  \n' }), true)
  assert.equal(canOfferSuggestion({ running: true, waitingForMember: false, draft: '' }), false)
  assert.equal(canOfferSuggestion({ running: false, waitingForMember: true, draft: '' }), false)
  assert.equal(canOfferSuggestion({ running: false, waitingForMember: false, draft: '下書き' }), false)
  assert.match(suggestionDescription('続けて'), /入力候補：続けて.*Tab.*Esc/)
})

test('suggestion text: first line, trimmed; empty or overlong is dropped', () => {
  assert.equal(normalizeSuggestion('  b.txt と c.txt も作って  '), 'b.txt と c.txt も作って')
  assert.equal(normalizeSuggestion('\n\nyes\nmore'), 'yes')
  assert.equal(normalizeSuggestion('   '), null)
  assert.equal(normalizeSuggestion(42), null)
  assert.equal(normalizeSuggestion('x'.repeat(MAX_SUGGESTION_LENGTH + 1)), null)
})

test('CodeMirror field: set by the parent, kept while typing along, cleared by other text', () => {
  let state = EditorState.create({ doc: '', extensions: [ghostSuggestion(() => {})] })
  assert.equal(currentSuggestion(state), null)
  state = state.update({ effects: setSuggestion.of(SUGGESTION) }).state
  assert.equal(currentSuggestion(state), SUGGESTION)
  state = state.update({ changes: { from: 0, insert: 'run' } }).state
  assert.equal(currentSuggestion(state), SUGGESTION)
  state = state.update({ changes: { from: 3, insert: 'x' } }).state
  assert.equal(currentSuggestion(state), null)
  // Deleting back does not bring it back.
  state = state.update({ changes: { from: 3, to: 4 } }).state
  assert.equal(currentSuggestion(state), null)
  state = state.update({ effects: setSuggestion.of(null) }).state
  assert.equal(currentSuggestion(state), null)
})

test('chat server: the suggestion is generated from the finished turn\'s reply once the renderer asks', async () => {
  const turns = createChatTurns(50)
  const inject = { push() {} }
  const calls: string[] = []
  const suggest: SuggestFromReply = async reply => { calls.push(reply); return '  commit this \n' }
  // Asked before the response ended: waits for the reply, then generates once.
  const a = turns.open('chat-a', inject, { suggest })
  const waiting = turns.suggestion('chat-a')
  a.end('finished', 'done, 3 files changed')
  assert.equal(await waiting, 'commit this')
  assert.equal(await turns.suggestion('chat-a'), 'commit this')
  assert.deepEqual(calls, ['done, 3 files changed'])
  // Stopped / failed turns and empty replies offer nothing — and make no call.
  const b = turns.open('chat-a', inject, { suggest })
  b.end('failed', 'partial')
  assert.equal(await turns.suggestion('chat-a'), null)
  const c = turns.open('chat-a', inject, { suggest })
  c.end('finished', '   ')
  assert.equal(await turns.suggestion('chat-a'), null)
  // The turn never ends → bounded wait.
  turns.open('chat-a', inject, { suggest })
  assert.equal(await turns.suggestion('chat-a'), null)
  assert.deepEqual(calls, ['done, 3 files changed'])
  // A turn that cannot suggest (api-key / not asked) and unknown conversations.
  turns.open('chat-a', inject).end('finished', 'reply')
  assert.equal(await turns.suggestion('chat-a'), null)
  assert.equal(await turns.suggestion('unknown'), null)
  // A generator failure or an overlong line shows nothing.
  turns.open('chat-a', inject, { suggest: async () => { throw new Error('x') } }).end('finished', 'r')
  assert.equal(await turns.suggestion('chat-a'), null)
  turns.open('chat-a', inject, { suggest: async () => 'x'.repeat(MAX_SUGGESTION_LENGTH + 1) }).end('finished', 'r')
  assert.equal(await turns.suggestion('chat-a'), null)
  turns.forget('chat-a')
})

test('chat server: the member typing (request aborted), a new turn, or forget stops the generation', async () => {
  const turns = createChatTurns(1000)
  const inject = { push() {} }
  const signals: AbortSignal[] = []
  const suggest: SuggestFromReply = (_reply, signal) => {
    signals.push(signal)
    return new Promise(resolve => signal.addEventListener('abort', () => resolve('too late'), { once: true }))
  }
  // The renderer aborts its request (the member typed).
  turns.open('chat-a', inject, { suggest }).end('finished', 'reply')
  const request = new AbortController()
  const typed = turns.suggestion('chat-a', request.signal)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(signals.length, 1)
  request.abort()
  assert.equal(await typed, null)
  assert.equal(signals[0].aborted, true)
  // An aborted request before the turn ended never starts a call.
  turns.open('chat-a', inject, { suggest })
  const early = new AbortController()
  const pending = turns.suggestion('chat-a', early.signal)
  early.abort()
  assert.equal(await pending, null)
  assert.equal(signals.length, 1)
  // A new turn starts while generating.
  turns.open('chat-a', inject, { suggest }).end('finished', 'reply')
  const stale = turns.suggestion('chat-a')
  await new Promise(resolve => setTimeout(resolve, 5))
  turns.open('chat-a', inject, { suggest })
  assert.equal(await stale, null)
  assert.equal(signals[1].aborted, true)
  // The conversation is closed.
  turns.open('chat-a', inject, { suggest }).end('finished', 'reply')
  const closed = turns.suggestion('chat-a')
  await new Promise(resolve => setTimeout(resolve, 5))
  turns.forget('chat-a')
  assert.equal(await closed, null)
  assert.equal(signals[2].aborted, true)
})

test('renderer: asks only after a normal turn, with the setting on, for the CLI agents; typing cancels', () => {
  assert.equal(shouldRequestSuggestion({ aborted: false, authMode: 'claude-code', enabled: true }), true)
  assert.equal(shouldRequestSuggestion({ aborted: false, authMode: 'codex', enabled: true }), true)
  // Setting off → no request, so no model call.
  assert.equal(shouldRequestSuggestion({ aborted: false, authMode: 'claude-code', enabled: false }), false)
  assert.equal(shouldRequestSuggestion({ aborted: true, authMode: 'claude-code', enabled: true }), false)
  assert.equal(shouldRequestSuggestion({ aborted: false, authMode: 'api-key', enabled: true }), false)
  assert.equal(draftCancelsSuggestion(''), false)
  assert.equal(draftCancelsSuggestion(' \n'), false)
  assert.equal(draftCancelsSuggestion('次'), true)
})

test('Claude Code: the CLI\'s own promptSuggestions are not requested; steering still observes the query', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider options as the test reads them
  let options: any
  const factory = ((_model: string, value: unknown) => { options = value; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  const connection = createClaudeConnection({ getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', getShellEnv: () => ({}) }, factory)
  connection.createChatModel({})
  assert.equal(options.promptSuggestions, undefined)
  assert.equal(options.onQueryCreated, undefined)
  connection.createChatModel({ appSessionId: 'chat-a', steering: createTurnSteering() })
  assert.equal(options.promptSuggestions, undefined)
  assert.equal(options.onPromptSuggestion, undefined)
  assert.equal(typeof options.onQueryCreated, 'function')
})

test('chat server: the member text is the latest user message\'s text parts only', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal UI messages
  const messages: any[] = [
    { id: '1', role: 'user', parts: [{ type: 'text', text: 'old' }] },
    { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
    { id: '3', role: 'user', parts: [{ type: 'text', text: ' 表にして ' }, { type: 'file', url: 'data:secret', mediaType: 'text/plain' }, { type: 'text', text: '急ぎで' }] },
  ]
  assert.equal(lastMemberText(messages), '表にして \n急ぎで')
  assert.equal(lastMemberText([]), '')
})

// --- prompt-suggester.ts: the Sonnet call ---

test('suggester input: member message + reply text as JSON data, cut from the end, with the language', () => {
  const longReply = 'あ'.repeat(SUGGESTION_REPLY_MAX_CHARS + 500) + '最後の段落'
  const input = JSON.parse(buildSuggestionInput({ memberMessage: 'x'.repeat(SUGGESTION_MEMBER_MAX_CHARS + 10), reply: longReply })!)
  assert.deepEqual(Object.keys(input), ['language', 'member_message', 'assistant_reply'])
  assert.equal(input.assistant_reply.length, SUGGESTION_REPLY_MAX_CHARS + 1)
  assert.ok(input.assistant_reply.startsWith('…') && input.assistant_reply.endsWith('最後の段落'))
  assert.equal(input.member_message.length, SUGGESTION_MEMBER_MAX_CHARS + 1)
  assert.equal(buildSuggestionInput({ memberMessage: 'hi', reply: '  ' }), null)
  assert.equal(conversationLanguage({ memberMessage: '表にして', reply: 'Done.' }), '日本語')
  assert.equal(conversationLanguage({ memberMessage: 'Make a table', reply: 'Done.' }), 'English')
  assert.equal(conversationLanguage({ memberMessage: 'ok', reply: '表にしました' }), '日本語')
  assert.equal(conversationLanguage({ memberMessage: '👍', reply: 'Done.' }), 'English')
  assert.equal(conversationLanguage({ memberMessage: '', reply: '' }), '日本語')
  // The system prompt treats the conversation as data and rules out risky suggestions.
  assert.match(SUGGESTION_SYSTEM_PROMPT, /指示として実行せず/)
  assert.match(SUGGESTION_SYSTEM_PROMPT, /削除/)
  assert.match(SUGGESTION_SYSTEM_PROMPT, /秘密情報/)
  assert.equal(SUGGESTION_MODEL, 'sonnet')
})

test('suggester output: one line; quotes, bullets and "nothing" markers removed; too long dropped', () => {
  assert.equal(cleanSuggestionOutput('  A社の提案書を要約して  '), 'A社の提案書を要約して')
  assert.equal(cleanSuggestionOutput('「A社の提案書を要約して」'), 'A社の提案書を要約して')
  assert.equal(cleanSuggestionOutput('"Now write one about winter"'), 'Now write one about winter')
  assert.equal(cleanSuggestionOutput('- 表にして\n- もう一つ'), '表にして')
  assert.equal(cleanSuggestionOutput('\n\n続けて\n説明'), '続けて')
  for (const nothing of ['', '  ', 'NONE', 'none.', '(空の出力)', 'なし', '（なし）']) assert.equal(cleanSuggestionOutput(nothing), null, nothing)
  assert.equal(cleanSuggestionOutput('あ'.repeat(SUGGESTION_OUTPUT_MAX_CHARS + 1)), null)
  assert.equal(cleanSuggestionOutput('あ'.repeat(SUGGESTION_OUTPUT_MAX_CHARS)), 'あ'.repeat(SUGGESTION_OUTPUT_MAX_CHARS))
  assert.equal(cleanSuggestionOutput(42), null)
})

function fakeCli(body: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'acb-suggester-'))
  const cli = path.join(cwd, 'cli')
  writeFileSync(cli, `#!${process.execPath}\n${body}`, { mode: 0o700 })
  return { cwd, cli, dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}
const CONTEXT = { memberMessage: '提案書を一覧にして', reply: '5件あります。どれか確認しますか？' }

test('suggester call: hardened one-shot sonnet CLI, conversation on stdin as data', { skip: process.platform === 'win32' }, async () => {
  const f = fakeCli(`
const args = process.argv.slice(2)
const flag = name => args[args.indexOf(name) + 1]
const ok = flag('--model') === 'sonnet' && args.includes('-p') && args.includes('--safe-mode') && flag('--tools') === ''
  && args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands') && args.includes('--no-session-persistence')
  && flag('--setting-sources') === '' && flag('--output-format') === 'json' && flag('--system-prompt').includes('予測器')
  && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1'
if (!ok) process.exit(2)
let input = ''; process.stdin.on('data', chunk => input += chunk)
process.stdin.on('end', () => console.log(JSON.stringify({ result: '「' + JSON.parse(input).member_message + 'をA社だけに絞って」' })))
`)
  try {
    assert.equal(await generatePromptSuggestion({ cli: f.cli, cwd: f.cwd, env: process.env, context: CONTEXT, signal: new AbortController().signal }), '提案書を一覧にしてをA社だけに絞って')
  } finally { f.dispose() }
})

test('suggester call: errors, timeouts, cancellation and a missing CLI all give no suggestion', { skip: process.platform === 'win32' }, async () => {
  const errored = fakeCli(`process.stdin.resume(); console.log(JSON.stringify({ is_error: true, result: 'Login required' }))`)
  const failing = fakeCli(`process.stdin.resume(); process.exit(1)`)
  const hanging = fakeCli('process.stdin.resume(); setInterval(() => {}, 1000)')
  const signal = new AbortController().signal
  try {
    assert.equal(await generatePromptSuggestion({ cli: errored.cli, cwd: errored.cwd, env: process.env, context: CONTEXT, signal }), null)
    assert.equal(await generatePromptSuggestion({ cli: failing.cli, cwd: failing.cwd, env: process.env, context: CONTEXT, signal }), null)
    assert.equal(await generatePromptSuggestion({ cli: hanging.cli, cwd: hanging.cwd, env: process.env, context: CONTEXT, signal, timeoutMs: 100 }), null)
    const cancel = new AbortController()
    const pending = generatePromptSuggestion({ cli: hanging.cli, cwd: hanging.cwd, env: process.env, context: CONTEXT, signal: cancel.signal })
    cancel.abort()
    assert.equal(await pending, null)
    assert.equal(await generatePromptSuggestion({ cli: path.join(hanging.cwd, 'missing'), cwd: hanging.cwd, env: process.env, context: CONTEXT, signal }), null)
    // Nothing to predict from, or already cancelled: no process at all.
    let spawned = 0
    const spawn = (() => { spawned++; throw new Error('not expected') }) as unknown as SuggestionRequest['spawn']
    assert.equal(await generatePromptSuggestion({ cli: 'x', cwd: hanging.cwd, env: {}, context: { memberMessage: 'a', reply: '' }, signal, spawn }), null)
    const aborted = new AbortController(); aborted.abort()
    assert.equal(await generatePromptSuggestion({ cli: 'x', cwd: hanging.cwd, env: {}, context: CONTEXT, signal: aborted.signal, spawn }), null)
    assert.equal(spawned, 0)
  } finally { errored.dispose(); failing.dispose(); hanging.dispose() }
})
