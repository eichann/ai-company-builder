/**
 * The app's side of the AI at the member's request (records.md "The AI at the member's request", owner decision
 * 2026-11-26 「AI に完了を頼めるようにする」). The server decides every call; the app only asks and shows. Guards:
 * - the turn's token is asked as a member's turn only for a turn the member started with their own words — never an
 *   unattended step, a job's run, a step's consultation, a message the app composed (an instruction) or one it sent in
 *   the member's place to start a consultation (a Skill's 実行, minutes reading: `appSent`, kept with the message) — and
 *   never with a run;
 * - only a token the server marked gets the asked-only description and instructions; any other keeps 「本人が画面で」;
 * - what was done becomes one card per turn (the same id, every item), only when the server says it was at the
 *   member's request; ［取り消す］ is the member's own undo of that entry with their session;
 * - 経緯 says 「AI が（本人の頼みで）完了にしました」.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { AI_ASKED_PART_TYPE, aiAskedDoneWords, readAiAskedCard, type AiAskedCard } from '../shared/ai-asked'
import { historyLines } from '../shared/record-views'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'
import { undoAiAsked } from '../src/features/chat/api'
import { latestMemberText } from '../shared/agents/second-opinion'

const TOKEN = 'acb_rec_co.' + 'b'.repeat(64)
const TASK = 'task-0123456789abcdef'
const types = coreTypeDefinitions().filter(d => ['task', 'reply_request', 'interaction', 'project'].includes(d.name))

async function turn(opts: { memberTurn?: boolean; serverMarks?: boolean; bound?: boolean; askedBy?: string | null } = {}) {
  const seen: Array<{ url: string; body: unknown }> = []
  const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
  let version = 1
  const fetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ url, body })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope: 'act', expiresAt: 'x', ...(opts.serverMarks ?? true ? { memberTurn: body?.memberTurn === true && !body?.run } : {}) })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: types.map(definition => ({ definition })) })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { plugins: [] })
    if (url.includes('/actions/complete')) {
      version += 1
      return json(200, { record: { id: TASK, type: 'task', title: '請求書を送る', state: 'done', version }, entry: { version, action: 'complete', ...(opts.askedBy === null ? {} : { askedBy: opts.askedBy ?? 'u-bob' }) } })
    }
    return json(200, {})
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=SECRET'], fetch, runOf: () => (opts.bound ? { id: 'run-1', generation: 1 } : null) })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act', ...(opts.memberTurn ? { memberTurn: true } : {}) })
  const cards: AiAskedCard[] = []
  let n = 0
  const tools = (await createRecordTools(access!, undefined, { companyId: 'co', conversationId: 'conv-1', newId: () => `card-${++n}`, onAskedClose: c => cards.push(c) }))!
  return { tools, cards, seen, access: access! }
}
const spec = (t: Awaited<ReturnType<typeof turn>>['tools'], name: string) => t.specs.find(s => s.name === name)!

test('the token is asked as a member\'s turn only when the chat server says so, never with a run; the server\'s mark is what counts', async () => {
  const marked = await turn({ memberTurn: true })
  assert.equal((marked.seen.find(s => s.url.endsWith('/me/record-tokens'))!.body as { memberTurn?: boolean }).memberTurn, true)
  assert.equal(marked.access.memberTurn, true)
  const plain = await turn()
  assert.equal('memberTurn' in (plain.seen.find(s => s.url.endsWith('/me/record-tokens'))!.body as object), false)
  assert.equal(plain.access.memberTurn, false)
  const bound = await turn({ memberTurn: true, bound: true })
  assert.equal('memberTurn' in (bound.seen.find(s => s.url.endsWith('/me/record-tokens'))!.body as object), false)
  assert.equal(bound.access.memberTurn, false)
  // An older server that does not answer the mark: not a member's turn.
  assert.equal((await turn({ memberTurn: true, serverMarks: false })).access.memberTurn, false)
})

test('the asked-only description and instructions only for a marked token; otherwise 「本人が画面で」 as before', async () => {
  const marked = await turn({ memberTurn: true })
  for (const name of ['task__complete', 'reply_request__close', 'reply_request__replied_elsewhere', 'task__retitle', 'task__set_purpose']) {
    assert.match(spec(marked.tools, name).description, /はっきり頼んだときだけ/, name)
    assert.ok(spec(marked.tools, name).askedCard, name)
  }
  // Task version 16: the requester's AI too, said by the type's own field names.
  assert.match(spec(marked.tools, 'task__retitle').description, /メンバー本人が依頼した人か担当の記録で/)
  assert.match(spec(marked.tools, 'task__complete').description, /メンバー本人が担当の記録で/)
  assert.match(marked.tools.instructions, /task__retitle/)
  // The title argument is the one title rule: one line, up to 200 characters.
  const retitle = spec(marked.tools, 'task__retitle')
  assert.equal(retitle.schema.safeParse({ id: TASK, expectedVersion: 1, title: 'A社 見積書' }).success, true)
  assert.equal(retitle.schema.safeParse({ id: TASK, expectedVersion: 1, title: 'あ'.repeat(201) }).success, false)
  assert.equal(retitle.schema.safeParse({ id: TASK, expectedVersion: 1, title: '' }).success, false)
  assert.doesNotMatch(spec(marked.tools, 'task__decline').description, /はっきり頼んだ/)
  assert.ok(!spec(marked.tools, 'reply_request__drop').askedCard)
  assert.match(marked.tools.instructions, /メンバーに頼まれたときだけ使える操作/)
  // Task 17 / interaction 9 (owner decision 2026-11-27): アーカイブ, 引き受ける, 済んだ and 「取り消して」 in a marked turn only.
  for (const name of ['task__cancel', 'task__accept', 'interaction__settle']) assert.ok(spec(marked.tools, name).askedCard, name)
  // PR C (task 18, project 3): the requester's 確かめる人・終わったら and the 責任者's なんのため・期限・責任者 — never 終える.
  for (const name of ['task__set_reviewer', 'task__set_when_done', 'project__set_purpose', 'project__set_due', 'project__set_owner']) assert.ok(spec(marked.tools, name).askedCard, name)
  assert.ok(!spec(marked.tools, 'project__finish').askedCard)
  assert.match(marked.tools.instructions, /task__set_reviewer/)
  assert.match(spec(marked.tools, 'task__cancel').description, /「アーカイブ」と呼ぶ/)
  assert.ok(spec(marked.tools, 'records_undo'))
  // 済んだ's settled_by is the server's (the person acting): never asked of the AI.
  assert.equal(spec(marked.tools, 'interaction__settle').schema.safeParse({ id: TASK, expectedVersion: 1 }).success, true)
  assert.equal(spec(marked.tools, 'interaction__settle').schema.safeParse({ id: TASK, expectedVersion: 1, settled_by: 'u-x' }).success, false)
  assert.ok(!spec(marked.tools, 'task__decline').askedCard)
  for (const t of [await turn(), await turn({ memberTurn: true, bound: true })]) {
    assert.match(spec(t.tools, 'task__complete').description, /AI からはできない/)
    assert.ok(!spec(t.tools, 'task__complete').askedCard)
    assert.ok(!spec(t.tools, 'task__cancel').askedCard)
    assert.ok(!t.tools.specs.some(s => s.name === 'records_undo'), 'no undo outside a member\'s turn')
    assert.doesNotMatch(t.tools.instructions, /メンバーに頼まれたときだけ/)
  }
})

test('「取り消して」 calls the AI\'s undo route with the entry\'s version; it never joins the card (an undo is itself the taking back)', async () => {
  const t = await turn({ memberTurn: true })
  await t.tools.execute('records_undo', { id: TASK, version: 2, expectedVersion: 3 })
  const sent = t.seen.find(s => s.url.endsWith(`/item/${TASK}/undo`))
  assert.deepEqual(sent?.body, { version: 2, expectedVersion: 3 })
  assert.equal(t.cards.length, 0)
})

test('what was done becomes one card per turn with every item, only when the server says it was at the member\'s request', async () => {
  const t = await turn({ memberTurn: true })
  await t.tools.execute('task__complete', { id: TASK, expectedVersion: 1 })
  await t.tools.execute('task__complete', { id: TASK, expectedVersion: 2 })
  assert.equal(t.cards.length, 2)
  assert.equal(t.cards[0].id, t.cards[1].id)
  assert.deepEqual(t.cards[1].items.map(i => [i.recordId, i.version, i.done]), [[TASK, 2, '完了にしました'], [TASK, 3, '完了にしました']])
  const none = await turn({ memberTurn: true, askedBy: null })
  await none.tools.execute('task__complete', { id: TASK, expectedVersion: 1 })
  assert.equal(none.cards.length, 0)
})

test('the card is read strictly and kept with the message: the latest copy of a turn\'s card wins', () => {
  const card = (n: number): AiAskedCard => ({ id: 'c1', companyId: 'co', conversationId: 'conv-1', at: '2026-11-26T00:00:00.000Z', items: Array.from({ length: n }, (_, i) => ({ recordId: TASK, title: `件 ${i}`, done: '完了にしました', version: i + 2 })) })
  assert.equal(readAiAskedCard({ ...card(1), items: [{ recordId: '../x', title: 't', done: 'd', version: 2 }] }), undefined)
  assert.equal(readAiAskedCard({ ...card(1), companyId: '' }), undefined)
  const stored = uiMessageToSessionMessage({ id: 'a1', role: 'assistant', parts: [
    { type: 'text', text: '2件片づけました' }, { type: AI_ASKED_PART_TYPE, id: 'ai-asked-c1', data: card(1) }, { type: AI_ASKED_PART_TYPE, id: 'ai-asked-c1', data: card(2) },
  ] } as never, new Date())
  assert.equal(stored.aiAsked?.length, 1)
  assert.equal(stored.aiAsked?.[0].items.length, 2)
  const restored = sessionMessageToUIMessage(stored)
  assert.equal(restored.parts.filter(p => p.type === AI_ASKED_PART_TYPE).length, 1)
})

test('a message the app sent in the member\'s place keeps that mark through the history (a restart never makes it theirs)', () => {
  const sent = uiMessageToSessionMessage({ id: 'u1', role: 'user', metadata: { appSent: true }, parts: [{ type: 'text', text: '/weekly-report ' }] } as never, new Date())
  assert.equal(sent.appSent, true)
  const back = sessionMessageToUIMessage(sent)
  assert.equal(latestMemberText([back as never]), '')
  const own = sessionMessageToUIMessage(uiMessageToSessionMessage({ id: 'u2', role: 'user', parts: [{ type: 'text', text: '完了にして' }] } as never, new Date()))
  assert.equal(latestMemberText([own as never]), '完了にして')
})

test('［取り消す］ is the member\'s own undo of that entry (tasks:undo with the version it made)', async () => {
  const calls: unknown[][] = []
  await undoAiAsked('co', TASK, 4, { undoTaskAction: async (...args: unknown[]) => { calls.push(args); return { success: true, recordId: TASK } } } as never)
  assert.deepEqual(calls, [['co', TASK, 4, 4]])
})

// Task version 16: the AI fixed a task's 件名 (v4) and then its 目的 (v5) in one turn — the earlier line's ［取り消す］ is
// sent once more at the record's version now (the server still judges CHANGED_SINCE); any other refusal is not retried.
test('［取り消す］ of an earlier entry on the same record is retried once at the record\'s version now', async () => {
  const calls: unknown[][] = []
  const port = (first: { code: string }) => ({
    undoTaskAction: async (...args: unknown[]) => {
      calls.push(args)
      return calls.length === 1 ? { success: false, offline: false, error: 'x', ...first } : { success: true, recordId: TASK }
    },
    getRecordCard: async () => ({ success: true, card: { version: 5 } }),
  }) as never
  assert.equal((await undoAiAsked('co', TASK, 4, port({ code: 'VERSION_CONFLICT' }))).success, true)
  assert.deepEqual(calls, [['co', TASK, 4, 4], ['co', TASK, 4, 5]])
  calls.length = 0
  assert.equal((await undoAiAsked('co', TASK, 4, port({ code: 'CHANGED_SINCE' }))).success, false)
  assert.deepEqual(calls, [['co', TASK, 4, 4]])
})

test('経緯 says the AI did it at the member\'s request; other AI entries read as before', () => {
  const task = coreTypeDefinitions().find(d => d.name === 'task')!
  const rr = coreTypeDefinitions().find(d => d.name === 'reply_request')!
  const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ recordId: TASK, version: 2, action: 'complete', fromState: 'todo', toState: 'done', actorId: 'u-bob', actorKind: 'ai', actorSource: 'claude-code', at: 'x', note: '', changes: [], attachments: [], decision: null, isDecision: true, typeVersion: 15, reversesVersion: null, proposedBy: null, conversationId: 'conv-1', ...over })
  assert.equal(historyLines([entry({ askedBy: 'u-bob' })], task, {})[0].text, 'AI が（本人の頼みで）完了にしました')
  assert.equal(historyLines([entry({})], task, {})[0].text, 'AI：完了にする')
  assert.equal(historyLines([entry({ action: 'close', askedBy: 'u-bob' })], rr, {})[0].text, 'AI が（本人の頼みで）終わりにしました')
  assert.equal(aiAskedDoneWords('もう返した'), '「もう返した」にしました')
})

async function chatTurn(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { startChatServer } = await import('../electron/chat-server')
  const asked: Array<boolean | undefined> = []
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    getWriteGuard: () => ({ root: os.tmpdir(), getAccess: () => undefined }),
    createRecordTools: async request => { asked.push(request.memberTurn); return null },
    ...extra,
  })
  const abort = new AbortController()
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'この7件を完了にして' }] }], companyId: 'co', companyRootPath: os.tmpdir(), ...body }),
    })
    await res.text().catch(() => '')
  } catch { /* the turn itself is not what is tested */ } finally {
    abort.abort()
    server.server.close()
  }
  return asked
}

