// The automatic 「AI の番」 runner's rules (ai-turns.md): what may start, in which order, and
// when it stops. Each test names the promise it protects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AUTO_TURN_SETTINGS, readAutoTurnSettings } from '../../../shared/ai-turns'
import {
  AI_TURN_PASS_CAP, AI_TURN_PASS_INTERVAL_MS, MAX_ATTEMPTS_PER_RECORD, freshLog, logForToday, nextAiTurn, orderAiTurns,
  FAILED_REASON, URGENT_WITHIN_MS, aiTurnItems, askedAgain, handUrgent, handedOver, recordOutcome, recordStarted, resumed, retried, usagePauseUntil, type AiTurnDecisionInput,
  canResumeAiTurns, retitledConsultation, usagePause, usagePauseLifted,
} from './aiTurns'
import type { AiTurnCandidate } from '../../../shared/ai-turn-steps/types'

// 「自動で進める」 on (the company default); the tests below never rely on it implicitly.
const ON = { ...DEFAULT_AUTO_TURN_SETTINGS, enabled: true }
const NOW = Date.parse('2026-11-01T10:00:00+09:00')
const minutes = (id: string, meetingAt: string, extra: Partial<AiTurnCandidate> = {}): AiTurnCandidate =>
  ({ id, title: id, version: 1, meetingAt, ...extra })
const A = minutes('minutes-aaaaaaaa', '2026-10-31T10:00:00Z')
const B = minutes('minutes-bbbbbbbb', '2026-10-30T10:00:00Z')

const input = (over: Partial<AiTurnDecisionInput> = {}): AiTurnDecisionInput => ({
  settings: ON, agent: 'claude-code', agentReady: true, busy: false,
  log: freshLog(NOW), queue: [A, B], pass: null, now: NOW, ...over,
})

test('the company setting off: nothing starts', () => {
  assert.deepEqual(nextAiTurn(input({ settings: { ...ON, enabled: false } })), { wait: 'off' })
  // Settings not known yet count as off (never run on a guess).
  assert.deepEqual(nextAiTurn(input({ settings: null })), { wait: 'off' })
})

// Meetings for their attendees (minutes.md): ［AI に読ませる］ is the member's own start, so the meeting
// they asked for runs while 「自動で進める」 is off — and nothing else does. Settings unknown still runs nothing.
test('the setting off: a meeting the member asked to be read still starts, nothing else', () => {
  const asked = { ...A, asked: true as const }
  const off = { ...ON, enabled: false }
  assert.deepEqual(nextAiTurn(input({ settings: off, queue: [asked, B] })), { run: asked })
  assert.deepEqual(nextAiTurn(input({ settings: null, queue: [asked] })), { wait: 'off' })
  const items = aiTurnItems({ queue: [asked, B], log: freshLog(NOW), wait: 'busy', noticeText: null, running: null, autoOff: true })
  assert.equal(items.find(i => i.recordId === B.id)?.state, 'not-allowed')
  assert.equal(items.find(i => i.recordId === asked.id)?.state, 'waiting')
})

test('Codex (or the API key) never starts an AI turn: the member is told it needs Claude', () => {
  assert.deepEqual(nextAiTurn(input({ agent: 'codex' })), { wait: 'needs-claude' })
  assert.deepEqual(nextAiTurn(input({ agent: 'api-key' })), { wait: 'needs-claude' })
  assert.deepEqual(nextAiTurn(input({ agentReady: false })), { wait: 'not-ready' })
})

test('earliest due first; without a due date the oldest meeting first', () => {
  assert.deepEqual(nextAiTurn(input()), { run: B })
  const due = minutes('minutes-cccccccc', '2026-10-31T12:00:00Z', { dueAt: '2026-11-02T00:00:00Z' })
  assert.deepEqual(orderAiTurns([A, B, due]).map(c => c.id), [due.id, B.id, A.id])
})

test('one at a time, and at most a few per pass until the next pass', () => {
  assert.deepEqual(nextAiTurn(input({ busy: true })), { wait: 'busy' })
  const full = { startedAt: NOW - 1000, started: AI_TURN_PASS_CAP }
  assert.deepEqual(nextAiTurn(input({ pass: full })), { wait: 'pass-cap' })
  assert.deepEqual(nextAiTurn(input({ pass: full, now: NOW - 1000 + AI_TURN_PASS_INTERVAL_MS })), { run: B })
})

