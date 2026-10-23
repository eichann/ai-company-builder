import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DefaultChatTransport, readUIMessageStream, simulateReadableStream, streamText, type UIMessage, type UIMessageChunk } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import {
  AGENT_OUTPUT_LIMITS,
  AGENT_STREAM_LIMITS,
  OVER_BUDGET_LIMITS,
  API_KEY_OUTPUT_LIMITS,
  limitToolPayloads,
  limitedUIMessageStreamResponse,
  summarizeToolPayload,
} from '../electron/ui-stream-limits'
import { referenceFromTool } from '../shared/consultation-reference'

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function fakeBase64(bytes: number): string {
  let out = ''
  const length = Math.ceil(bytes / 3) * 4
  for (let i = 0; i < length; i++) out += BASE64_CHARS[(i * 7 + 3) % 64]
  return out
}

/** Exactly what ai-sdk-provider-claude-code (3.4.2 through 3.6.1, unchanged) emits for a `Read` of a page JPG. */
function claudeImageReadResult(bytes = 390 * 1024) {
  return [{ type: 'image', source: { type: 'base64', data: fakeBase64(bytes), media_type: 'image/jpeg' } }]
}

const json = (value: unknown) => JSON.stringify(value) ?? ''
const hasBase64 = (value: unknown) => /[A-Za-z0-9+/]{512,}/.test(json(value))

test('summarizer: Claude image Read result becomes a descriptor', () => {
  const summary = summarizeToolPayload(claudeImageReadResult())
  assert.deepEqual(summary, ['[image: image/jpeg, 390KB]'])
})

test('summarizer: image blocks nested at different depths are all replaced', () => {
  const data = fakeBase64(50_000)
  const value = {
    content: [
      { type: 'text', text: 'page 1' },
      { type: 'image', source: { type: 'base64', data, media_type: 'image/png' } },
      { nested: { deeper: [{ type: 'image', data, mimeType: 'image/webp' }] } },
      { type: 'document', source: { type: 'base64', data, media_type: 'application/pdf' } },
      { type: 'image-data', data, mediaType: 'image/gif' },
      { type: 'media', data, mediaType: 'audio/mpeg' },
      { url: `data:image/jpeg;base64,${data}` },
      { blob: data },
      { buffer: { type: 'Buffer', data: [1, 2, 3, 4] } },
    ],
  }
  const summary = summarizeToolPayload(value) as { content: unknown[] }
  assert.equal(hasBase64(summary), false)
  assert.deepEqual(summary.content, [
    { type: 'text', text: 'page 1' },
    '[image: image/png, 49KB]',
    { nested: { deeper: ['[image: image/webp, 49KB]'] } },
    '[document: application/pdf, 49KB]',
    '[image: image/gif, 49KB]',
    '[audio: audio/mpeg, 49KB]',
    { url: '[image: image/jpeg, 49KB]' },
    { blob: '[base64: 49KB]' },
    { buffer: '[binary: 4B]' },
  ])
  // Typed arrays are binary too.
  assert.equal(summarizeToolPayload(new Uint8Array(2048)), '[binary: 2KB]')
})

test('summarizer: long strings are clipped with a marker; short ones untouched', () => {
  const long = 'あ'.repeat(10_000)
  const clipped = summarizeToolPayload(long) as string
  assert.ok(clipped.startsWith('あ'.repeat(AGENT_OUTPUT_LIMITS.maxString)))
  assert.ok(clipped.endsWith(`…[truncated ${10_000 - AGENT_OUTPUT_LIMITS.maxString} chars]`))
  assert.equal(summarizeToolPayload('short output'), 'short output')
  // Does not split a surrogate pair at the cut.
  const emoji = summarizeToolPayload('😀'.repeat(3000), { maxString: 101, maxTotal: 1000 }) as string
  assert.ok(emoji.startsWith('😀'.repeat(50) + '…'))
})

