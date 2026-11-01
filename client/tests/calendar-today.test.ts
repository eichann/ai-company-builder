// 「今日の予定」 in main (electron/features/calendar/ipc.ts, .claude/rules/calendar.md): the
// session stays in main and asks only the member's own route; the renderer gets the server's
// CalendarToday as is (a reason included) or a sentence built from the status, never the
// server's text; a malformed answer is not passed on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCalendarApi } from '../electron/features/calendar/ipc'

const TODAY = {
  date: '2026-11-05', timeZone: 'Asia/Tokyo', reason: null,
  events: [{ id: 'ev1', title: '研修導入のご相談', start: '2026-11-05T05:00:00.000Z', end: '2026-11-05T06:00:00.000Z', allDay: false, online: true, attendeeCount: 3, hasExternalAttendees: true }],
}

function harness(answer: { status: number; body: unknown } | 'offline') {
  const logs: string[] = []
  const requests: Array<{ url: string; method: string; cookie: string | null }> = []
  const api = createCalendarApi({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    log: { warn: (line: string) => logs.push(line) },
    fetch: (async (url: string, init: RequestInit) => {
      if (answer === 'offline') throw new TypeError('fetch failed')
      requests.push({ url, method: String(init.method), cookie: new Headers(init.headers).get('cookie') })
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch,
  })
  return { api, logs, requests }
}

test('today asks the member\'s own route with the session and hands the answer on (a reason too); no title logged', async () => {
  const h = harness({ status: 200, body: { success: true, data: TODAY } })
  assert.deepEqual(await h.api.today('co/1'), { success: true, data: TODAY })
  assert.deepEqual(h.requests, [{ url: 'https://acb.test/api/companies/co%2F1/me/calendar/today', method: 'GET', cookie: 'session=abc' }])
  const empty = { ...TODAY, events: [], reason: 'not-connected' }
  assert.deepEqual(await harness({ status: 200, body: { data: empty } }).api.today('co1'), { success: true, data: empty })
  assert.ok(!h.logs.join('\n').includes('研修'))
})

test('a refusal, a malformed answer or an offline server: a sentence from the status only', async () => {
  const refused = await harness({ status: 500, body: { error: 'SECRET server text' } }).api.today('co1')
  assert.equal(refused.success, false)
  assert.ok(!JSON.stringify(refused).includes('SECRET'))
  const malformed = await harness({ status: 200, body: { data: { ...TODAY, events: [{ title: 'x', email: 'a@b.example' }] } } }).api.today('co1')
  assert.equal(malformed.success, false)
  const offline = await harness('offline').api.today('co1')
  assert.deepEqual(offline, { success: false, offline: true, error: 'サーバーに接続できませんでした。時間をおいてもう一度お試しください。' })
})