test('the daily limit stops automatic runs for the day; a new day counts again', () => {
  const settings = { ...ON, dailyLimit: 2 }
  let log = freshLog(NOW)
  log = recordStarted(recordStarted(log, A.id), B.id)
  assert.deepEqual(nextAiTurn(input({ settings, log, queue: [minutes('minutes-dddddddd', '2026-10-29T00:00:00Z')] })), { wait: 'daily-limit' })
  const tomorrow = NOW + 24 * 3600_000
  assert.equal(logForToday(log, tomorrow).runs, 0)
})

test('a record is tried at most twice a day (no endless retries of the same minutes)', () => {
  let log = freshLog(NOW)
  for (let i = 0; i < MAX_ATTEMPTS_PER_RECORD; i++) log = recordStarted(log, B.id)
  assert.deepEqual(nextAiTurn(input({ log })), { run: A })
  assert.deepEqual(nextAiTurn(input({ log, queue: [B] })), { wait: 'empty' })
})

test('N failures in a row stop until the member resumes; a success in between resets the count', () => {
  const settings = { ...ON, stopAfterFailures: 2 }
  let log = recordOutcome(freshLog(NOW), 'minutes-x1x1x1x1', 'failed', settings, null)
  log = recordOutcome(log, 'minutes-x2x2x2x2', 'done', settings, null)
  log = recordOutcome(log, 'minutes-x3x3x3x3', 'unfinished', settings, null)
  assert.deepEqual(nextAiTurn(input({ settings, log })), { run: B })
  log = recordOutcome(log, 'minutes-x4x4x4x4', 'failed', settings, null)
  assert.deepEqual(nextAiTurn(input({ settings, log })), { wait: 'stopped' })
  // A stop is kept across a reload and a new day; only the member's resume clears it.
  assert.equal(logForToday(JSON.parse(JSON.stringify(log)), NOW + 24 * 3600_000).stopped, true)
  assert.deepEqual(nextAiTurn(input({ settings, log: resumed(log) })), { run: B })
})

test("Claude's usage limit pauses (not a failure) until the window resets", () => {
  const resetsAt = NOW + 38 * 60_000
  const snapshot = { provider: 'claude-code' as const, status: 'rejected' as const, updatedAt: NOW,
    windows: [{ id: 'five_hour', label: '5時間', usedPercent: 100, resetsAt }, { id: 'seven_day', label: '1週間', usedPercent: 60, resetsAt: NOW + 3 * 86_400_000 }] }
  const until = usagePauseUntil(snapshot, NOW)
  assert.equal(until, resetsAt)
  const log = recordOutcome(freshLog(NOW), B.id, 'usage-limit', ON, usagePause(snapshot, NOW))
  assert.equal(log.pausedUntil, until)
  assert.equal(log.failuresInARow, 0)
  assert.equal(log.handed[B.id], undefined)
  assert.deepEqual(nextAiTurn(input({ log })), { wait: 'paused-usage' })
  assert.deepEqual(nextAiTurn(input({ log, now: resetsAt + 1 })), { run: B })
  assert.ok(usagePauseUntil(undefined, NOW) > NOW)
})

