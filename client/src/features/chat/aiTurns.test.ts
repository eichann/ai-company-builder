// The automatic 「AI の番」 runner's rules (ai-turns.md): what may start, in which order, and
// when it stops. Each test names the promise it protects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AUTO_TURN_SETTINGS, readAutoTurnSettings } from '../../../shared/ai-turns'
import {
  AI_TURN_PASS_CAP, AI_TURN_PASS_INTERVAL_MS, MAX_ATTEMPTS_PER_RECORD, freshLog, logForToday, nextAiTurn, orderAiTurns,
  FAILED_REASON, URGENT_WITHIN_MS, aiTurnItems, handUrgent, handedOver, recordOutcome, recordStarted, resumed, retried, usagePauseUntil, type AiTurnDecisionInput,
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
  let log = recordOutcome(freshLog(NOW), 'minutes-x1x1x1x1', 'failed', settings, 0)
  log = recordOutcome(log, 'minutes-x2x2x2x2', 'done', settings, 0)
  log = recordOutcome(log, 'minutes-x3x3x3x3', 'unfinished', settings, 0)
  assert.deepEqual(nextAiTurn(input({ settings, log })), { run: B })
  log = recordOutcome(log, 'minutes-x4x4x4x4', 'failed', settings, 0)
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
  const log = recordOutcome(freshLog(NOW), B.id, 'usage-limit', ON, until)
  assert.equal(log.failuresInARow, 0)
  assert.equal(log.handed[B.id], undefined)
  assert.deepEqual(nextAiTurn(input({ log })), { wait: 'paused-usage' })
  assert.deepEqual(nextAiTurn(input({ log, now: resetsAt + 1 })), { run: B })
  assert.ok(usagePauseUntil(undefined, NOW) > NOW)
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
  log = recordOutcome(log, B.id, 'failed', ON, 0)
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
