/**
 * Outbound mail in the app (milestone 4 G8, `.claude/rules/outbound-mail.md`).
 *
 * Guards:
 * - the AI gets mail_recipients (read) and, with an act token, mail_draft_create / _update —
 *   never a tool that sends; Codex (read token) only looks up;
 * - drafts carry refs only: an address field is refused by the tool's schema, and the call goes
 *   to the AI's route with the turn's record token, never the session;
 * - a draft becomes the app-drawn card (data part, stored with the message), and the AI is told
 *   the mail is NOT sent;
 * - mail_draft_show puts a new card of the current draft (any state) and changes nothing;
 * - the card's send goes with the person's session and carries exactly the hash shown;
 *   a malformed hash never leaves the app.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { createOutboundMailApi } from '../electron/features/outbound-mail/ipc'
import { MAIL_DRAFT_PART_TYPE, readMailDraft, readMailDraftCard, type MailDraftCard } from '../shared/outbound-mail'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'
import type { OutboundMailView } from '../../shared/types/outbound-mail'
import type { TypeDefinition } from '../../shared/core/record-types'

const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
const SESSION = 'better-auth.session_token=SECRET.sig'
const HASH = `sha256:${'b'.repeat(64)}`
const REF = `r${'1'.repeat(24)}`

const draft = (over: Partial<OutboundMailView> = {}): OutboundMailView => ({
  id: 'outbound_message-0123456789abcdef', state: 'draft', version: 1, hash: HASH, from: 'sato@div.example',
  to: [{ ref: REF, email: 'suzuki@a-corp.example', name: '鈴木 一郎', source: 'calendar', firstTime: true }],
  cc: [{ ref: `r${'2'.repeat(24)}`, email: 'tanaka@div.example', name: '田中', source: 'member', firstTime: false }],
  subject: '本日はありがとうございました', body: '本文 https://example.com', bodyDeleted: false, linkCount: 1,
  meetingId: 'meeting-0123456789abcdef', bundleId: null, sentAt: null, providerMessageId: null, lastChangedBy: 'ai', updatedAt: 't',
  ...over,
})

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeServer(scope: 'read' | 'act') {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope, expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: [{ definition: { name: 'outbound_message', storage: 'server', actions: {}, fields: {} } as unknown as TypeDefinition }] })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { plugins: [] })
    // The same mail of the same meeting made before (minutes.md "Outputs made once"): the server answers that one.
    if (url.endsWith('/api/records-ai/outbound') && String(init.body).includes('"subject":"again"')) return json(200, { draft: draft(), reused: true })
    if (url.endsWith('/api/records-ai/outbound')) return json(201, { draft: draft() })
    if (url.endsWith(`/api/records-ai/outbound/${draft().id}`) && (init.method ?? 'GET') === 'GET') return json(200, { draft: draft({ state: 'sent', version: 3 }) })
    return json(200, { ok: true })
  }) as unknown as typeof globalThis.fetch
  return { api: createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch }), seen }
}

async function turn(scope: 'read' | 'act') {
  const server = fakeServer(scope)
  const cards: MailDraftCard[] = []
  const access = await server.api.openTurn('co', { conversationId: 'conv-1', agent: scope === 'act' ? 'claude-code' : 'codex', scope })
  const tools = await createRecordTools(access!, undefined, { companyId: 'co', conversationId: 'conv-1', onMailDraft: c => cards.push(c), newId: () => 'card-1' })
  return { tools: tools!, cards, seen: server.seen }
}

test('the AI drafts and looks up recipients; no tool sends; Codex only looks up', async () => {
  const claude = (await turn('act')).tools.specs.map(s => s.name).filter(n => n.startsWith('mail_'))
  assert.deepEqual(claude.sort(), ['mail_draft_create', 'mail_draft_show', 'mail_draft_update', 'mail_recipients'])
  const codex = (await turn('read')).tools.specs.map(s => s.name).filter(n => n.startsWith('mail_'))
  assert.deepEqual(codex.sort(), ['mail_draft_show', 'mail_recipients'])
  const all = (await turn('act')).tools.specs.map(s => s.name)
  assert.equal(all.some(n => /send|resolve|discard/.test(n)), false)
})

test('a draft carries refs only (an address is refused), goes with the record token, and becomes the card', async () => {
  const { tools, cards, seen } = await turn('act')
  const withAddress = JSON.parse(await tools.execute('mail_draft_create', { meetingId: 'meeting-0123456789abcdef', toRefs: [REF], to: ['evil@attacker.example'], subject: 's', body: 'b' }))
  assert.equal(withAddress.error, '入力が正しくありません。')
  const rawRef = JSON.parse(await tools.execute('mail_draft_create', { meetingId: 'meeting-0123456789abcdef', toRefs: ['evil@attacker.example'], subject: 's', body: 'b' }))
  assert.equal(rawRef.error, '入力が正しくありません。')
  assert.equal(seen.filter(s => s.url.endsWith('/outbound')).length, 0)

  const told = JSON.parse(await tools.execute('mail_draft_create', { meetingId: 'meeting-0123456789abcdef', toRefs: [REF], subject: 's', body: 'b' }))
  const call = seen.find(s => s.url.endsWith('/api/records-ai/outbound'))!
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(call.headers.Cookie, undefined)
  assert.deepEqual(JSON.parse(call.body!).toRefs, [REF])
  assert.match(told.instruction, /NOT sent/)
  assert.equal(told.state, 'draft')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].draft.hash, HASH)
  // Stored with the message and restored as the same card.
  const stored = uiMessageToSessionMessage({ id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'どうぞ' }, { type: MAIL_DRAFT_PART_TYPE, data: cards[0] }] } as never, new Date())
  assert.equal(stored.mailDrafts?.length, 1)
  const back = sessionMessageToUIMessage(stored).parts.find(p => p.type === MAIL_DRAFT_PART_TYPE) as { data: unknown }
  assert.deepEqual(readMailDraftCard(back.data), cards[0])
})

test('a mail the meeting already has is reused, and the AI is told not to make it again', async () => {
  const { tools } = await turn('act')
  const told = JSON.parse(await tools.execute('mail_draft_create', { meetingId: 'meeting-0123456789abcdef', toRefs: [REF], subject: 'again', body: 'b' }))
  assert.equal(told.reused, true)
  assert.match(told.note, /Do not create it again/)
  const fresh = JSON.parse(await tools.execute('mail_draft_create', { meetingId: 'meeting-0123456789abcdef', toRefs: [REF], subject: 's', body: 'b' }))
  assert.equal(fresh.reused, undefined)
})

test('showing a draft again only reads it and adds a new card in its current state', async () => {
  const { tools, cards, seen } = await turn('read')
  const before = seen.length
  const told = JSON.parse(await tools.execute('mail_draft_show', { id: draft().id }))
  const calls = seen.slice(before)
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['GET', `https://acb.example.jp/api/records-ai/outbound/${draft().id}`]])
  assert.equal(calls[0].headers.Cookie, undefined)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].draft.state, 'sent')
  assert.equal(cards[0].draft.version, 3)
  assert.equal(told.state, 'sent')
  assert.match(told.instruction, /nothing was changed/)
  assert.doesNotMatch(told.instruction, /NOT sent/)
})

test('the card\'s send goes with the session and carries exactly the hash shown; a malformed hash never leaves', async () => {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    return new Response(JSON.stringify({ success: true, data: { outcome: 'sent', draft: draft({ state: 'sent' }) } }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const api = createOutboundMailApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch, log: { warn: () => {} } })
  const r = await api.send('co', draft().id, HASH)
  assert.equal(r.success && r.outcome, 'sent')
  assert.equal(seen[0].url, `https://acb.example.jp/api/companies/co/outbound/${draft().id}/send`)
  assert.equal(seen[0].headers.Cookie, SESSION)
  assert.equal(seen[0].headers.Authorization, undefined)
  assert.deepEqual(JSON.parse(seen[0].body!), { hash: HASH })
  for (const bad of ['sha256:abc', '', 'x'.repeat(71)]) assert.equal((await api.send('co', draft().id, bad)).success, false)
  assert.equal((await api.send('co', '../../x', HASH)).success, false)
  assert.equal(seen.length, 1)
  // 「返事を待つ」: only a day leaves with the hash; anything else stops the send in main.
  await api.send('co', draft().id, HASH, { until: '2026-11-06' })
  assert.deepEqual(JSON.parse(seen[1].body!), { hash: HASH, awaitReply: { until: '2026-11-06' } })
  for (const bad of [{ until: '2026-11-06T09:00' }, { until: '2026-11-06', to: 'x@y' }, { until: 20261106 }, 'yes'] as unknown[]) {
    assert.equal((await api.send('co', draft().id, HASH, bad as { until: string })).success, false)
  }
  assert.equal(seen.length, 2)
})

test('a stored card keeps 「返事を待つ」 as offered; one stored before (or a reply) offers nothing', () => {
  const offered = readMailDraft({ ...draft(), awaitReply: { expected: true, defaultUntil: '2026-11-06', chosenUntil: null } })
  assert.deepEqual(offered?.awaitReply, { expected: true, defaultUntil: '2026-11-06', chosenUntil: null })
  assert.equal(readMailDraft(draft())?.awaitReply, undefined)
  assert.equal(readMailDraft({ ...draft(), awaitReply: { expected: true, defaultUntil: 'soon' } })?.awaitReply, undefined)
})

test('an unreadable stored card is dropped, not drawn', () => {
  assert.equal(readMailDraftCard({ id: 'c', companyId: 'co', at: 't', draft: { ...draft(), hash: 'nope' } }), undefined)
  assert.equal(readMailDraftCard({ id: 'c', companyId: 'co', at: 't', draft: { ...draft(), to: [{ ref: REF, email: 'a@b.example', source: 'ai' }] } }), undefined)
})
