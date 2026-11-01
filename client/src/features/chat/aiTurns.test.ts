// The automatic 「AI の番」 runner's rules (ai-turns.md): what may start, in which order, and
// when it stops. Each test names the promise it protects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AUTO_TURN_SETTINGS, readAutoTurnSettings } from '../../../shared/ai-turns'
import {
  AI_TURN_PASS_CAP, AI_TURN_PASS_INTERVAL_MS, MAX_ATTEMPTS_PER_RECORD, freshLog, logForToday, nextAiTurn, orderAiTurns,
  recordOutcome, recordStarted, resumed, usagePauseUntil, type AiTurnCandidate, type AiTurnDecisionInput,
} from './aiTurns'

const NOW = Date.parse('2026-11-01T10:00:00+09:00')
const minutes = (id: string, meetingAt: string, extra: Partial<AiTurnCandidate> = {}): AiTurnCandidate =>
  ({ id, title: id, version: 1, meetingAt, ...extra })
const A = minutes('minutes-aaaaaaaa', '2026-10-31T10:00:00Z')
const B = minutes('minutes-bbbbbbbb', '2026-10-30T10:00:00Z')

const input = (over: Partial<AiTurnDecisionInput> = {}): AiTurnDecisionInput => ({
  settings: DEFAULT_AUTO_TURN_SETTINGS, agent: 'claude-code', agentReady: true, busy: false,
  log: freshLog(NOW), queue: [A, B], pass: null, now: NOW, ...over,
})

test('the company setting off: nothing starts', () => {
  assert.deepEqual(nextAiTurn(input({ settings: { ...DEFAULT_AUTO_TURN_SETTINGS, enabled: false } })), { wait: 'off' })
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
  const settings = { ...DEFAULT_AUTO_TURN_SETTINGS, dailyLimit: 2 }
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
  const settings = { ...DEFAULT_AUTO_TURN_SETTINGS, stopAfterFailures: 2 }
  let log = recordOutcome(freshLog(NOW), 'failed', settings, 0)
  log = recordOutcome(log, 'done', settings, 0)
  log = recordOutcome(log, 'failed', settings, 0)
  assert.deepEqual(nextAiTurn(input({ settings, log })), { run: B })
  log = recordOutcome(log, 'failed', settings, 0)
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
  const log = recordOutcome(freshLog(NOW), 'usage-limit', DEFAULT_AUTO_TURN_SETTINGS, until)
  assert.equal(log.failuresInARow, 0)
  assert.deepEqual(nextAiTurn(input({ log })), { wait: 'paused-usage' })
  assert.deepEqual(nextAiTurn(input({ log, now: resetsAt + 1 })), { run: B })
  assert.ok(usagePauseUntil(undefined, NOW) > NOW)
})

test('settings from a server: unusable values fall back to the defaults, never to "unlimited"', () => {
  assert.deepEqual(readAutoTurnSettings({ enabled: false, dailyLimit: -1, stopAfterFailures: 'x' }),
    { enabled: false, dailyLimit: DEFAULT_AUTO_TURN_SETTINGS.dailyLimit, stopAfterFailures: DEFAULT_AUTO_TURN_SETTINGS.stopAfterFailures })
  assert.equal(readAutoTurnSettings({ dailyLimit: 1e9 }).dailyLimit, DEFAULT_AUTO_TURN_SETTINGS.dailyLimit)
})
