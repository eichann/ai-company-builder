// The set watch in the app (4b-4 PR6, owner memo 「4b-4 挟む部分」 H-10 / S11; jobs.md "The set watch (schema 5)" "The app
// (PR6)"): what a judgement offers (never done for the member, a correction only where the server takes it), which やること
// is a set watch's, 「議事録が直された」 never said as unchanged when unknown, the 受け取る words only once 5 is announced, the
// meeting's name only from what the card's read answered, the 見送る notice leading to 「定期の仕事」, and main keeping only
// the judgement's fixed kinds and sending only a known correction for a well-formed occurrence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOB_SET_WATCH_OPENED, occurrenceTaskId } from '../../shared/core/jobs'
import type { JobSetReportView } from '../../shared/types/jobs'
import { appReadsJobDefinition, jobNoticeTarget, minutesEditedMark, setWatchOccurrenceOf, setWatchOffer, type MyJobOccurrence } from '../shared/jobs'
import { linkedMeetingTitle, type TaskCardData } from '../shared/task-card'
import { createJobsApi, parseSetReport } from '../electron/features/jobs/ipc'

const report = (over: Partial<JobSetReportView>): JobSetReportView => ({ decision: 'proceed', reason: 'asked_for_proposal', confidence: 0.8, unconfirmed: [], feedback: [], ...over })

test('a judgement offers ［確かめて完了］ only where a やること was made, ［まだ早かった］ once after 進める / 人に聞く, ［作ってもらう］ after 見送る or a failed gate', () => {
  assert.deepEqual(setWatchOffer(report({})), { confirmDone: true, tooEarly: true, makeAnyway: false, makeAnywayRecords: false })
  assert.deepEqual(setWatchOffer(report({ decision: 'ask' })), { confirmDone: true, tooEarly: true, makeAnyway: false, makeAnywayRecords: false })
  // Already said: not offered again (the server would answer recorded: false).
  assert.equal(setWatchOffer(report({ feedback: ['too_early'] })).tooEarly, false)
  // 見送る: no やること to complete, ［作ってもらう］ records `made_anyway` once.
  assert.deepEqual(setWatchOffer(report({ decision: 'decline' })), { confirmDone: false, tooEarly: false, makeAnyway: true, makeAnywayRecords: true })
  assert.equal(setWatchOffer(report({ decision: 'decline', feedback: ['made_anyway'] })).makeAnyway, false)
  // 見送る with update proposals has its やること (PR3b): it is completed there, and ［作ってもらう］ still records made_anyway.
  assert.deepEqual(setWatchOffer(report({ decision: 'decline', updates: 2 })), { confirmDone: true, tooEarly: false, makeAnyway: true, makeAnywayRecords: true })
  // The gate could not judge: its やること can be completed or made anyway — with no correction (nothing to correct).
  assert.deepEqual(setWatchOffer(report({ decision: 'gate_failed', confidence: null })), { confirmDone: true, tooEarly: false, makeAnyway: true, makeAnywayRecords: false })
})

const OCC = 'occ.' + 'b'.repeat(32)
const occ = (over: Partial<MyJobOccurrence>): MyJobOccurrence => ({
  id: OCC, jobId: 'job.' + '1'.repeat(32), name: '商談のあと', dueSlot: '2026-11-24T15:00', state: 'done', outcomeCode: null, retry: null,
  unknownOperations: [], madeBefore: [], ...over,
})

test('a やること is a set watch\'s only when the member\'s own view answered a judgement for its occurrence', () => {
  const task = occurrenceTaskId(OCC)
  assert.equal(setWatchOccurrenceOf([occ({ report: report({}) })], task)?.id, OCC)
  // No judgement (another event job's occurrence, or not theirs to see now): not one.
  assert.equal(setWatchOccurrenceOf([occ({})], task), null)
  assert.equal(setWatchOccurrenceOf([occ({ report: report({}) })], 'task-' + 'c'.repeat(32)), null)
})

test('「議事録が直された」 only when both versions are known and differ; unknown is never said as unchanged; nothing before PR5', () => {
  assert.equal(minutesEditedMark({ read: 'v1', now: 'v2' }), 'edited')
  assert.equal(minutesEditedMark({ read: 'v1', now: 'v1' }), 'same')
  assert.equal(minutesEditedMark({ read: 'v1', now: null }), 'unknown')
  assert.equal(minutesEditedMark({ read: null, now: 'v2' }), 'none')
  assert.equal(minutesEditedMark(undefined), 'none')
})

