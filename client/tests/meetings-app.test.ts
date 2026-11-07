/**
 * Meetings for their attendees in the app (minutes.md "Meetings for their attendees"): main's reads
 * and presses with the session (electron/features/minutes/meetings.ts) and the card's words.
 *
 * Guards:
 * - an older server without the routes shows no banner and no card buttons (quietly);
 * - 「決めたことN・やることの案N」 counts what the reading made (not the review task, not what was
 *   retracted or archived), and a press goes at the version shown, with the session;
 * - MINUTES_NO_ACCESS says, in plain words, that another attendee can press it;
 * - ［AI に読ませる］ accepted makes main read the AI turn runner's queue again at once;
 * - a malformed id or member never reaches the server's URL or body;
 * - the members-only meeting's 見られる人 is 「参加者のうち ACB の人 N人・招待した人 N人」, and linking a
 *   meeting to a 案件 says who will then see part of it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeetingsApi } from '../electron/features/minutes/meetings'
import { MEETING_NO_ACCESS_TEXT, meetingLinkSentence } from '../shared/minutes-app'
import { meetingSeenWords } from '../shared/record-details'

const SESSION = 'better-auth.session_token=SECRET.sig'
const ID = 'meeting-0a1b2c3d4e5f60718293a4b5'
interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

const summary = (over: Record<string, unknown>) => ({ id: 'x', type: 'task', typeVersion: 1, title: 't', summary: '', path: null, state: 'proposed', fields: {}, version: 1, updatedAt: 't', ...over })
const arrival = (over: Record<string, unknown> = {}) => ({
  recordId: ID, title: '定例', version: 5, meetingAt: '2026-11-04T03:00:00.000Z', status: 'read', attendeeCount: 4,
  by: { memberId: 'u-me', displayName: '阿部' }, byYou: true, series: true, autoSeries: false, ...over,
})

function fakeServer(opts: { arrivals?: 'missing'; readRequest?: { status: number; body: unknown }; google?: unknown } = {}) {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/api/me')) return json({ id: 'u-me' })
    if (url.endsWith('/me/google')) return opts.google === undefined ? new Response('Not Found', { status: 404 }) : json(opts.google)
    if (url.endsWith('/me/minutes/arrivals')) {
      return opts.arrivals === 'missing' ? new Response('Not Found', { status: 404 }) : json({ days: 3, items: [arrival(), arrival({ recordId: 'bad id', status: 'arrived' })] })
    }
    if (url.endsWith('/members/choices')) {
      return json({ maySets: true, groups: [{ id: 'grp-1', name: '採用チーム' }, { id: 7 }], departments: [{ id: 'dep-1', name: '営業部' }], listed: [{ type: 'group', id: 'grp-0', name: '面接官' }, { type: 'x', id: 'y', name: 'z' }] })
    }
    if (url.includes(`/records/item/${ID}`) && (init.method ?? 'GET') === 'GET') {
      return json({
        record: summary({ id: ID, type: 'meeting', state: 'read', version: 5, fields: { summary_text: '要約', meeting_at: '2026-11-04T03:00:00.000Z' } }),
        links: [
          { name: 'meeting', direction: 'in', record: summary({ id: 'task-a1', state: 'proposed' }) },
          { name: 'meeting', direction: 'in', record: summary({ id: 'task-a2', state: 'todo' }) },
          { name: 'meeting', direction: 'in', record: summary({ id: 'task-a3', state: 'cancelled' }) },
          { name: 'meeting', direction: 'in', record: summary({ id: 'task-rv', state: 'todo', fields: { task_kind: 'minutes_review' } }) },
          { name: 'meeting', direction: 'in', record: summary({ id: 'decision-d1', type: 'decision', state: 'unconfirmed', fields: { owner: 'u-me' } }) },
          { name: 'meeting', direction: 'in', record: summary({ id: 'decision-d2', type: 'decision', state: 'retracted' }) },
        ],
        // Decision version 6: who may say 「そうです」 is the server's answer; u-boss (a 責任者) cannot read this meeting.
        decisionChecks: { 'decision-d1': { may: { confirm: true, reject: true, retract: false }, responsible: [], cannotRead: ['u-boss'] } },
      })
    }
    if (url.endsWith('/read-request')) {
      const r = opts.readRequest ?? { status: 200, body: { success: true, data: { recordId: ID, version: 2, state: 'received' } } }
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    if (url.endsWith('/companies/co/members')) return json([{ userId: 'u-boss', name: '阿部', email: 'abe@acb.example.jp' }, { userId: 'u-me', name: '佐藤' }])
    if (url.endsWith('/members')) return json({ added: ['u-2'], addedSets: [{ type: 'group', id: 'grp-1' }, { type: 'role', id: 'admin' }] })
    return json({ recordId: ID, version: 3 })
  }) as unknown as typeof globalThis.fetch
  const asked: string[] = []
  const api = createMeetingsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => [SESSION], fetch, log: { warn: () => {} }, onReadRequested: id => asked.push(id) })
  return { api, seen, asked }
}

test('an older server without the meetings routes: no banner, no buttons on the card', async () => {
  const { api } = fakeServer({ arrivals: 'missing' })
  assert.deepEqual(await api.arrivals('co'), { available: false, items: [] })
  const card = await api.meeting('co', ID)
  assert.equal(card.success, false)
})

test('the card says a Google permission can be renewed only when the server says so, for the 議事録 feature', async () => {
  const flag = async (google?: unknown) => {
    const card = await fakeServer({ google }).api.meeting('co', ID)
    return card.success ? card.renewGoogle : 'failed'
  }
  assert.equal(await flag({ renew: ['minutes'] }), true)
  assert.equal(await flag({ renew: [] }), undefined)
  // An older server, or one that cannot say: the card stays as it was.
  assert.equal(await flag({}), undefined)
  assert.equal(await flag(undefined), undefined)
})

test('a read meeting says what its reading made: proposals and tasks but not the review task or archived ones; decisions not retracted', async () => {
  const { api, seen } = fakeServer()
  const r = await api.arrivals('co')
  assert.equal(r.available, true)
  // A malformed item from the server is left out.
  assert.equal(r.items.length, 1)
  assert.deepEqual(r.items[0].made, { decisions: 1, proposals: 2 })
  assert.ok(seen.every(s => s.headers.Cookie === SESSION))
  // Looked up once per version.
  await api.arrivals('co')
  assert.equal(seen.filter(s => s.url.includes(`/records/item/${ID}`)).length, 1)
})

test('the card of a read meeting: its decisions for the proposals part, ［そうです］ as the server says, a 責任者 who cannot read it by name', async () => {
  const { api } = fakeServer()
  const r = await api.meeting('co', ID)
  assert.ok(r.success)
  assert.equal(r.meeting.status, 'read')
  assert.equal(r.meeting.series, true)
  assert.deepEqual(r.review?.decisions.map(d => [d.id, d.may.confirm, d.cannotRead]), [['decision-d1', true, ['阿部']]])
})

test('［AI に読ませる］ goes at the version shown with the session, and the runner\'s queue is read again at once', async () => {
  const { api, seen, asked } = fakeServer()
  const r = await api.requestReading('co', ID, 1)
  assert.deepEqual(r, { success: true, version: 2 })
  const press = seen.find(s => s.url.endsWith('/read-request'))!
  assert.equal(press.method, 'POST')
  assert.deepEqual(JSON.parse(press.body!), { expectedVersion: 1 })
  assert.deepEqual(asked, ['co'])
})

test('shared minutes whose text Google refused: the server\'s sentence reaches the member, not the 「共有されていません」 one', async () => {
  const error = 'この議事録は共有されていて開けますが、いま ACB に許可している範囲では、Google が文章の取り出しを断りました。'
  const { api } = fakeServer({ readRequest: { status: 403, body: { error, code: 'MINUTES_TEXT_REFUSED' } } })
  assert.deepEqual(await api.requestReading('co', ID, 1), { success: false, error })
})

test('MINUTES_NO_ACCESS: the member is told another attendee can press it; nothing is asked of the runner', async () => {
  const { api, asked } = fakeServer({ readRequest: { status: 403, body: { error: 'x', code: 'MINUTES_NO_ACCESS' } } })
  assert.deepEqual(await api.requestReading('co', ID, 1), { success: false, error: MEETING_NO_ACCESS_TEXT, noAccess: true })
  assert.match(MEETING_NO_ACCESS_TEXT, /ほかの参加者が［AI に読ませる］を押すと/)
  assert.deepEqual(asked, [])
})

test('a malformed meeting id or member never reaches the server', async () => {
  const { api, seen } = fakeServer()
  assert.equal((await api.requestReading('co', '../records/item/x', 1)).success, false)
  assert.equal((await api.skip('co', ID, Number.NaN)).success, false)
  assert.equal((await api.invite('co', ID, ['u-2', 'a/b'], 3)).success, false)
  assert.equal((await api.autoSeries('co', 'meeting-x/../y', true)).success, false)
  assert.equal((await api.invite('co', ID, [], 3)).success, false)
  assert.equal((await api.invite('co', ID, [], 3, [{ type: 'role' as 'group', id: 'admin' }])).success, false)
  assert.equal((await api.invite('co', ID, [], 3, [{ type: 'group', id: '../x' }])).success, false)
  assert.equal((await api.inviteChoices('co', '../x')).success, false)
  assert.equal(seen.length, 0)
  const ok = await api.invite('co', ID, ['u-2', 'u-2'], 3)
  assert.deepEqual(ok, { success: true, added: ['u-2'], addedSets: [{ type: 'group', id: 'grp-1' }] })
  assert.deepEqual(JSON.parse(seen[0].body!), { add: ['u-2'], expectedVersion: 3 })
})

test('［招待する］ with a group and a department: sent in a place rule\'s subject form; the choices are the server\'s, checked field by field', async () => {
  const { api, seen } = fakeServer()
  const r = await api.invite('co', ID, [], 4, [{ type: 'group', id: 'grp-1' }, { type: 'department', id: 'dep-1' }])
  assert.equal(r.success, true)
  assert.deepEqual(JSON.parse(seen[0].body!), {
    add: [{ subjectType: 'group', subjectId: 'grp-1' }, { subjectType: 'department', subjectId: 'dep-1' }], expectedVersion: 4,
  })
  assert.deepEqual(await api.inviteChoices('co', ID), {
    success: true, maySets: true, groups: [{ id: 'grp-1', name: '採用チーム' }], departments: [{ id: 'dep-1', name: '営業部' }],
    listed: [{ type: 'group', id: 'grp-0', name: '面接官' }],
  })
  assert.equal(seen[1].method, 'GET')
  assert.match(seen[1].url, /\/records\/item\/[^/]+\/members\/choices$/)
})

test('見られる人 of a members-only meeting: who attended and who was invited; another place keeps the server\'s phrase', () => {
  assert.equal(meetingSeenWords(4, { kind: 'people', text: '5人が見られます', count: 5 }), '参加者のうち ACB の人 4人・招待した人 1人')
  assert.equal(meetingSeenWords(2, { kind: 'you-and-one', text: 'あなたと鈴木さん', count: 2 }), '参加者のうち ACB の人 2人')
  assert.equal(meetingSeenWords(3, { kind: 'department', text: '営業部のみんな', count: 9 }), '営業部のみんな')
})

test('linking a meeting to a 案件 says first who will see part of it', () => {
  assert.equal(meetingLinkSentence('案件', { kind: 'department', text: '営業部のみんな', count: 8 }), '案件につなぐと、この会議の内容の一部（次のアクションなど）が営業部のみんなに見えます。')
  assert.equal(meetingLinkSentence('案件', { kind: 'people', text: '3人が見られます', count: 3 }), '案件につなぐと、この会議の内容の一部（次のアクションなど）がこの案件を見られる3人に見えます。')
})