test('summarizer: mixed arrays and objects stay within the total budget', () => {
  const value = Array.from({ length: 2_000 }, (_, i) => ({ i, line: `line ${i} `.repeat(20), ok: i % 2 === 0, none: null }))
  const summary = summarizeToolPayload(value) as unknown[]
  assert.ok(json(summary).length <= AGENT_OUTPUT_LIMITS.maxTotal)
  assert.match(String(summary.at(-1)), /^…\[\d+ more items\]$/)
  assert.deepEqual(summary[0], value[0])

  const wide = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`key${i}`, `value ${i}`]))
  const wideSummary = summarizeToolPayload(wide) as Record<string, unknown>
  assert.ok(json(wideSummary).length <= AGENT_OUTPUT_LIMITS.maxTotal)
  assert.match(String(wideSummary['…']), /^\[\d+ more keys\]$/)

  // Hard cap holds even when JSON escaping inflates the size.
  const escaped = summarizeToolPayload(Array.from({ length: 50 }, () => '"\n'.repeat(1000)))
  assert.ok(json(escaped).length <= AGENT_OUTPUT_LIMITS.maxTotal)
})

test('summarizer: null, undefined, primitives, cycles and small values', () => {
  assert.equal(summarizeToolPayload(null), null)
  assert.equal(summarizeToolPayload(undefined), undefined)
  assert.equal(summarizeToolPayload(42), 42)
  assert.equal(summarizeToolPayload(false), false)
  assert.deepEqual(summarizeToolPayload({ a: undefined, b: null, c: [undefined, 1] }), { b: null, c: [null, 1] })
  const small = { stdout: 'ok', exitCode: 0, files: ['a.md', 'b.md'] }
  assert.deepEqual(summarizeToolPayload(small), small)
  const cyclic: Record<string, unknown> = { name: 'x' }
  cyclic.self = cyclic
  assert.deepEqual(summarizeToolPayload(cyclic), { name: 'x', self: '[circular]' })
  let deep: unknown = 'leaf'
  for (let i = 0; i < 30; i++) deep = { deep }
  assert.match(json(summarizeToolPayload(deep)), /\[nested object\]/)
})

test('summarizer: api-key limits keep the 50KB-bounded local tool outputs verbatim', () => {
  const file = 'x '.repeat(25_000)
  assert.equal(summarizeToolPayload(file, API_KEY_OUTPUT_LIMITS), file)
  assert.deepEqual(summarizeToolPayload(claudeImageReadResult(), API_KEY_OUTPUT_LIMITS), ['[image: image/jpeg, 390KB]'])
})

async function collect(chunks: UIMessageChunk[], limits = AGENT_STREAM_LIMITS): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = []
  const reader = new ReadableStream<UIMessageChunk>({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close() } }).pipeThrough(limitToolPayloads(limits)).getReader()
  for (;;) { const { done, value } = await reader.read(); if (done) return out; out.push(value) }
}

test('transform: bounds inputs, outputs, deltas and provider metadata; keeps ids, state and errors', async () => {
  const content = 'y'.repeat(200_000)
  const out = await collect([
    { type: 'tool-input-start', toolCallId: 'w', toolName: 'Write', providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { parentToolCallId: 'agent-1' } } },
    ...Array.from({ length: 40 }, () => ({ type: 'tool-input-delta' as const, toolCallId: 'w', inputTextDelta: 'z'.repeat(1000) })),
    { type: 'tool-input-available', toolCallId: 'w', toolName: 'Write', input: { path: 'notes/ch1.md', file_path: '/abs/notes/ch1.md', content }, providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { rawInput: JSON.stringify({ content }), parentToolCallId: 'agent-1' } } },
    { type: 'tool-output-available', toolCallId: 'w', output: claudeImageReadResult(), providerExecuted: true, dynamic: true },
    { type: 'tool-output-error', toolCallId: 'e', errorText: 'File does not exist.', providerExecuted: true, dynamic: true },
  ])
  const deltas = out.filter(c => c.type === 'tool-input-delta')
  assert.equal(deltas.length, 8)
  const available = out.find(c => c.type === 'tool-input-available') as Extract<UIMessageChunk, { type: 'tool-input-available' }>
  const input = available.input as Record<string, string>
  assert.equal(input.path, 'notes/ch1.md')
  assert.equal(input.file_path, '/abs/notes/ch1.md')
  assert.ok(input.content.length < 5_000)
  const meta = available.providerMetadata!['claude-code']
  assert.equal(meta.parentToolCallId, 'agent-1')
  assert.ok(String(meta.rawInput).length < 1_100)
  const start = out.find(c => c.type === 'tool-input-start') as Extract<UIMessageChunk, { type: 'tool-input-start' }>
  assert.deepEqual(start.providerMetadata, { 'claude-code': { parentToolCallId: 'agent-1' } })
  const output = out.find(c => c.type === 'tool-output-available') as Extract<UIMessageChunk, { type: 'tool-output-available' }>
  assert.equal(output.toolCallId, 'w')
  assert.equal(output.providerExecuted, true)
  assert.deepEqual(output.output, ['[image: image/jpeg, 390KB]'])
  assert.deepEqual(out.at(-1), { type: 'tool-output-error', toolCallId: 'e', errorText: 'File does not exist.', providerExecuted: true, dynamic: true })
})