test('the chat server marks only a turn the member started with their own words', async () => {
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-plain-0001' }), [true])
  // A message the app composed (an app instruction) is not the member's words.
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-app-00001', messages: [{ id: 'm', role: 'user', metadata: { appInstruction: { kind: 'task-consult' } }, parts: [{ type: 'text', text: '完了にして' }] }] }), [false])
  // A message the app sent in the member's place (a Skill's 実行 `/<skill> `, minutes reading, …): the text may carry outside
  // text (minutes, someone else's SKILL.md), so never the member's own request — until the member writes themselves.
  const appSent = { id: 'm', role: 'user', metadata: { appSent: true }, parts: [{ type: 'text', text: '/weekly-report ' }] }
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-skill-001', messages: [appSent] }), [false])
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-skill-002', messages: [appSent, { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'はい' }] }, { id: 'm2', role: 'user', parts: [{ type: 'text', text: 'この7件を完了にして' }] }] }), [true])
  // An unattended 「AI の番」 step, a job's run and a step's consultation never.
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-turn-0001', aiTurnStep: 'minutes-reading' }), [false])
  const ceiling = { pluginStepTools: () => ({ allowsRecordTool: () => true, builtinTools: [] }), stepWriteArea: async () => ({ nowhere: true, reads: [] }) }
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-job-00001', aiTurnStep: 'job-procedure' }, ceiling), [false])
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-step-0001' }, { stepWriteArea: async () => 'sales/.personal/deal-1' }), [false])
})
