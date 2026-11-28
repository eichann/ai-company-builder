// 「議事録が届きました」 for one meeting (the inbox's row since 2026-11-26) (minutes.md "Meetings for their attendees", design §4-5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MeetingArrivalView } from '../../../shared/minutes-app'
import { invitedText, meetingBanner, meetingNewsOf, mergeMeetingRows, MEETING_CARD_LOAD_FAILED, MEETING_EXPIRES_SOON_MS, nextMeetingCardLoad, offeredSets, readingWords, type MeetingBanner, type MeetingCardLoad } from './model'

const NOW = new Date(2026, 10, 4, 13, 0).getTime()
const item = (over: Partial<MeetingArrivalView> = {}): MeetingArrivalView => ({
  recordId: 'meeting-aaaaaaaa', title: '定例ミーティング', version: 1, meetingAt: new Date(2026, 10, 4, 12, 0).toISOString(),
  status: 'arrived', attendeeCount: 4, by: null, byYou: false, series: false, autoSeries: false, made: null, ...over,
})
const ctx = { closed: false, hidden: false }

test('the inbox\'s meeting row: one stage per meeting, 「読み終わりました」 with what was made, seen only once looked at here', () => {
  const row = (over: Partial<MeetingArrivalView>, closed = false) => {
    const m = item(over)
    return meetingNewsOf(m, meetingBanner(m, ctx), { now: NOW, closed })
  }
  assert.equal(row({})?.stage, 'arrived')
  assert.equal(row({ status: 'asked', byYou: true })?.stage, 'reading')
  assert.deepEqual([row({ status: 'read', made: { decisions: 2, proposals: 3 } })?.line, row({ status: 'read' })?.seen], ['読み終わりました：決めたこと2・やることの案3', false])
  // Looked at on this PC: still a row (findable as seen), never news again.
  assert.equal(row({ status: 'read' }, true)?.seen, true)
  // Another attendee set it aside: said, no buttons; the member's own ［読まない］: gone.
  assert.equal(row({ status: 'skipped', by: { memberId: 'u1', displayName: '阿部' } })?.line, '阿部さんが読まないにしました')
  assert.equal(row({ status: 'skipped', byYou: true, by: { memberId: 'u1', displayName: '阿部' } }), null)
})

test('one meeting is one inbox row: an arrival also in the list\'s turns is merged, a stop of this PC\'s AI wins the look', () => {
  const r = (id: string, stage: 'arrived' | 'reading' | 'stopped' | 'ask', labels: string[]) =>
    ({ id, title: id, stage, line: stage, meetingAt: null, expiresSoon: false, seen: false, actions: labels.map(label => ({ label, run: () => {} })) })
  const rows = mergeMeetingRows([r('m1', 'reading', ['読まない']), r('m2', 'arrived', ['AI に読ませる'])], [r('m1', 'stopped', ['自分で読み取る', '今は読まない', 'もう一度', '読まない']), r('m3', 'ask', ['はい'])])
  // One way to set it aside: the arrival's ［読まない］, never also the list's ［今は読まない］ (independent review).
  assert.deepEqual(rows.map(x => [x.id, x.stage, x.actions.map(a => a.label)]), [
    ['m1', 'stopped', ['読まない', '自分で読み取る', 'もう一度']], ['m2', 'arrived', ['AI に読ませる']], ['m3', 'ask', ['はい']],
  ])
})

test('「あと1日で読めなくなります」 only on a meeting still waiting to be read, from its second day (the server drops it after 3)', () => {
  const at = (ms: number, status: MeetingArrivalView['status'] = 'arrived', byYou = false) => {
    const m = item({ meetingAt: new Date(NOW - ms).toISOString(), status, byYou })
    return meetingNewsOf(m, meetingBanner(m, ctx), { now: NOW, closed: false })?.expiresSoon
  }
  assert.equal(at(MEETING_EXPIRES_SOON_MS - 60_000), false)
  assert.equal(at(MEETING_EXPIRES_SOON_MS), true)
  assert.equal(at(MEETING_EXPIRES_SOON_MS, 'asked', true), true)
  assert.equal(at(MEETING_EXPIRES_SOON_MS, 'reading', true), false)
  assert.equal(at(MEETING_EXPIRES_SOON_MS, 'read'), false)
})

