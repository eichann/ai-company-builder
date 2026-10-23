import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatReset, fromClaudeRateLimitInfo, fromCodexRateLimits, meterView, METER_UNKNOWN_NOTE, type RateLimitSnapshot } from '../shared/rate-limits'
import { claudeAgentEvent, tapSdkMessages } from '../electron/agents/claude'
import { agentProgressFromSdkMessage, applyAgentProgress, readAgentProgress } from '../shared/agent-progress'

const NOW = Date.UTC(2026, 9, 23, 3, 0, 0)
const HOUR = 3_600_000

// Recorded from CLI 2.1.304 (haiku, 2026-10-23): both windows arrive in the
// undocumented `unifiedWindows`, utilization as a fraction, resetsAt in seconds.
const claudeEvent = {
  status: 'allowed', resetsAt: 1792686000, rateLimitType: 'five_hour', overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled_until', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.24, resetsAt: 1792686000 }, seven_day: { utilization: 0.66, resetsAt: 1793048400 } },
}

test('Claude rate_limit_event → both windows as percentages, milliseconds', () => {
  const snapshot = fromClaudeRateLimitInfo(claudeEvent, undefined, NOW)!
  assert.equal(snapshot.provider, 'claude-code')
  assert.equal(snapshot.status, 'allowed')
  assert.deepEqual(snapshot.windows, [
    { id: 'five_hour', label: '5時間', usedPercent: 24, resetsAt: 1792686000_000 },
    { id: 'seven_day', label: '1週間', usedPercent: 66, resetsAt: 1793048400_000 },
  ])
})

test('Claude: an older CLI names one window; the other one is kept from before', () => {
  const before = fromClaudeRateLimitInfo(claudeEvent, undefined, NOW)!
  const next = fromClaudeRateLimitInfo({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81, resetsAt: 1793048400 }, before, NOW + 1)!
  assert.equal(next.status, 'warning')
  assert.deepEqual(next.windows.map(w => [w.id, w.usedPercent]), [['five_hour', 24], ['seven_day', 81]])
  // Status only, no figure: the window is listed, its figure stays unknown.
  const bare = fromClaudeRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour' }, undefined, NOW)!
  assert.deepEqual(bare.windows, [{ id: 'five_hour', label: '5時間', usedPercent: null, resetsAt: null }])
  assert.equal(fromClaudeRateLimitInfo(undefined), undefined)
  assert.equal(fromClaudeRateLimitInfo({}), undefined)
  // `overage` is not a window.
  assert.deepEqual(fromClaudeRateLimitInfo({ status: 'allowed', rateLimitType: 'overage' }, undefined, NOW)!.windows, [])
})

// Recorded from codex-cli 0.153.4 `account/rateLimits/read` (ChatGPT prolite plan).
const codexRead = {
  limitId: 'codex', limitName: null, primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1793082877 }, secondary: null,
  credits: { hasCredits: false, unlimited: false, balance: '0' }, individualLimit: null, spendControlReached: false, planType: 'prolite', rateLimitReachedType: null,
}

test('Codex snapshot → windows named by duration; sparse updates merge', () => {
  const read = fromCodexRateLimits(codexRead, undefined, NOW)!
  assert.deepEqual(read.windows, [{ id: 'codex:10080', label: '1週間', usedPercent: 60, resetsAt: 1793082877_000 }])
  const both = fromCodexRateLimits({ primary: { usedPercent: 12.345, windowDurationMins: 300, resetsAt: 1792690000 }, secondary: null }, read, NOW + 1)!
  assert.deepEqual(both.windows.map(w => [w.label, w.usedPercent]), [['5時間', 12.3], ['1週間', 60]])
  const reached = fromCodexRateLimits({ primary: null, secondary: null, rateLimitReachedType: 'rate_limit_reached' }, both, NOW + 2)!
  assert.equal(reached.status, 'rejected')
  assert.equal(reached.windows.length, 2)
  assert.equal(fromCodexRateLimits({ primary: null, secondary: null }), undefined)
  // A Claude snapshot is never merged into a Codex one.
  const claude = fromClaudeRateLimitInfo(claudeEvent, undefined, NOW)
  assert.deepEqual(fromCodexRateLimits(codexRead, claude, NOW)!.windows.map(w => w.id), ['codex:10080'])
})

test('meter view: levels, warnings, unknown and expired windows', () => {
  const at = (usedPercent: number | null, resetsAt: number | null = NOW + 2 * HOUR + 10 * 60_000) => ({ id: 'five_hour', label: '5時間', usedPercent, resetsAt })
  const snap = (windows: RateLimitSnapshot['windows'], status: RateLimitSnapshot['status'] = 'allowed'): RateLimitSnapshot => ({ provider: 'claude-code', windows, status, updatedAt: NOW })

  assert.deepEqual(meterView(undefined, 'claude-code', NOW), { level: 'unknown', windows: [], note: METER_UNKNOWN_NOTE['claude-code'] })
  assert.equal(meterView(fromCodexRateLimits(codexRead, undefined, NOW), 'claude-code', NOW).level, 'unknown')
  assert.equal(meterView(snap([at(24)]), 'claude-code', NOW).level, 'ok')
  assert.equal(meterView(snap([at(75)]), 'claude-code', NOW).level, 'warn')
  assert.equal(meterView(snap([at(24), { ...at(92), id: 'seven_day' }]), 'claude-code', NOW).level, 'critical')
  const warned = meterView(snap([at(40)], 'warning'), 'claude-code', NOW)
  assert.equal(warned.level, 'warn')
  assert.match(warned.note, /近づいています/)
  const rejected = meterView(snap([at(40)], 'rejected'), 'claude-code', NOW)
  assert.equal(rejected.level, 'critical')
  assert.match(rejected.note, /達しています/)
  const noFigures = meterView(snap([at(null)]), 'claude-code', NOW)
  assert.equal(noFigures.level, 'ok')
  assert.equal(noFigures.windows[0].percent, null)
  // A window whose reset time has passed starts over.
  const expired = meterView(snap([at(97, NOW - 1)]), 'claude-code', NOW)
  assert.equal(expired.windows[0].percent, 0)
  assert.equal(expired.level, 'ok')
  assert.equal(meterView(snap([at(24)]), 'claude-code', NOW).windows[0].resetText.endsWith('に回復（あと2時間10分）'), true)
})

