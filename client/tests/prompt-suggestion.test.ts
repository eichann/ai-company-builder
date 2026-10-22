import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { canOfferSuggestion, ghostKeyAction, ghostRemainder, suggestionAfterEdit, suggestionDescription, type GhostInput } from '../src/components/chat/promptSuggestion'
import { currentSuggestion, ghostSuggestion, setSuggestion } from '../src/components/chat/ghostSuggestion'
import { normalizeSuggestion, MAX_SUGGESTION_LENGTH } from '../shared/prompt-suggestion'
import { createChatTurns } from '../electron/chat-turns'
import { createClaudeConnection } from '../electron/agents/claude'
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

test('chat server: the latest turn\'s suggestion is handed out once it arrives; failures and new turns give none', async () => {
  const turns = createChatTurns(50)
  const inject = { push() {} }
  // Arrives after the response ended (as the CLI sends it after the result).
  const a = turns.open('chat-a', inject, { suggestions: true })
  a.end('finished')
  const waiting = turns.suggestion('chat-a')
  a.onPromptSuggestion!('  commit this \n')
  assert.equal(await waiting, 'commit this')
  assert.equal(await turns.suggestion('chat-a'), 'commit this')
  // The CLI said there is none (the query closed after its result).
  const b = turns.open('chat-a', inject, { suggestions: true })
  b.end('finished')
  b.onPromptSuggestion!(null)
  assert.equal(await turns.suggestion('chat-a'), null)
  // Stopped / failed turns offer nothing; nothing at all → bounded wait.
  const c = turns.open('chat-a', inject, { suggestions: true })
  c.end('failed')
  c.onPromptSuggestion!('late')
  assert.equal(await turns.suggestion('chat-a'), null)
  const d = turns.open('chat-a', inject, { suggestions: true })
  d.end('finished')
  assert.equal(await turns.suggestion('chat-a'), null)
  // A new turn replaces the pending one; Codex turns have no suggestions.
  const e = turns.open('chat-a', inject, { suggestions: true })
  const stale = turns.suggestion('chat-a')
  const f = turns.open('chat-a', inject, { suggestions: false })
  assert.equal(await stale, null)
  assert.equal(f.onPromptSuggestion, undefined)
  e.onPromptSuggestion!('old')
  assert.equal(await turns.suggestion('chat-a'), null)
  assert.equal(await turns.suggestion('unknown'), null)
  turns.forget('chat-a')
})

test('Claude Code: suggestions requested only when the chat can show them; null once the query closed without one', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider options as the test reads them
  let options: any
  const factory = ((_model: string, value: unknown) => { options = value; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  const connection = createClaudeConnection({ getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', getShellEnv: () => ({}) }, factory)
  connection.createChatModel({})
  assert.equal(options.promptSuggestions, undefined)
  assert.equal(options.onQueryCreated, undefined)
  const seen: (string | null)[] = []
  connection.createChatModel({ appSessionId: 'chat-a', onPromptSuggestion: value => seen.push(value) })
  assert.equal(options.promptSuggestions, true)
  options.onPromptSuggestion('commit this')
  // The provider's own iteration of the query: init, result, then the query closes.
  const messages = [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success' }]
  const query = { async *[Symbol.asyncIterator]() { yield* messages } }
  options.onQueryCreated(query)
  for await (const message of query as AsyncIterable<unknown>) void message
  assert.deepEqual(seen, ['commit this', null])
  // A query that never answered (the auto-mode re-run case) reports nothing.
  const failed = { async *[Symbol.asyncIterator]() { yield { type: 'system', subtype: 'init' } } }
  options.onQueryCreated(failed)
  for await (const message of failed as AsyncIterable<unknown>) void message
  assert.deepEqual(seen, ['commit this', null])
  connection.createTitleModel()
  assert.equal(options.promptSuggestions, undefined)
})