// Owner report 2026-11-05: signed in again with another Claude account, the pause and its notice stayed until 20:00.
test("Claude's usage pause: the member can resume it, and it lifts when Claude says there is room again — never on an older snapshot", () => {
  const rejected = { provider: 'claude-code' as const, status: 'rejected' as const, updatedAt: NOW,
    windows: [{ id: 'five_hour', label: '5時間', usedPercent: 100, resetsAt: NOW + 3 * 3600_000 }] }
  const paused = recordOutcome(freshLog(NOW), B.id, 'usage-limit', ON, usagePause(rejected, NOW))
  // ［もう一度自動で進める］ is offered for the pause as for a stop, and pressing it runs again.
  assert.equal(canResumeAiTurns('paused-usage'), true)
  assert.equal(canResumeAiTurns('daily-limit'), false)
  assert.deepEqual(nextAiTurn(input({ log: resumed(paused) })), { run: B })
  // The snapshot that paused, or an older one (main's cache after a reload), keeps it.
  assert.equal(usagePauseLifted(paused, rejected), paused)
  assert.equal(usagePauseLifted(paused, { ...rejected, status: 'allowed', updatedAt: NOW - 1 }), paused)
  assert.equal(usagePauseLifted(paused, { ...rejected, updatedAt: NOW + 60_000 }), paused)
  // A newer one that is not rejected (another account's turn) lifts it; so does a change of AI or sign-in.
  for (const lifted of [usagePauseLifted(paused, { ...rejected, status: 'allowed', updatedAt: NOW + 60_000 }), usagePauseLifted(paused, rejected, true)]) {
    assert.equal(lifted.pausedUntil, null)
    assert.deepEqual(nextAiTurn(input({ log: lifted })), { run: B })
  }
  // A pause kept across a reload keeps its time; one from an older build (no time) is lifted only by a change or the button.
  assert.equal(logForToday(JSON.parse(JSON.stringify(paused)), NOW).pauseSeenAt, NOW)
  const old = { ...paused, pauseSeenAt: null }
  assert.equal(usagePauseLifted(old, { ...rejected, status: 'allowed', updatedAt: NOW + 60_000 }), old)
})

// Owner FB 2026-11-05: a Slack message without a subject kept 来た連絡「（件名なし）」の判断 after the AI named it.
test('the hidden consultation follows the name the run gave its record, never over a name the member chose', () => {
  const given = '来た連絡「（件名なし）」の判断'
  const renamed = '来た連絡「見積書の送付のお願い」の判断'
  assert.equal(retitledConsultation({ given, current: given, renamed }), renamed)
  // The member renamed it: theirs. Not saved yet, or the record kept its title: nothing to do.
  assert.equal(retitledConsultation({ given, current: '見積もりの件', renamed }), null)
  assert.equal(retitledConsultation({ given, current: undefined, renamed }), null)
  assert.equal(retitledConsultation({ given, current: given, renamed: given }), null)
})

test('settings from a server: unusable values fall back to the defaults, never to "unlimited"; unreadable means off', () => {
  assert.equal(readAutoTurnSettings(undefined).enabled, false)
  assert.equal(readAutoTurnSettings({ enabled: 'yes' }).enabled, false)
  assert.deepEqual(readAutoTurnSettings({ enabled: false, dailyLimit: -1, stopAfterFailures: 'x' }),
    { enabled: false, dailyLimit: DEFAULT_AUTO_TURN_SETTINGS.dailyLimit, stopAfterFailures: DEFAULT_AUTO_TURN_SETTINGS.stopAfterFailures })
  assert.equal(readAutoTurnSettings({ dailyLimit: 1e9 }).dailyLimit, DEFAULT_AUTO_TURN_SETTINGS.dailyLimit)
})

test('a failed run is handed to the person at once with the reason, never left silently in 「AI の番」; 「もう一度」 gives it back', () => {
  let log = recordStarted(freshLog(NOW), B.id)
  log = recordOutcome(log, B.id, 'failed', ON, null)
  assert.deepEqual(nextAiTurn(input({ log })), { run: A })
  const [b] = aiTurnItems({ queue: [B], log, wait: 'busy', noticeText: null, running: null })
  assert.deepEqual(b, { recordId: B.id, state: 'failed', reason: FAILED_REASON, canRetry: true, canHand: false })
  // Kept across a reload and a new day until the member decides.
  assert.ok(logForToday(JSON.parse(JSON.stringify(log)), NOW + 86_400_000).handed[B.id])
  log = retried(log, B.id)
  assert.deepEqual(nextAiTurn(input({ log })), { run: B })
})