test('transform: a turn with ~1,000 tool calls stays bounded as a whole; the answer and errors are untouched', async () => {
  const calls = 1_000
  const big = 'line of output '.repeat(4_000)
  const chunks: UIMessageChunk[] = [{ type: 'start' }]
  for (let i = 0; i < calls; i++) {
    const id = `c${i}`
    chunks.push(
      { type: 'tool-input-start', toolCallId: id, toolName: 'Read', providerExecuted: true, dynamic: true },
      { type: 'tool-input-delta', toolCallId: id, inputTextDelta: 'p'.repeat(6_000) },
      { type: 'tool-input-available', toolCallId: id, toolName: 'Read', input: { file_path: `/book/p${i}.md`, note: big }, providerExecuted: true, dynamic: true },
      i % 100 === 99
        ? { type: 'tool-output-error', toolCallId: id, errorText: `failed ${i}`, providerExecuted: true, dynamic: true }
        : { type: 'tool-output-available', toolCallId: id, output: big, providerExecuted: true, dynamic: true },
    )
  }
  const answer = '結論：'.repeat(20_000)
  chunks.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: answer }, { type: 'text-end', id: 't' }, { type: 'finish' })
  const out = await collect(chunks)

  // Per-call caps alone: ~1,000 × (12KB output + 12KB input + 6KB deltas) ≈ 30 MB.
  const toolChars = out.filter(c => c.type.startsWith('tool-')).reduce((n, c) => n + json(c).length, 0)
  assert.ok(toolChars < AGENT_STREAM_LIMITS.turnBudget + calls * 3_000, `tool payloads ${toolChars} chars`)
  // Every call is still there with its state; inputs keep what identifies them.
  assert.equal(out.filter(c => c.type === 'tool-input-available').length, calls)
  assert.equal(out.filter(c => c.type === 'tool-output-available').length, calls - 10)
  assert.deepEqual(out.filter(c => c.type === 'tool-output-error').map(c => (c as { errorText: string }).errorText).slice(-1), ['failed 999'])
  const lastInput = out.filter(c => c.type === 'tool-input-available').at(-1) as Extract<UIMessageChunk, { type: 'tool-input-available' }>
  assert.equal((lastInput.input as { file_path: string }).file_path, '/book/p999.md')
  const lastOutput = out.filter(c => c.type === 'tool-output-available').at(-1) as Extract<UIMessageChunk, { type: 'tool-output-available' }>
  assert.ok(json(lastOutput.output).length <= OVER_BUDGET_LIMITS.maxTotal, `last output ${json(lastOutput.output).length}`)
  // Early calls keep the normal per-call limit.
  const firstOutput = out.find(c => c.type === 'tool-output-available') as Extract<UIMessageChunk, { type: 'tool-output-available' }>
  assert.ok(json(firstOutput.output).length > OVER_BUDGET_LIMITS.maxTotal, `first output ${json(firstOutput.output).length}`)
  // The visible answer is never shortened.
  assert.equal((out.find(c => c.type === 'text-delta') as { delta: string }).delta, answer)
})

