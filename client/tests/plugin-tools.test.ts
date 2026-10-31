/**
 * An outside system's operations in the app (milestone 3 P7, `.claude/rules/plugins.md`
 * "The app").
 *
 * Guards:
 * - the plugin tools come from the running plugins the server lists; Codex (a
 *   read token) gets no write tool even if the list offers one;
 * - the update tool needs the AI's reason, and calls the server with the turn's
 *   record token, never the session;
 * - the card and what the AI is told say only what is known: applied shows
 *   before → after; a lost answer is "unknown", never a success; a conflict
 *   shows the current values; a refusal says nothing changed;
 * - 「変更前の値を書き戻す」 goes with the person's session (never a record
 *   token), with the consultation as provenance;
 * - an undo answer that is lost or refused never reads as done; the card
 *   survives a restart (stored with the message);
 * - creates (milestone 4): Claude gets `hubspot__log_meeting` /
 *   `hubspot__create_deal`, Codex neither; a create whose answer is unknown
 *   tells the AI never to call it again; APPROVAL_REQUIRED says a person must
 *   approve and nothing was made; the card shows what was made (title, time).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { createPluginOperationsApi } from '../electron/features/plugin-operations/ipc'
import { PLUGIN_OPERATION_PART_TYPE, readPluginOperationCard, shownValue, undoResultView, type PluginOperationCard } from '../shared/plugin-operations'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'
import type { PluginAiTools, PluginOperationRecordView } from '../../shared/types/plugins'

const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
const SESSION = 'better-auth.session_token=SECRET.sig'

const PLUGINS: PluginAiTools = {
  plugins: [{
    id: 'hubspot', label: 'HubSpot', operations: [
      { name: 'refresh_deal', label: 'HubSpot から最新を取る', kind: 'read', recordType: 'deal', decision: false, fields: [] },
      { name: 'update_deal', label: '案件の欄を HubSpot に書き戻す', kind: 'update', recordType: 'deal', decision: true, fields: [
        { name: 'confidence', label: '確度', kind: 'choice', options: ['A', 'B', 'C'], policy: 'auto' },
        { name: 'next_step', label: '次のアクション', kind: 'text', policy: 'auto' },
        { name: 'amount', label: '金額', kind: 'number', policy: 'prior' },
      ] },
      { name: 'log_meeting', label: '商談の記録を残す', kind: 'create', recordType: 'deal', decision: false, fields: [], policy: 'auto', content: ['title', 'body', 'at', 'outcome'], createsRecord: false },
      { name: 'create_deal', label: '取引を新しく作る', kind: 'create', recordType: 'deal', decision: false, policy: 'prior', createsRecord: true, fields: [
        { name: 'amount', label: '金額', kind: 'number', policy: 'prior' },
      ] },
    ],
  }],
}

const opView = (over: Partial<PluginOperationRecordView> = {}): PluginOperationRecordView => ({
  id: 'op-1', operation: 'update_deal', recordId: 'deal-8f3a2c01', recordTitle: '研修導入', state: 'applied',
  fields: { confidence: 'A', next_step: '11/7 デモ' },
  changes: [{ field: 'confidence', before: 'B', after: 'A' }, { field: 'next_step', before: '資料送付', after: '11/7 デモ' }], valueLabels: {},
  actorKind: 'ai', reason: null, undoable: true, undoLabel: '変更前の値を書き戻す', undoNotice: 'x', undoOf: null, undoneBy: null, recordVersion: 8, createdAt: 't',
  kind: 'update', replacedBy: null, recreatable: false, approvedBy: null,
  ...over,
})

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

/** The server: `operation` answers the update (status + body). */
function fakeServer(scope: 'read' | 'act', operation: () => { status: number; body: unknown } | 'network-error' = () => ({ status: 200, body: { success: true, data: { operation: opView(), record: { id: 'deal-8f3a2c01', version: 8 } } } })) {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope, expiresAt: 'x' })
    if (url.includes('/me/record-tokens/')) return json(200, { revoked: true })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: [] })
    // Offers the write even to a read token: the app must not turn it into a tool for Codex.
    if (url.endsWith('/api/records-ai/plugins')) return json(200, PLUGINS)
    if (url.includes('/operations/update_deal') || url.includes('/operations/log_meeting') || url.includes('/create/create_deal')) {
      const r = operation()
      if (r === 'network-error') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    return json(200, { ok: true })
  }) as unknown as typeof globalThis.fetch
  return { api: createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch }), seen }
}