test('reset countdown text', () => {
  assert.equal(formatReset(null, NOW), '')
  assert.match(formatReset(NOW + 3 * 24 * HOUR + 5 * HOUR, NOW), /に回復（あと3日5時間）$/)
  assert.match(formatReset(NOW + 30_000, NOW), /に回復（あと1分）$/)
  assert.match(formatReset(NOW - 1, NOW), /に回復済み$/)
})

test('Claude SDK messages → app events', () => {
  const limits = claudeAgentEvent({ type: 'rate_limit_event', rate_limit_info: claudeEvent, uuid: 'u', session_id: 's' })
  assert.equal(limits?.type, 'rate-limits')
  assert.equal(limits?.type === 'rate-limits' && limits.update(undefined)?.windows.length, 2)
  // Recorded task_progress with a summary (agentProgressSummaries on).
  const progress = { type: 'system', subtype: 'task_progress', task_id: 'a560b58255e3eff61', tool_use_id: 'toolu_016J4UAvQ1VppgjSzjHbZRdU', description: 'Counting lines in probe.mjs', subagent_type: 'general-purpose', usage: { total_tokens: 15860, tool_uses: 4, duration_ms: 30860 }, summary: 'Counting lines in probe.mjs' }
  assert.deepEqual(claudeAgentEvent(progress), { type: 'agent-progress', progress: { toolCallId: 'toolu_016J4UAvQ1VppgjSzjHbZRdU', summary: 'Counting lines in probe.mjs' } })
  // Without a summary the CLI's own "Running …" description is not shown.
  assert.equal(claudeAgentEvent({ ...progress, summary: undefined, description: 'Running Wait 20 seconds' }), undefined)
  assert.deepEqual(claudeAgentEvent({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_x', status: 'completed', summary: 'done' }), { type: 'agent-progress', progress: { toolCallId: 'toolu_x', summary: null } })
  assert.equal(claudeAgentEvent({ type: 'assistant' }), undefined)
  assert.equal(claudeAgentEvent(null), undefined)
})

test('progress lines: latest per tool call, cleared when finished', () => {
  const long = 'x'.repeat(500)
  assert.equal(agentProgressFromSdkMessage({ type: 'system', subtype: 'task_progress', tool_use_id: 't', summary: long })?.summary?.length, 200)
  assert.equal(agentProgressFromSdkMessage({ type: 'system', subtype: 'task_progress', summary: 'no id' }), undefined)
  let state: ReadonlyMap<string, string> = new Map()
  state = applyAgentProgress(state, { toolCallId: 'a', summary: '認証まわりを調べています' })
  state = applyAgentProgress(state, { toolCallId: 'b', summary: '見積書を読んでいます' })
  const same = applyAgentProgress(state, { toolCallId: 'a', summary: '認証まわりを調べています' })
  assert.equal(same, state)
  state = applyAgentProgress(state, { toolCallId: 'a', summary: 'テストを書いています' })
  assert.equal(state.get('a'), 'テストを書いています')
  state = applyAgentProgress(state, { toolCallId: 'a', summary: null })
  assert.deepEqual([...state], [['b', '見積書を読んでいます']])
  assert.equal(applyAgentProgress(state, { toolCallId: 'zzz', summary: null }), state)
  assert.deepEqual(readAgentProgress({ toolCallId: 'a', summary: null }), { toolCallId: 'a', summary: null })
  assert.equal(readAgentProgress({ toolCallId: 'a', summary: 3 }), undefined)
  assert.equal(readAgentProgress('nope'), undefined)
})

test('tapping the SDK Query sees every message and leaves iteration unchanged', async () => {
  let cleaned = false
  async function* messages() {
    try { yield { type: 'system', subtype: 'init' }; yield { type: 'rate_limit_event' }; yield { type: 'result' } } finally { cleaned = true }
  }
  const inner = messages()
  const query = { [Symbol.asyncIterator]: () => inner }
  const seen: unknown[] = []
  tapSdkMessages(query, m => { seen.push(m); throw new Error('a failing observer must not break the turn') })
  const received: unknown[] = []
  for await (const m of query as AsyncIterable<unknown>) {
    received.push(m)
    if ((m as { type: string }).type === 'rate_limit_event') break
  }
  assert.equal(received.length, 2)
  assert.deepEqual(seen, received)
  assert.equal(cleaned, true, 'break still returns the inner generator')
  tapSdkMessages(undefined, () => {})
  tapSdkMessages({}, () => {})
})
