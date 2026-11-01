/**
 * Tool rows on the real path, main → renderer (chat-ui-and-history.md 「Tool rows」): the AI
 * SDK turns the agent's calls into the chat server's response (payload limits, the main
 * process's lines), the renderer's AI SDK reads that stream into a message, and the real
 * tool rows (`ToolRows.tsx`) draw it — live, with the main process's lines lost, and restored
 * from history. Guards the owner's report (staging, a 「AI の番」 minutes reading): every row
 * read 「道具を使いました（acb_records・minutes_read）」.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readUIMessageStream, simulateReadableStream, streamText, type UIMessage, type UIMessageChunk } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import '../src/i18n'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { createRecordTools } from '../electron/records/tools'
import type { RecordTurnAccess } from '../electron/records/api'
import { limitedUIMessageStreamResponse } from '../electron/ui-stream-limits'
import { acbToolDisplays, toolDisplayTransform } from '../electron/tool-display-stream'
import { aiTurnStepAllowsRecordTool } from '../shared/ai-turn-steps/registry'
import { ToolRunGroup } from '../src/features/chat/components/ToolRows'
import { planParts } from '../src/features/chat/toolRows'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'

const ROOT = '/Users/sato/acb/会社'
const CALLS: Array<{ id: string; tool: string; input: Record<string, unknown> }> = [
  { id: 'c1', tool: 'minutes_read', input: { id: 'meeting-abc123' } },
  { id: 'c2', tool: 'records_create', input: { type: 'task', title: '修正見積を送る' } },
  { id: 'c3', tool: 'records_create', input: { type: 'task', title: '研修の日程を決める' } },
  { id: 'c4', tool: 'decisions_record', input: { folder: '営業部', title: '研修対象を営業部全体に広げる', why: 'w', source: 's' } },
  { id: 'c5', tool: 'mail_recipients', input: { meetingId: 'meeting-abc123' } },
  { id: 'c6', tool: 'mail_draft_create', input: { toRefs: ['r' + 'a'.repeat(24), 'r' + 'b'.repeat(24)], subject: '社外秘の件', body: '本文' } },
  { id: 'c7', tool: 'meeting__finish_reading', input: { id: 'meeting-abc123', expectedVersion: 3 } },
]

/** The record tools of a minutes-reading 「AI の番」, as the chat server narrows them. */
async function stepRecords() {
  const access: RecordTurnAccess = {
    scope: 'act',
    async call(_method, path) { return path === '/types' ? { types: coreTypeDefinitions().map(definition => ({ definition })) } : {} },
    async close() {},
  }
  const all = await createRecordTools(access)
  assert.ok(all)
  return { ...all, specs: all.specs.filter(s => aiTurnStepAllowsRecordTool('minutes-reading', s.name)) }
}

/** What Claude Code's provider streams for each call (ai-sdk-provider-claude-code 3.6.1), plus a member's own tool. */
function agentModel() {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
  const calls = [...CALLS.map(c => ({ ...c, tool: `mcp__acb_records__${c.tool}` })), { id: 'c8', tool: 'mcp__my_crm__find_customer', input: { q: 'A社' } }]
  const chunks = [
    { type: 'stream-start', warnings: [] },
    ...calls.flatMap(c => [
      { type: 'tool-input-start', id: c.id, toolName: c.tool, providerExecuted: true, dynamic: true },
      { type: 'tool-input-delta', id: c.id, delta: JSON.stringify(c.input) },
      { type: 'tool-input-end', id: c.id },
      { type: 'tool-call', toolCallId: c.id, toolName: c.tool, input: JSON.stringify(c.input), providerExecuted: true, dynamic: true, providerMetadata: { 'claude-code': { rawInput: JSON.stringify(c.input), parentToolCallId: null } } },
      { type: 'tool-result', toolCallId: c.id, toolName: c.tool, result: 'ok', providerExecuted: true, dynamic: true },
    ]),
    { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: '議事録を読み終えました。' }, { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ]
  return new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: chunks as never }) }) })
}

/** The chat server's response for the turn, read back the way the renderer's AI SDK reads it. */
async function liveMessage(transform: (chunk: UIMessageChunk) => UIMessageChunk = c => c): Promise<UIMessage> {
  const records = await stepRecords()
  const response = limitedUIMessageStreamResponse(streamText({ model: agentModel(), prompt: '議事録を読んで' }), {
    ownsConversation: true, onError: () => 'error', label: toolDisplayTransform(acbToolDisplays(records), ROOT),
  })
  const chunks = (await response.text()).split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').map(l => transform(JSON.parse(l.slice(6)) as UIMessageChunk))
  let message: UIMessage | undefined
  for await (const m of readUIMessageStream({ stream: new ReadableStream<UIMessageChunk>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } }) })) message = m
  assert.ok(message)
  return message
}

/** What the member sees of the reply's tool rows (the real components; text parts render elsewhere). */
function shown(message: UIMessage): string {
  const runs = planParts(message.parts).flatMap(item => item.kind === 'run' ? [item] : [])
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...runs.map(run => React.createElement(ToolRunGroup, { key: run.key, item: run }))))
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

function assertPlainRows(text: string, where: string) {
  assert.ok(!/mcp__|acb_records|acb_|my_crm|find_customer|__/.test(text), `${where}: a raw tool id is visible: ${text}`)
  for (const expected of ['議事録を読みました', '記録を 2 件作りました', '決めたことを残しました', '宛先の候補を調べました', 'メールの下書きを作りました', '議事録を読み終えました', 'ほかの道具を使いました']) {
    assert.ok(text.includes(expected), `${where}: missing 「${expected}」 in ${text}`)
  }
  assert.ok(!text.includes('社外秘'), `${where}: a mail subject is visible`)
}

test('an AI turn\'s tool rows read in plain Japanese on the real main → renderer path', async () => {
  const text = shown(await liveMessage())
  assertPlainRows(text, 'live')
  assert.ok(text.includes('研修対象を営業部全体に広げる') && text.includes('宛先 2 人'), text)
  assert.ok(text.includes('記録を 2 件作りました'), 'two creates in a row share one row')
})

test('without the main process\'s lines (an older main, a lost field) the renderer still names every ACB row', async () => {
  const strip = (chunk: UIMessageChunk) => {
    if (chunk.type !== 'tool-input-available' || !chunk.providerMetadata) return chunk
    const rest = { ...chunk.providerMetadata }
    delete rest.acb
    return { ...chunk, providerMetadata: rest }
  }
  assertPlainRows(shown(await liveMessage(strip)), 'no lines from main')
})

test('restored from history — including history saved before the labels existed — the rows read the same', async () => {
  const live = await liveMessage()
  const stored = JSON.parse(JSON.stringify(uiMessageToSessionMessage(live, new Date()))) as ReturnType<typeof uiMessageToSessionMessage>
  assertPlainRows(shown(sessionMessageToUIMessage(stored)), 'restored')
  delete stored.toolLines
  assertPlainRows(shown(sessionMessageToUIMessage(stored)), 'restored without toolLines')
})
