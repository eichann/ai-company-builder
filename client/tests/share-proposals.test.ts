// 「部署に出す」 as the AI's proposal, the member's press (owner decision 2026-11-27, PR D; records.md "Owner-only records").
// Guards:
// - the AI's tool shares nothing: it only reads the task with the turn's token and draws the card; it is offered only in a
//   turn the member started, only for a やること seen by the member alone, only for a department folder;
// - after a renewal of the turn's token (the member's-turn mark gone) it answers the fixed words;
// - the card's press reads the task again with the member's session and shares it at the version read now through the
//   app's own tasks:share; a task no longer 「あなただけ」 is never shared again; a refusal is shown in the server's words;
// - the card survives a save and a restart (stored as `shareProposals`, read strictly).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { readShareProposalCard, shareFolderOf, SHARE_PROPOSAL_PART_TYPE, type ShareProposalCardRef } from '../shared/share-proposals'
import { pressShareProposal, type ShareProposalPort } from '../src/features/chat/api'
import { sessionMessageToUIMessage, uiMessageToSessionMessage } from '../src/features/chat/chatSessionMessages'

const TASK = 'task-0123456789abcdef'
const types = coreTypeDefinitions().filter(d => d.name === 'task')

async function turn(opts: { memberTurn?: boolean; bound?: boolean; record?: Record<string, unknown>; expired?: boolean; expiresOnRead?: boolean } = {}) {
  const seen: Array<{ url: string; method: string }> = []
  const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
  let issued = 0
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET' })
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    if (url.endsWith('/me/record-tokens')) {
      issued += 1
      return json(201, { token: `acb_rec_co.${String(issued).repeat(64).slice(0, 64)}`, tokenId: `tok-${issued}`, scope: 'act', expiresAt: issued === 1 && opts.expired ? '2000-01-01T00:00:00.000Z' : '2999-01-01T00:00:00.000Z', memberTurn: body?.memberTurn === true && !body?.run })
    }
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: types.map(definition => ({ definition })) })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { plugins: [] })
    if (url.endsWith('/api/records-ai/my-turn') && opts.expired && issued === 1) return new Response(JSON.stringify({ error: 'Unauthorized', code: 'RECORD_TOKEN_INVALID' }), { status: 401 })
    if (url.endsWith(`/api/records-ai/item/${TASK}`) && opts.expiresOnRead && issued === 1) return new Response(JSON.stringify({ error: 'Unauthorized', code: 'RECORD_TOKEN_INVALID' }), { status: 401 })
    if (url.endsWith(`/api/records-ai/item/${TASK}`)) return json(200, { record: { id: TASK, type: 'task', title: '見積を直す', personal: true, ...opts.record } })
    return json(200, {})
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch, retryDelayMs: 0, runOf: () => (opts.bound ? { id: 'run-1', generation: 1 } : null) })
  const access = (await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act', renewExpired: true, ...(opts.memberTurn ? { memberTurn: true } : {}) }))!
  const cards: ShareProposalCardRef[] = []
  let n = 0
  const tools = await createRecordTools(access, undefined, { companyId: 'co', conversationId: 'conv-1', newId: () => `card-${++n}`, onShareProposal: c => cards.push(c) })
  return { tools, cards, seen, access }
}

test('the AI only proposes: a card for the member\'s own 「あなただけ」 やること, in a turn they started — nothing is written', async () => {
  const t = await turn({ memberTurn: true })
  const answer = JSON.parse(await t.tools.execute('records_propose_share', { id: TASK, folder: '営業部' })) as { proposed?: boolean; shown?: string }
  assert.equal(answer.proposed, true)
  assert.match(answer.shown!, /まだ出していません/)
  assert.deepEqual(t.cards.map(c => [c.recordId, c.title, c.folder, c.companyId]), [[TASK, '見積を直す', '営業部', 'co']])
  // Nothing but reads reached the server (the share is the member's press through their session, never this token).
  assert.deepEqual(t.seen.filter(s => s.method !== 'GET' && !s.url.includes('/me/record-tokens')), [])
  // Never offered outside a member's turn (a plain or run-bound token).
  for (const other of [await turn(), await turn({ memberTurn: true, bound: true })]) {
    assert.ok(!other.tools.specs.some(s => s.name === 'records_propose_share'))
  }
})

