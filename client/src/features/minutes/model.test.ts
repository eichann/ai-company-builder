// The banner 「議事録が届きました」 for one meeting (minutes.md "Meetings for their attendees", design §4-5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MeetingArrivalView } from '../../../shared/minutes-app'
import { madeWords, meetingBanner, meetingPeopleWords, meetingWhen } from './model'

const NOW = new Date(2026, 10, 4, 13, 0).getTime()
const item = (over: Partial<MeetingArrivalView> = {}): MeetingArrivalView => ({
  recordId: 'meeting-aaaaaaaa', title: '定例ミーティング', version: 1, meetingAt: new Date(2026, 10, 4, 12, 0).toISOString(),
  status: 'arrived', attendeeCount: 4, by: null, byYou: false, series: false, autoSeries: false, made: null, ...over,
})
const ctx = { closed: false, hidden: false }

test('when and how many, in the member\'s words', () => {
  assert.equal(meetingPeopleWords(item(), NOW), '今日 12:00・4人')
  assert.equal(meetingWhen(new Date(2026, 10, 3, 15, 0).toISOString(), NOW), '昨日 15:00')
  assert.equal(meetingWhen(new Date(2026, 10, 2, 9, 5).toISOString(), NOW), '11/2 9:05')
  assert.equal(madeWords({ decisions: 2, proposals: 3 }), '決めたこと2・やることの案3')
})

test('an arrived meeting offers ［AI に読ませる］ / ［読まない］ to every attendee, also after a failed reading', () => {
  assert.deepEqual(meetingBanner(item(), ctx), { kind: 'arrived', failedBefore: false })
  assert.deepEqual(meetingBanner(item({ status: 'failed' }), ctx), { kind: 'arrived', failedBefore: true })
})

test('being read: 今回だけ読まない only while it waits for the member\'s own AI; another attendee\'s AI is named', () => {
  assert.deepEqual(meetingBanner(item({ status: 'asked', byYou: true }), ctx), { kind: 'reading', auto: false, reader: null, canSkip: true, problem: null })
  assert.equal((meetingBanner(item({ status: 'reading', byYou: true }), ctx) as { canSkip: boolean }).canSkip, false)
  const other = meetingBanner(item({ status: 'asked', by: { memberId: 'u2', displayName: '鈴木' } }), ctx)
  assert.deepEqual(other, { kind: 'reading', auto: false, reader: '鈴木', canSkip: false, problem: null })
})

test('the member\'s own automatic series says so; this PC\'s AI unable to start says why (never a silent spinner)', () => {
  const auto = meetingBanner(item({ status: 'asked', byYou: true, autoSeries: true }), ctx)
  assert.equal((auto as { auto: boolean }).auto, true)
  const stuck = meetingBanner(item({ status: 'asked', byYou: true }), { ...ctx, ai: { recordId: 'meeting-aaaaaaaa', state: 'not-allowed', reason: 'Claude Code が必要です', canRetry: true, canHand: true } })
  assert.deepEqual((stuck as { problem: unknown }).problem, { reason: 'Claude Code が必要です', canRetry: true })
})

test('read: shown until the member closes it; ［読まない］: gone for who chose it, said to the others', () => {
  assert.deepEqual(meetingBanner(item({ status: 'read' }), ctx), { kind: 'read' })
  assert.equal(meetingBanner(item({ status: 'read' }), { ...ctx, closed: true }), null)
  assert.equal(meetingBanner(item({ status: 'skipped', byYou: true, by: { memberId: 'u1', displayName: '阿部' } }), ctx), null)
  assert.deepEqual(meetingBanner(item({ status: 'skipped', by: { memberId: 'u1', displayName: '阿部' } }), ctx), { kind: 'skipped', by: '阿部' })
  assert.equal(meetingBanner(item(), { ...ctx, hidden: true }), null)
})