test('transform: consultation reference outputs stay parseable by referenceFromTool', async () => {
  const name = 'mcp__acb_consultations__read_consultation'
  const body = JSON.stringify({ id: 'source', title: '桜計画', view: 'messages', content: '料'.repeat(8192), nextOffset: null, warning: '原文です。' })
  const out = await collect([
    { type: 'tool-input-available', toolCallId: 'r', toolName: name, input: { id: 'source', view: 'messages' }, dynamic: true, providerExecuted: true },
    // Codex shape: MCP result object with a text block holding the JSON string.
    { type: 'tool-output-available', toolCallId: 'r', output: { content: [{ type: 'text', text: body }] }, dynamic: true, providerExecuted: true },
  ])
  const output = (out[1] as Extract<UIMessageChunk, { type: 'tool-output-available' }>).output
  assert.deepEqual(referenceFromTool(name, output), { id: 'source', title: '桜計画' })
})

test('stream: real streamText → limited UI stream → DefaultChatTransport → UIMessage carries no base64', async () => {
  const image = claudeImageReadResult()
  assert.ok(json(image).length > 500_000)
  const model = new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'agent-1', toolName: 'Agent', providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { parentToolCallId: null } } },
          { type: 'tool-input-end', id: 'agent-1' },
          { type: 'tool-call', toolCallId: 'agent-1', toolName: 'Agent', input: JSON.stringify({ description: '1章を精読', prompt: 'read' }), providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { rawInput: '{}', parentToolCallId: null } } },
          { type: 'tool-input-start', id: 'read-1', toolName: 'Read', providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { parentToolCallId: 'agent-1' } } },
          { type: 'tool-input-end', id: 'read-1' },
          { type: 'tool-call', toolCallId: 'read-1', toolName: 'Read', input: JSON.stringify({ file_path: '/book/p001.jpg' }), providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { rawInput: '{"file_path":"/book/p001.jpg"}', parentToolCallId: 'agent-1' } } },
          { type: 'tool-result', toolCallId: 'read-1', toolName: 'Read', result: image, providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { rawResult: json(image).slice(0, 10_000), rawResultTruncated: true, parentToolCallId: 'agent-1' } } },
          { type: 'tool-result', toolCallId: 'agent-1', toolName: 'Agent', result: [{ type: 'text', text: '要約完了' }], providerExecuted: true, dynamic: true },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: '完了しました' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
        ],
      }),
    },
  })
  const result = streamText({ model, prompt: '本を書き起こして' })
  const response = limitedUIMessageStreamResponse(result, { ownsConversation: true, onError: () => 'error' })
  const body = await response.clone().text()
  assert.equal(hasBase64(body), false, 'SSE body must not carry base64')
  assert.ok(body.length < 20_000, `SSE body is ${body.length} chars`)

  // Parse it exactly as the renderer does (schema-validated SSE → UIMessage).
  const transport = new DefaultChatTransport<UIMessage>({ api: 'http://127.0.0.1/api/chat', fetch: async () => response })
  const chunks = await transport.sendMessages({ chatId: 'c', messages: [], abortSignal: undefined, trigger: 'submit-message', messageId: undefined })
  let message: UIMessage | undefined
  for await (const m of readUIMessageStream({ stream: chunks, onError: e => { throw e } })) message = m
  assert.ok(message)
  const read = message.parts.find(p => p.type === 'dynamic-tool' && p.toolCallId === 'read-1') as Extract<UIMessage['parts'][number], { type: 'dynamic-tool' }>
  assert.equal(read.state, 'output-available')
  assert.deepEqual(read.output, ['[image: image/jpeg, 390KB]'])
  assert.ok(json(read.output).length <= AGENT_OUTPUT_LIMITS.maxTotal)
  assert.deepEqual(read.input, { file_path: '/book/p001.jpg' })
  assert.equal((read.callProviderMetadata?.['claude-code'] as { parentToolCallId?: string }).parentToolCallId, 'agent-1')
  assert.ok(json(message).length < 5_000, `message is ${json(message).length} chars`)
})