test('never for a task others already see, nor another kind of record, nor a folder that is no department path', async () => {
  const shared = await turn({ memberTurn: true, record: { personal: undefined } })
  assert.equal((JSON.parse(await shared.tools.execute('records_propose_share', { id: TASK, folder: '営業部' })) as { code?: string }).code, 'NOT_PERSONAL')
  assert.equal(shared.cards.length, 0)
  const other = await turn({ memberTurn: true, record: { type: 'project' } })
  assert.equal((JSON.parse(await other.tools.execute('records_propose_share', { id: TASK, folder: '営業部' })) as { code?: string }).code, 'NOT_A_TASK')
  const t = await turn({ memberTurn: true })
  for (const folder of ['../営業部', '/Users/x', '営業部/.personal/inbox', 'https://x']) {
    assert.equal((JSON.parse(await t.tools.execute('records_propose_share', { id: TASK, folder })) as { code?: string }).code, 'BAD_FOLDER', folder)
  }
  assert.equal(t.cards.length, 0)
  assert.equal(shareFolderOf('営業部/'), '営業部')
})

test('after the turn\'s token was issued again (the member\'s-turn mark gone), the tool answers the fixed words', async () => {
  const t = await turn({ memberTurn: true, expired: true })
  await t.access.call('GET', '/my-turn')
  assert.equal(t.access.memberTurn, false)
  assert.equal((JSON.parse(await t.tools.execute('records_propose_share', { id: TASK, folder: '営業部' })) as { code?: string }).code, 'TURN_RENEWED')
  assert.equal(t.cards.length, 0)
  // The tool's own read renews it (codex review): checked again after the read, still no card.
  const during = await turn({ memberTurn: true, expired: true, expiresOnRead: true })
  assert.equal((JSON.parse(await during.tools.execute('records_propose_share', { id: TASK, folder: '営業部' })) as { code?: string }).code, 'TURN_RENEWED')
  assert.equal(during.access.memberTurn, false)
  assert.equal(during.cards.length, 0)
})

const CARD: ShareProposalCardRef = { id: 'card-1', companyId: 'co', conversationId: 'conv-1', recordId: TASK, title: '見積を直す', folder: '営業部', at: '2026-11-27T00:00:00.000Z' }

function port(state: { personal: boolean; version: number; notFound?: boolean; refusal?: { code: string; error: string } }) {
  const shared: Array<[string, string, string, number]> = []
  const p = {
    getRecordCard: async () => state.notFound
      ? { success: false as const, offline: false, notFound: true, error: 'ない' }
      : { success: true as const, card: { version: state.version, record: { personal: state.personal ? true : undefined } } },
    shareTask: async (companyId: string, recordId: string, folder: string, version: number) => {
      shared.push([companyId, recordId, folder, version])
      return state.refusal ? { success: false as const, offline: false, code: state.refusal.code, error: state.refusal.error } : { success: true as const, recordId }
    },
  } as unknown as ShareProposalPort
  return { p, shared }
}

test('the member\'s press shares at the version read now; a task no longer 「あなただけ」 is never shared again; refusals in the server\'s words', async () => {
  const ok = port({ personal: true, version: 7 })
  assert.deepEqual(await pressShareProposal(CARD, ok.p), { kind: 'done' })
  assert.deepEqual(ok.shared, [['co', TASK, '営業部', 7]])
  const already = port({ personal: false, version: 8 })
  assert.deepEqual(await pressShareProposal(CARD, already.p), { kind: 'already' })
  assert.deepEqual(already.shared, [])
  const raced = port({ personal: true, version: 7, refusal: { code: 'NOT_PERSONAL', error: 'x' } })
  assert.deepEqual(await pressShareProposal(CARD, raced.p), { kind: 'already' })
  const refused = port({ personal: true, version: 7, refusal: { code: 'FOLDER_NOT_PLACEABLE', error: 'その場所には置けません' } })
  assert.deepEqual(await pressShareProposal(CARD, refused.p), { kind: 'error', text: 'その場所には置けません' })
  assert.deepEqual(await pressShareProposal(CARD, port({ personal: true, version: 1, notFound: true }).p), { kind: 'gone' })
})

test('the card is kept with the reply and read back strictly', () => {
  const stored = uiMessageToSessionMessage({ id: 'a1', role: 'assistant', parts: [
    { type: 'text', text: 'カードから出せます。' }, { type: SHARE_PROPOSAL_PART_TYPE, id: 'share-proposal-card-1', data: CARD },
  ] } as never, new Date())
  assert.deepEqual(stored.shareProposals, [CARD])
  const restored = sessionMessageToUIMessage(stored)
  assert.ok(restored.parts.some(p => p.type === SHARE_PROPOSAL_PART_TYPE && JSON.stringify((p as { data?: unknown }).data) === JSON.stringify(CARD)))
  for (const bad of [{ ...CARD, recordId: 'project-0123456789ab' }, { ...CARD, folder: '../x' }, { ...CARD, title: '' }]) assert.equal(readShareProposalCard(bad), undefined)
})