test('an arrived meeting offers ［AI に読ませる］ / ［読まない］ to every attendee, also after a failed reading', () => {
  assert.deepEqual(meetingBanner(item(), ctx), { kind: 'arrived', failedBefore: false })
  assert.deepEqual(meetingBanner(item({ status: 'failed' }), ctx), { kind: 'arrived', failedBefore: true })
})

test('being read: 今回だけ読まない only while it waits for the member\'s own AI; another attendee\'s AI is named', () => {
  assert.deepEqual(meetingBanner(item({ status: 'asked', byYou: true }), ctx), { kind: 'reading', auto: null, reader: null, organiser: false, waiting: true, canSkip: true, canRead: false, problem: null })
  assert.equal((meetingBanner(item({ status: 'reading', byYou: true }), ctx) as { canSkip: boolean }).canSkip, false)
  const other = meetingBanner(item({ status: 'asked', by: { memberId: 'u2', displayName: '鈴木' } }), ctx)
  assert.deepEqual(other, { kind: 'reading', auto: null, reader: '鈴木', organiser: false, waiting: true, canSkip: false, canRead: false, problem: null })
})

test('the member\'s own automatic series says so; this PC\'s AI unable to start says why (never a silent spinner)', () => {
  const auto = meetingBanner(item({ status: 'asked', byYou: true, autoSeries: true, askedAutomatically: true }), ctx)
  assert.equal(readingWords(auto as Extract<MeetingBanner, { kind: 'reading' }>), '自動で読む定例です。AI が読んでいます…')
  const stuck = meetingBanner(item({ status: 'asked', byYou: true }), { ...ctx, ai: { recordId: 'meeting-aaaaaaaa', state: 'not-allowed', reason: 'Claude Code が必要です', canRetry: true, canHand: true } })
  assert.deepEqual((stuck as { problem: unknown }).problem, { reason: 'Claude Code が必要です', canRetry: true })
})

test('another attendee\'s AI that has not started says it will read (their PC may be closed), not that it reads', () => {
  const reading = (over: Partial<MeetingArrivalView>) => readingWords(meetingBanner(item(over), ctx) as Extract<MeetingBanner, { kind: 'reading' }>)
  const suzuki = { memberId: 'u2', displayName: '鈴木' }
  assert.equal(reading({ status: 'asked', by: suzuki, askedAutomatically: true }), '鈴木さんの AI が読む予定です。しばらく読まれないときは、出ている人の AI が代わりに読みます')
  assert.equal(reading({ status: 'reading', by: suzuki }), '鈴木さんの AI が読んでいます…')
})

test('only the clock\'s ask for another attendee, not started, offers ［AI に読ませる］: never another\'s press, a started reading or an older server', () => {
  const suzuki = { memberId: 'u2', displayName: '鈴木' }
  const canRead = (over: Partial<MeetingArrivalView>) => (meetingBanner(item(over), ctx) as { canRead: boolean }).canRead
  assert.equal(canRead({ status: 'asked', by: suzuki, askedAutomatically: true }), true)
  assert.equal(canRead({ status: 'asked', by: suzuki }), false)
  assert.equal(canRead({ status: 'reading', by: suzuki, askedAutomatically: true }), false)
  assert.equal(canRead({ status: 'asked', byYou: true, askedAutomatically: true }), false)
})

test('the planned reader who organised the meeting is named 「（主催）」; an older server\'s answer names no one so', () => {
  const reading = (over: Partial<MeetingArrivalView>) => readingWords(meetingBanner(item(over), ctx) as Extract<MeetingBanner, { kind: 'reading' }>)
  const suzuki = { memberId: 'u2', displayName: '鈴木' }
  assert.equal(reading({ status: 'asked', by: suzuki, askedAutomatically: true, byOrganiser: true }), '鈴木さん（主催）の AI が読む予定です。しばらく読まれないときは、出ている人の AI が代わりに読みます')
  assert.equal(reading({ status: 'asked', by: suzuki, askedAutomatically: true }), '鈴木さんの AI が読む予定です。しばらく読まれないときは、出ている人の AI が代わりに読みます')
})