async function turn(scope: 'read' | 'act', operation?: Parameters<typeof fakeServer>[1]) {
  const server = fakeServer(scope, operation)
  const cards: PluginOperationCard[] = []
  const access = await server.api.openTurn('co', { conversationId: 'conv-1', agent: scope === 'act' ? 'claude-code' : 'codex', scope })
  const tools = await createRecordTools(access!, undefined, { companyId: 'co', conversationId: 'conv-1', onOperationCard: c => cards.push(c), newId: () => 'card-1' })
  return { tools: tools!, cards, seen: server.seen }
}

const ask = { id: 'deal-8f3a2c01', expectedVersion: 7, fields: { confidence: 'A', next_step: '11/7 デモ' }, note: '「さっきの商談すごく前向きだった」（田中さん）から確度を上げた' }

test('Claude gets the update tool; Codex only the read, even when the list offers the write', async () => {
  const act = await turn('act')
  assert.ok(act.tools.specs.some(s => s.name === 'hubspot__update_deal' && !s.readOnly))
  assert.ok(act.tools.specs.some(s => s.name === 'hubspot__refresh_deal' && s.readOnly))
  const read = await turn('read')
  const names = read.tools.specs.map(s => s.name)
  assert.ok(names.includes('hubspot__refresh_deal'))
  assert.ok(!names.includes('hubspot__update_deal'))
  assert.ok(read.tools.specs.every(s => s.readOnly))
})

