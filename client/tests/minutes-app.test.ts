/**
 * 「商談のあと」 in the app (milestone 4 G9, `.claude/rules/minutes.md` "The app").
 *
 * Guards:
 * - the check loop never asks the server about minutes (nor lists them) without
 *   the member's Google permission for minutes — not at start, not on the
 *   10-minute tick, not on a records signal;
 * - with it: the check runs with the member's session, records stuck in
 *   「読んでいる」 are put back with `retry` at their version, and the notices are
 *   the member's received minutes;
 * - a records signal only makes main ask the server again (the signal carries
 *   nothing it acts on), and only for the company being watched;
 * - 「今は読まない」 and the deal choice go with the session;
 * - the first message names the minutes record by id and carries no minutes
 *   text (the app never has it); the deal choice card appears only when no deal
 *   is linked and not exactly one candidate, from the minutes tool's answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMinutesChecker, MINUTES_CHECK_INTERVAL_MS } from '../electron/features/minutes/checker'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'
import { PLUGIN_OPERATION_PART_TYPE } from '../shared/plugin-operations'
import { MINUTES_DEAL_CHOICE_PART_TYPE, dealChoiceFor, minutesConsultationTitle, minutesFirstMessage, minutesNoticeText, type MinutesDealChoiceCard } from '../shared/minutes-app'

const SESSION = 'better-auth.session_token=SECRET.sig'
const MINUTES_ID = 'minutes-0a1b2c3d4e5f60718293a4b5'

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

const minutesRecord = (over: Record<string, unknown> = {}) => ({
  id: MINUTES_ID, type: 'minutes', typeVersion: 1, title: 'A社 商談', summary: '', path: null, state: 'received',
  fields: { meeting_at: '2026-11-05T06:00:00.000Z', assignee: 'usr-7c1e' }, version: 1, updatedAt: 't', ...over,
})

function fakeServer(opts: { grant: boolean; stale?: string[] }) {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/google')) return json({ available: true, reason: null, connected: opts.grant, status: opts.grant ? 'active' : null, googleEmail: null, features: opts.grant ? ['minutes'] : [], domain: null, practice: false })
    if (url.endsWith('/me/minutes/check')) return json({ checked: true, meetings: 1, internalOnly: 0, created: [MINUTES_ID], existing: 0, waiting: 0, stale: opts.stale ?? [] })
    if (url.endsWith('/records/ai-turn')) return json({ total: 2, records: [minutesRecord(), { ...minutesRecord({ id: 'task-0a1b2c3d', type: 'task', state: 'todo' }) }] })
    if (url.includes('/records/item/minutes-stuck0001') && (init.method ?? 'GET') === 'GET') return json({ record: minutesRecord({ id: 'minutes-stuck0001', state: 'reading', version: 4 }), links: [] })
    return json({ ok: true })
  }) as unknown as typeof globalThis.fetch
  const ticks: Array<() => void> = []
  const changed: string[] = []
  const checker = createMinutesChecker({
    baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch, log: { warn: () => {} },
    onChanged: id => changed.push(id),
    setInterval: (fn, ms) => { assert.equal(ms, MINUTES_CHECK_INTERVAL_MS); ticks.push(fn); return ticks.length },
    clearInterval: () => {},
  })
  return { checker, seen, ticks, changed }
}

const paths = (seen: Seen[]) => seen.map(s => `${s.method} ${s.url.replace('https://acb.example.jp/api/companies/co', '')}`)
const settle = () => new Promise(resolve => setImmediate(resolve))

test('without the member\'s Google permission for minutes, nothing about minutes is asked — at start, on the tick or on a records signal', async () => {
  const { checker, seen, ticks } = fakeServer({ grant: false })
  await checker.watch('co')
  ticks[0]()
  await settle()
  checker.recordsSignal('co')
  await settle()
  assert.deepEqual(await checker.notices('co'), { available: false, notices: [] })
  assert.ok(seen.length > 0 && seen.every(s => s.url.endsWith('/me/google')), paths(seen).join('\n'))
})

test('with it: the check goes with the session; a record stuck in 「読んでいる」 is put back with retry at its version; the notices are the received minutes', async () => {
  const { checker, seen, changed } = fakeServer({ grant: true, stale: ['minutes-stuck0001'] })
  await checker.watch('co')
  assert.deepEqual(paths(seen), [
    'GET /me/google', 'POST /me/minutes/check',
    'GET /records/item/minutes-stuck0001', 'POST /records/item/minutes-stuck0001/actions/retry',
    'GET /records/ai-turn',
  ])
  assert.ok(seen.every(s => s.headers.Cookie === SESSION && !('Authorization' in s.headers)))
  assert.deepEqual(JSON.parse(seen[3].body!), { expectedVersion: 4 })
  const shown = await checker.notices('co')
  assert.equal(shown.available, true)
  assert.deepEqual(shown.notices, [{ id: MINUTES_ID, title: 'A社 商談', meetingAt: '2026-11-05T06:00:00.000Z', version: 1 }])
  assert.deepEqual(changed, ['co'])
})

test('a records signal only makes main ask again, for the watched company only', async () => {
  const { checker, seen } = fakeServer({ grant: true })
  // A company watched before (its notices known) is no longer followed after a switch.
  await checker.watch('other-co')
  await checker.watch('co')
  const before = seen.length
  checker.recordsSignal('other-co')
  await settle()
  assert.equal(seen.length, before)
  checker.recordsSignal('co')
  await settle()
  // Asked again (the member's received minutes) — no check of Google, no action on any record.
  assert.deepEqual(paths(seen.slice(before)), ['GET /records/ai-turn'])
})

test('「今は読まない」 runs skip at the notice\'s version, and the deal choice links with the session', async () => {
  const { checker, seen } = fakeServer({ grant: true })
  await checker.watch('co')
  const before = seen.length
  assert.deepEqual(await checker.skip('co', MINUTES_ID), { success: true })
  assert.deepEqual(await checker.linkDeal('co', MINUTES_ID, 'deal-8f3a2c01'), { success: true })
  const sent = seen.slice(before).filter(s => s.method === 'POST')
  assert.deepEqual(sent.map(s => [s.url.replace('https://acb.example.jp/api/companies/co', ''), JSON.parse(s.body!)]), [
    [`/records/item/${MINUTES_ID}/actions/skip`, { expectedVersion: 1 }],
    [`/me/minutes/item/${MINUTES_ID}/deal`, { dealId: 'deal-8f3a2c01' }],
  ])
  assert.ok(sent.every(s => s.headers.Cookie === SESSION && !('Authorization' in s.headers)))
  // An id the server could take as a path is refused before sending.
  assert.equal((await checker.linkDeal('co', '../x', 'deal-8f3a2c01')).success, false)
})

test('the first message names the minutes by id and carries no minutes text; the title and the notice read as designed', () => {
  // As if a caller held the minutes' text: it must never reach the message.
  const held = { id: MINUTES_ID, title: 'A社 商談', meetingAt: '2026-11-05T06:00:00.000Z', text: '見積書を150万円で作り直す' }
  const message = minutesFirstMessage(held)
  assert.ok(message.includes(MINUTES_ID))
  assert.ok(message.includes('minutes_read'))
  assert.ok(!message.includes(held.text))
  const day = `${new Date(held.meetingAt).getMonth() + 1}/${new Date(held.meetingAt).getDate()}`
  assert.equal(minutesConsultationTitle(held), `A社 商談 のあと（${day}）`)
  assert.equal(minutesNoticeText(held), `議事録が届きました：A社 商談 ${day}`)
  assert.throws(() => minutesFirstMessage({ ...held, id: 'task-0a1b2c3d' }))
})

test('the deal choice card: only with no linked deal and not exactly one candidate', () => {
  const ctx = { id: 'card-1', companyId: 'co' }
  const base = { recordId: MINUTES_ID, meeting: { title: 'A社 商談' }, deal: null }
  const two = [{ id: 'deal-aaaaaa01', title: '研修導入' }, { id: 'deal-bbbbbb02', title: '追加導入' }]
  assert.deepEqual(dealChoiceFor({ ...base, candidates: two }, ctx), { id: 'card-1', companyId: 'co', minutesId: MINUTES_ID, meetingTitle: 'A社 商談', candidates: two })
  assert.deepEqual(dealChoiceFor({ ...base, candidates: [] }, ctx)?.candidates, [])
  assert.equal(dealChoiceFor({ ...base, candidates: [two[0]] }, ctx), null)
  assert.equal(dealChoiceFor({ ...base, deal: { id: 'deal-aaaaaa01' }, candidates: two }, ctx), null)
})

test('reading minutes with two candidates puts the card in the reply (the app\'s, not the AI\'s) and tells the AI to wait', async () => {
  const TOKEN = 'acb_rec_co.' + 'a'.repeat(64)
  const fetch = (async (url: string) => {
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json({ token: TOKEN, tokenId: 'tok-1', scope: 'act', expiresAt: 'x' }, 201)
    if (url.endsWith('/api/records-ai/types')) return json({ types: coreTypeDefinitions().filter(t => t.name === 'minutes').map(definition => ({ definition })) })
    if (url.endsWith('/api/records-ai/plugins')) return json({ plugins: [] })
    if (url.includes(`/api/records-ai/minutes/${MINUTES_ID}/text`)) {
      return json({
        recordId: MINUTES_ID, header: '【ここから】', text: '本文', footer: '【ここまで】', truncated: false, docVersion: 'notes:1',
        meeting: { title: 'A社 商談', at: null }, attendees: [], externalAttendees: 1, deal: null,
        candidates: [{ id: 'deal-aaaaaa01', title: '研修導入' }, { id: 'deal-bbbbbb02', title: '追加導入' }], instructionLike: [],
      })
    }
    return json({ ok: true })
  }) as unknown as typeof globalThis.fetch
  const access = await createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch }).openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' })
  const cards: MinutesDealChoiceCard[] = []
  const tools = await createRecordTools(access!, undefined, { companyId: 'co', conversationId: 'conv-1', onDealChoice: c => cards.push(c), newId: () => 'card-1' })
  const out = await tools!.execute('minutes_read', { id: MINUTES_ID })
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].candidates.map(c => c.id), ['deal-aaaaaa01', 'deal-bbbbbb02'])
  assert.match(out, /どの案件の議事録ですか/)
})

test('the cards come back after a restart in the order the tools produced them', () => {
  const choice = { id: 'card-1', companyId: 'co', minutesId: MINUTES_ID, meetingTitle: 'A社 商談', candidates: [] }
  const op = {
    id: 'card-2', companyId: 'co', conversationId: 'conv-1', pluginId: 'hubspot', systemLabel: 'HubSpot', recordId: 'deal-8f3a2c01', recordTitle: null,
    outcome: 'applied', message: 'HubSpot に作りました。', operationId: 'op-1', fields: [], reason: null, byAi: true, undoable: true, at: 't', kind: 'create',
  }
  const stored = uiMessageToSessionMessage({ id: 'm1', role: 'assistant', parts: [
    { type: 'text', text: '読みました。' },
    { type: MINUTES_DEAL_CHOICE_PART_TYPE, id: 'minutes-deal-card-1', data: choice },
    { type: PLUGIN_OPERATION_PART_TYPE, id: 'plugin-op-card-2', data: op },
  ] }, new Date())
  const back = sessionMessageToUIMessage(JSON.parse(JSON.stringify(stored)))
  assert.deepEqual(back.parts.filter(p => p.type.startsWith('data-')).map(p => (p as { id?: string }).id), ['minutes-deal-card-1', 'plugin-op-card-2'])
})