test('a meeting the member\'s own setting asked says so, and still offers 今回だけ読まない; a press says nothing of a setting', () => {
  const bySetting = meetingBanner(item({ status: 'asked', byYou: true, askedAutomatically: true }), ctx) as Extract<MeetingBanner, { kind: 'reading' }>
  assert.equal(readingWords(bySetting), '自動で読む設定のため、AI が読んでいます…')
  assert.equal(bySetting.canSkip, true)
  assert.equal(readingWords(meetingBanner(item({ status: 'asked', byYou: true }), ctx) as Extract<MeetingBanner, { kind: 'reading' }>), 'AI が読んでいます…')
})

test('read: shown until the member closes it; ［読まない］: gone for who chose it, said to the others', () => {
  assert.deepEqual(meetingBanner(item({ status: 'read' }), ctx), { kind: 'read' })
  assert.equal(meetingBanner(item({ status: 'read' }), { ...ctx, closed: true }), null)
  assert.equal(meetingBanner(item({ status: 'skipped', byYou: true, by: { memberId: 'u1', displayName: '阿部' } }), ctx), null)
  assert.deepEqual(meetingBanner(item({ status: 'skipped', by: { memberId: 'u1', displayName: '阿部' } }), ctx), { kind: 'skipped', by: '阿部' })
  assert.equal(meetingBanner(item(), { ...ctx, hidden: true }), null)
})

test('［招待する］: groups and departments only when the server says the member may add them, never one already on the list', () => {
  const choices = {
    success: true as const, maySets: true,
    groups: [{ id: 'g1', name: '採用チーム' }, { id: 'g2', name: '面接官' }], departments: [{ id: 'd1', name: '営業部' }],
    listed: [{ type: 'group' as const, id: 'g2', name: '面接官' }],
  }
  assert.deepEqual(offeredSets(choices), [
    { type: 'group', id: 'g1', label: '「採用チーム」の人' }, { type: 'department', id: 'd1', label: '営業部に所属する人' },
  ])
  assert.deepEqual(offeredSets({ ...choices, maySets: false }), [])
  assert.deepEqual(offeredSets(null), [])
  const members = [{ id: 'u-1', name: '有田' }]
  assert.equal(invitedText(['u-1'], [{ type: 'group', id: 'g1' }, { type: 'department', id: 'd1' }], members, choices), '有田さん、「採用チーム」の人、営業部に所属する人を招待しました。')
  assert.equal(invitedText([], [], members, choices), '選んだ人は、もうこの会議を見られます。')
})

test('the card\'s load: a failure is said (never an empty card), 「使えない」 apart from it, and reading again keeps what was shown', () => {
  const loading: MeetingCardLoad = { kind: 'loading' }
  const ok = { success: true as const, meeting: { ...item(), made: null }, review: null }
  // A first read that fails says why (main's words, or ours when main never answered) — the card offers ［もう一度］.
  assert.deepEqual(nextMeetingCardLoad(loading, { success: false, error: 'オフラインです' }), { kind: 'failed', error: 'オフラインです' })
  assert.deepEqual(nextMeetingCardLoad(loading, 'threw'), { kind: 'failed', error: MEETING_CARD_LOAD_FAILED })
  // main's empty error = an older server / records off: not a failure to retry.
  assert.deepEqual(nextMeetingCardLoad(loading, { success: false, error: '' }), { kind: 'unavailable' })
  const ready = nextMeetingCardLoad(loading, ok)
  assert.deepEqual(ready, { kind: 'ready', state: ok, refreshFailed: null })
  // Reading again fails: the meeting and its buttons stay, with why.
  const kept = nextMeetingCardLoad(ready, 'threw')
  assert.equal(kept.kind === 'ready' && kept.state, ok)
  assert.equal(kept.kind === 'ready' && kept.refreshFailed, MEETING_CARD_LOAD_FAILED)
  // ［もう一度］ that works clears the line; a failed first read recovers the same way.
  assert.deepEqual(nextMeetingCardLoad(kept, ok), { kind: 'ready', state: ok, refreshFailed: null })
  assert.equal(nextMeetingCardLoad({ kind: 'failed', error: 'x' }, ok).kind, 'ready')
})