const setWatch = {
  schema: 5, name: '商談のあと', actingUser: 'u1', trigger: JOB_SET_WATCH_OPENED[0], check: { kind: 'matched_record' },
  run: { kind: 'procedure', procedure: { source: 'department_skill', place: '法人ソリューション', skill: 'sales-proposal-auto', fingerprint: '0'.repeat(40) } },
  placement: 'a', missed: { policy: 'skip', expiresAfterMinutes: 1440 },
  grant: { tools: ['records'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], reads: { paths: [], calls: [] }, writes: { area: 'none' }, outbound: 'none', limits: { minutes: 30, runsPerDay: 10 } },
  decision: { reasons: [{ code: 'asked_for_proposal', label: '提案を求められた' }] },
}

test('受け取る shows a set watch\'s definition only once the app announces 5 (the runner\'s build)', () => {
  assert.equal(appReadsJobDefinition(setWatch), null)
  assert.equal(appReadsJobDefinition(setWatch, [1, 2, 3, 4, 5])?.schema, 5)
})

test('the meeting\'s name beside a date-only title comes only from a linked meeting the card\'s read answered', () => {
  const meeting = { id: 'meeting-abcdef', type: 'meeting', typeLabel: '会議の記録', kind: 'interaction', title: '〇〇社 定例', summary: '', stateLabel: null, updatedAt: '', thing: 'meeting' }
  const links = [{ label: '会議', record: meeting }] as unknown as TaskCardData['links']
  assert.equal(linkedMeetingTitle(links), '〇〇社 定例')
  // A meeting the member no longer reads is not in the answer: nothing is said.
  assert.equal(linkedMeetingTitle([{ label: '会議' }] as unknown as TaskCardData['links']), null)
  assert.equal(linkedMeetingTitle([{ label: '案件', record: { ...meeting, type: 'deal' } }] as unknown as TaskCardData['links']), null)
})

test('a set watch\'s 見送る notice opens 「定期の仕事」, where its ［作ってもらう］ is', () => {
  assert.equal(jobNoticeTarget('job_set_declined'), 'jobs')
})

test('main keeps only the judgement\'s fixed kinds: an unknown decision gives no report, no quote or free word is kept', () => {
  assert.deepEqual(parseSetReport({ decision: 'proceed', reason: 'asked_for_proposal', confidence: 0.42, unconfirmed: ['budget', '〇〇社'], feedback: ['too_early', 'x'], evidence: '「来月提案して」' }),
    { decision: 'proceed', reason: 'asked_for_proposal', confidence: 0.42, updates: 0, unconfirmed: ['budget'], feedback: ['too_early'] })
  assert.equal(parseSetReport({ decision: 'decline', reason: 'x', confidence: 0.1, updates: 3 })?.updates, 3)
  assert.equal(parseSetReport({ decision: 'decline', reason: 'x', confidence: 0.1, updates: 21 })?.updates, 0)
  assert.equal(parseSetReport({ decision: 'decline', reason: 'x', confidence: 0.1, updates: '3' })?.updates, 0)
  assert.equal(parseSetReport({ decision: 'maybe', reason: 'x', confidence: 1 }), null)
  assert.equal(parseSetReport('proceed'), null)
  // A reason that is not a code is not kept as words.
  assert.equal(parseSetReport({ decision: 'decline', reason: '〇〇社の都合', confidence: 2 })?.reason, '')
  assert.equal(parseSetReport({ decision: 'decline', reason: 'x', confidence: 2 })?.confidence, null)
})

test('a correction reaches the server only as a known kind for a well-formed occurrence, on its own route', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) })
    return new Response(JSON.stringify({ success: true, data: { recorded: true } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  const api = createJobsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn: () => {} } })
  assert.equal((await api.feedback('c1', OCC, 'went_ahead_and_sent')).success, false)
  assert.equal((await api.feedback('c1', '../jobs', 'too_early')).success, false)
  assert.equal((await api.feedback('c1/../x', OCC, 'too_early')).success, false)
  assert.equal(calls.length, 0)
  assert.deepEqual(await api.feedback('c1', OCC, 'too_early'), { success: true, recorded: true })
  assert.deepEqual(calls, [{ url: `https://acb.example/api/companies/c1/me/job-occurrences/${OCC}/feedback`, body: '{"kind":"too_early"}' }])
})