test('the update needs the AI\'s reason (nothing is sent without it) and goes with the record token, never the session', async () => {
  const { tools, seen } = await turn('act')
  const withoutReason: Partial<typeof ask> = { ...ask }
  delete withoutReason.note
  const refused = JSON.parse(await tools.execute('hubspot__update_deal', withoutReason))
  assert.equal(refused.error, '入力が正しくありません。')
  assert.ok(!seen.some(s => s.url.includes('/operations/')))
  assert.match(tools.specs.find(s => s.name === 'hubspot__update_deal')!.description, /根拠/)

  await tools.execute('hubspot__update_deal', ask)
  const call = seen.find(s => s.url.includes('/operations/update_deal'))!
  assert.equal(call.url, 'https://acb.example.jp/api/records-ai/plugins/hubspot/records/deal-8f3a2c01/operations/update_deal')
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`)
  assert.ok(!('Cookie' in call.headers))
  assert.deepEqual(JSON.parse(call.body!), { expectedVersion: 7, fields: ask.fields, note: ask.note })
})

test('applied: the card shows each field before → after, marked as the AI\'s, with the undo; the AI is told it was written', async () => {
  const { tools, cards } = await turn('act')
  const told = JSON.parse(await tools.execute('hubspot__update_deal', ask))
  assert.equal(told.outcome, 'applied')
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].fields, [
    { field: 'confidence', label: '確度', before: 'B', after: 'A' },
    { field: 'next_step', label: '次のアクション', before: '資料送付', after: '11/7 デモ' },
  ])
  assert.equal(cards[0].byAi, true)
  assert.equal(cards[0].undoable, true)
  assert.equal(cards[0].operationId, 'op-1')
  assert.equal(cards[0].reason, ask.note)
  assert.equal(cards[0].conversationId, 'conv-1')
})

test('a choice is shown by its label (A（高）, not a) on the card and to the AI, which keeps the raw value and the record\'s title', async () => {
  const answer = opView({
    fields: { confidence: 'a' }, changes: [{ field: 'confidence', before: 'b', after: 'a' }],
    valueLabels: { confidence: { a: 'A（高）', b: 'B（中）', c: 'C（低）' } },
  })
  const { tools, cards } = await turn('act', () => ({ status: 200, body: { success: true, data: { operation: answer, record: { id: 'deal-8f3a2c01', version: 8 } } } }))
  const told = JSON.parse(await tools.execute('hubspot__update_deal', { ...ask, fields: { confidence: 'A' } }))
  const f = cards[0].fields[0]
  assert.equal(`${shownValue(f.before, f.valueLabels)} → ${shownValue(f.after, f.valueLabels)}`, 'B（中） → A（高）')
  assert.deepEqual(told.fields[0], { field: 'confidence', label: '確度', before: 'b', beforeShown: 'B（中）', after: 'a', afterShown: 'A（高）' })
  assert.equal(told.recordTitle, '研修導入')
  // Stored with the reply and read back after a restart, the labels stay.
  assert.deepEqual(readPluginOperationCard(JSON.parse(JSON.stringify(cards[0])))!.fields[0].valueLabels, { a: 'A（高）', b: 'B（中）', c: 'C（低）' })
})

test('a lost answer is unknown — never a success — on the card and to the AI', async () => {
  for (const operation of [
    () => 'network-error' as const,
    () => ({ status: 502, body: { error: 'bad gateway' } }),
    () => ({ status: 200, body: { success: true, data: { operation: opView({ state: 'sent-unknown', changes: null, undoable: false }), record: { id: 'x', version: 7 } } } }),
  ]) {
    const { tools, cards } = await turn('act', operation)
    const told = JSON.parse(await tools.execute('hubspot__update_deal', ask))
    assert.equal(told.outcome, 'unknown')
    assert.match(told.instruction, /Do NOT say it succeeded/)
    assert.equal(cards[0].outcome, 'unknown')
    assert.equal(cards[0].undoable, false)
    assert.ok(!cards[0].message.includes('更新しました'))
  }
  // Seen in HubSpot, but not confirmed as ACB's write: not a success either, and not undoable.
  const observed = await turn('act', () => ({ status: 200, body: { success: true, data: { operation: opView({ state: 'observed', changes: null, undoable: false }), record: { id: 'x', version: 8 } } } }))
  assert.equal(JSON.parse(await observed.tools.execute('hubspot__update_deal', ask)).outcome, 'observed')
  assert.equal(observed.cards[0].undoable, false)
})

test('refusals say nothing changed; a conflict shows the values there now', async () => {
  const conflict = await turn('act', () => ({ status: 409, body: { error: 'HubSpot 側で先に変わっていました。…', code: 'VERSION_CONFLICT', version: 8, current: { confidence: 'C' } } }))
  await conflict.tools.execute('hubspot__update_deal', ask)
  assert.equal(conflict.cards[0].outcome, 'conflict')
  assert.equal(conflict.cards[0].fields.find(f => f.field === 'confidence')!.current, 'C')

  const prior = await turn('act', () => ({ status: 409, body: { error: '承認が必要な欄のため、変えていません：amount（ほかの欄も変えていません。…）', code: 'APPROVAL_REQUIRED', fields: ['amount'] } }))
  const told = JSON.parse(await prior.tools.execute('hubspot__update_deal', { ...ask, fields: { amount: 1500000, next_step: 'x' } }))
  assert.equal(told.outcome, 'refused')
  assert.match(prior.cards[0].message, /^変更しませんでした。承認が必要な欄/)

  const failed = await turn('act', () => ({ status: 409, body: { error: 'HubSpot に書けませんでした（何も変わっていません）', code: 'WRITE_FAILED', operation: opView({ state: 'failed', changes: null, undoable: false }) } }))
  await failed.tools.execute('hubspot__update_deal', ask)
  assert.equal(failed.cards[0].outcome, 'not-sent')
})

test('「変更前の値を書き戻す」 goes with the person\'s session, never a record token, with the consultation', async () => {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    return new Response(JSON.stringify({ success: true, data: { operation: opView({ operation: 'undo', actorKind: 'human', undoable: false }) } }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const api = createPluginOperationsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch, log: { warn: () => {} } })
  const r = await api.undo('co', 'hubspot', 'op-1', 'conv-1')
  assert.equal(r.success, true)
  assert.equal(seen[0].url, 'https://acb.example.jp/api/companies/co/plugins/hubspot/operations/op-1/undo')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].headers.Cookie, SESSION)
  assert.ok(!('Authorization' in seen[0].headers))
  assert.deepEqual(JSON.parse(seen[0].body!), { conversationId: 'conv-1' })
  // Not an id the server could take as a path: refused before sending.
  assert.equal((await api.undo('co', 'hubspot', '../../x', 'conv-1')).success, false)
  assert.equal(seen.length, 1)
})

test('an undo that is refused or whose answer is lost never reads as done', () => {
  const card = { systemLabel: 'HubSpot', fields: [{ field: 'confidence', label: '確度', after: 'A' as const }] }
  const changed = undoResultView(card, { success: false, offline: false, code: 'CHANGED_OUTSIDE', error: 'x', current: { confidence: 'S' } })
  assert.equal(changed.tone, 'warn')
  assert.deepEqual(changed.current, [{ label: '確度', value: 'S' }])
  const offline = undoResultView(card, { success: false, offline: true, code: null, error: 'サーバーに接続できない' })
  assert.equal(offline.done, false)
  assert.match(offline.message, /分かりません/)
  const lost = undoResultView(card, { success: true, operation: opView({ operation: 'undo', state: 'sent-unknown' }) })
  assert.ok(!lost.message.includes('書き戻しました'))
  assert.match(undoResultView(card, { success: true, operation: opView({ operation: 'undo', state: 'applied' }) }).message, /書き戻しました/)
})

test('the card is stored with the reply and comes back after a restart', async () => {
  const { tools, cards } = await turn('act')
  await tools.execute('hubspot__update_deal', ask)
  const stored = uiMessageToSessionMessage({ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: '更新しました。' }, { type: PLUGIN_OPERATION_PART_TYPE, id: 'plugin-op-card-1', data: cards[0] }] }, new Date())
  assert.deepEqual(stored.pluginOperations, [cards[0]])
  const back = sessionMessageToUIMessage(JSON.parse(JSON.stringify(stored)))
  const part = back.parts.find(p => p.type === PLUGIN_OPERATION_PART_TYPE) as { data: unknown }
  assert.deepEqual(readPluginOperationCard(part.data), cards[0])
  // Malformed stored data is dropped, not shown.
  assert.equal(readPluginOperationCard({ ...cards[0], outcome: 'done' }), undefined)
})

const meetingAsk = { id: 'deal-8f3a2c01', title: '初回商談', body: '先方は前向き。', at: '2026-11-05T15:00:00+09:00', outcome: 'COMPLETED' }
const meetingView = (over: Partial<PluginOperationRecordView> = {}) => opView({
  operation: 'log_meeting', kind: 'create', changes: null, fields: { title: '初回商談', body: '先方は前向き。', at: '2026-11-05T06:00:00.000Z', outcome: 'COMPLETED' },
  undoLabel: '作ったものを取り消す', ...over,
})

test('creates: Claude gets the meeting and the new-deal tools (record token); Codex neither', async () => {
  const act = await turn('act')
  const meeting = act.tools.specs.find(s => s.name === 'hubspot__log_meeting')!
  const deal = act.tools.specs.find(s => s.name === 'hubspot__create_deal')!
  assert.ok(meeting && !meeting.readOnly && deal && !deal.readOnly)
  for (const d of [meeting.description, deal.description]) {
    assert.match(d, /送り直さない/)
    assert.match(d, /approval-requested/)
  }
  const names = (await turn('read')).tools.specs.map(s => s.name)
  assert.ok(!names.includes('hubspot__log_meeting') && !names.includes('hubspot__create_deal'))

  await act.tools.execute('hubspot__log_meeting', meetingAsk)
  const call = act.seen.find(s => s.url.includes('/operations/log_meeting'))!
  assert.equal(call.url, 'https://acb.example.jp/api/records-ai/plugins/hubspot/records/deal-8f3a2c01/operations/log_meeting')
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(JSON.parse(call.body!), { title: '初回商談', body: '先方は前向き。', at: '2026-11-05T15:00:00+09:00', outcome: 'COMPLETED' })
  // A time without an offset is refused before anything is sent.
  const before = act.seen.length
  assert.equal(JSON.parse(await act.tools.execute('hubspot__log_meeting', { ...meetingAsk, at: '2026-11-05 15:00' })).error, '入力が正しくありません。')
  assert.equal(act.seen.length, before)
})

test('a created meeting: the card shows its title and time (not the body), with 「作ったものを取り消す」', async () => {
  const { tools, cards } = await turn('act', () => ({ status: 200, body: { success: true, data: { operation: meetingView(), record: { id: 'deal-8f3a2c01', version: 9 } } } }))
  const told = JSON.parse(await tools.execute('hubspot__log_meeting', meetingAsk))
  assert.equal(told.outcome, 'applied')
  assert.match(told.instruction, /Created and confirmed/)
  assert.equal(cards[0].kind, 'create')
  assert.equal(cards[0].undoLabel, '作ったものを取り消す')
  assert.match(cards[0].message, /作りました/)
  assert.deepEqual(cards[0].fields.map(f => [f.label, f.after]), [['件名', '初回商談'], ['日時', '2026-11-05T06:00:00.000Z'], ['結果', 'COMPLETED']])
  assert.deepEqual(readPluginOperationCard(JSON.parse(JSON.stringify(cards[0]))), cards[0])
})

test('a create whose answer is unknown: never "created", and the AI must not call it again', async () => {
  for (const operation of [
    () => 'network-error' as const,
    () => ({ status: 200, body: { success: true, data: { operation: meetingView({ state: 'sent-unknown', reason: 'too-early', undoable: false }), record: null } } }),
  ]) {
    const { tools, cards } = await turn('act', operation)
    const told = JSON.parse(await tools.execute('hubspot__log_meeting', meetingAsk))
    assert.equal(told.outcome, 'unknown')
    assert.match(told.instruction, /NEVER call the tool again/)
    assert.match(cards[0].message, /HubSpot で確かめてください/)
    assert.ok(!cards[0].message.includes('作りました'))
    assert.equal(cards[0].undoable, false)
  }
})

test('a new deal needs approval: nothing made, the AI is told a person must approve; the card keeps no record id', async () => {
  const { tools, cards, seen } = await turn('act', () => ({ status: 409, body: { error: 'この操作は承認が必要です。承認されるまで何も送っていません', code: 'APPROVAL_REQUIRED' } }))
  const told = JSON.parse(await tools.execute('hubspot__create_deal', { title: 'AI 研修（例示製作所）', fields: { amount: 1200000 } }))
  const call = seen.find(s => s.url.includes('/create/create_deal'))!
  assert.equal(call.url, 'https://acb.example.jp/api/records-ai/plugins/hubspot/create/create_deal')
  assert.deepEqual(JSON.parse(call.body!), { title: 'AI 研修（例示製作所）', fields: { amount: 1200000 } })
  assert.equal(told.outcome, 'refused')
  assert.match(told.instruction, /a person must approve/)
  assert.equal(cards[0].needsApproval, true)
  assert.match(cards[0].message, /^作っていません。/)
  assert.equal(cards[0].recordId, '')
  assert.deepEqual(readPluginOperationCard(JSON.parse(JSON.stringify(cards[0]))), cards[0])
})