test('every waiting record has a state and a reason; anything stopped offers 「もう一度」 and 「人に渡す」', () => {
  const log = freshLog(NOW)
  const items = (over: Partial<Parameters<typeof aiTurnItems>[0]>) => aiTurnItems({ queue: [A, B], log, wait: 'busy', noticeText: '理由', running: null, ...over })
  assert.deepEqual(items({ running: { id: B.id, needsYou: false } }).map(i => i.state), ['running', 'waiting'])
  for (const wait of ['needs-claude', 'not-ready'] as const) {
    for (const item of items({ wait })) assert.deepEqual([item.state, item.reason, item.canRetry, item.canHand], ['not-allowed', '理由', true, true])
  }
  for (const wait of ['paused-usage', 'stopped', 'daily-limit'] as const) {
    for (const item of items({ wait })) assert.deepEqual([item.state, item.reason, item.canRetry, item.canHand], ['waiting', '理由', true, true])
  }
  for (const item of items({})) assert.ok(item.reason.length > 0, 'a waiting record says why')
  // The AI waits for the member's answer (lacking information): handed early, with the reason.
  const [, asked] = items({ running: { id: A.id, needsYou: true } })
  assert.equal(asked.state, 'handed')
  assert.match(asked.reason, /答えを待っています/)
})

test('「人に渡す」 keeps the AI off the record, with why it stopped', () => {
  const log = handedOver(freshLog(NOW), B.id, 'Claude の利用上限に達したため…')
  assert.deepEqual(nextAiTurn(input({ log })), { run: A })
  const [item] = aiTurnItems({ queue: [B], log, wait: 'busy', noticeText: null, running: null })
  assert.equal(item.state, 'handed')
  assert.match(item.reason, /利用上限/)
})

test('a record due soon goes to the person early instead of waiting for the AI', () => {
  const soon = minutes('minutes-eeeeeeee', '2026-10-30T00:00:00Z', { dueAt: new Date(NOW + URGENT_WITHIN_MS - 60_000).toISOString() })
  const later = minutes('minutes-ffffffff', '2026-10-30T00:00:00Z', { dueAt: new Date(NOW + URGENT_WITHIN_MS + 60_000).toISOString() })
  const log = handUrgent(freshLog(NOW), [soon, later], null, NOW)
  assert.equal(log.handed[soon.id]?.kind, 'urgent')
  assert.equal(log.handed[later.id], undefined)
  assert.deepEqual(nextAiTurn(input({ log, queue: [soon, later] })), { run: later })
  // The one the AI already works on is not taken away from it.
  assert.equal(handUrgent(freshLog(NOW), [soon], soon.id, NOW).handed[soon.id], undefined)
})

test('a meeting asked for again after the AI could not read it runs again; a hand-off is otherwise kept', () => {
  const at = (version: number) => [{ ...B, version }]
  const failed = recordOutcome(recordStarted(recordStarted(freshLog(NOW), B.id), B.id), B.id, 'failed', ON, null, 3)
  // The queue not read again since the run: still the failure.
  assert.deepEqual(askedAgain(failed, at(3)), [])
  // ［AI に読ませる］ moved it back at a newer version: the hand-off and today's attempts no longer hold it.
  assert.deepEqual(askedAgain(failed, at(7)), [B.id])
  assert.deepEqual(nextAiTurn(input({ log: failed, queue: at(7) })), { wait: 'empty' })
  assert.equal(('run' in nextAiTurn(input({ log: retried(failed, B.id), queue: at(7) }))), true)
  // Stopped unfinished, handed by the member, due soon: the record never left, only 「もう一度」 brings it back.
  assert.deepEqual(askedAgain(recordOutcome(freshLog(NOW), B.id, 'unfinished', ON, null, 3), at(7)), [])
  assert.deepEqual(askedAgain(handedOver(freshLog(NOW), B.id, ''), at(7)), [])
})

test('a hand-off an older build kept (no version, its old words) counts as asked again and no longer says the AI judged', () => {
  const stored = { ...freshLog(NOW), handed: { [B.id]: { kind: 'failed', reason: 'AI が「読み取れない」と判断しました。理由は「AIへの相談」に残っています。' } } }
  const log = logForToday(JSON.parse(JSON.stringify(stored)), NOW)
  assert.equal(log.handed[B.id].reason, FAILED_REASON)
  assert.deepEqual(askedAgain(log, [B]), [B.id])
  // A kept version survives the daily read of the log.
  assert.equal(logForToday(recordOutcome(freshLog(NOW), B.id, 'failed', ON, null, 3), NOW).handed[B.id].version, 3)
})
