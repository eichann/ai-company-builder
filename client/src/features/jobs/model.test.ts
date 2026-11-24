// After 受け取る the app says what will really happen: 「次の回から動きます」 only for a job that now runs —
// not for one paused or held by the company's stop; a PC job (placement a) says it needs the app open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MyJob, MyJobOccurrence } from '../../../shared/jobs'
import { acceptanceLines, acceptedText, declinedRows, makeAnywayMessage, occurrenceRows, placeLine } from './model'
import { JOB_SET_WATCH_OPENED, type JobDefinition } from '../../../../shared/core/jobs'
import { SET_WATCH_NOT_RUN_NOTE, SET_WATCH_SEEN_NOTE } from '../../../../shared/core/job-words'

const job = (over: Partial<MyJob>): MyJob => ({
  id: 'job.' + '1'.repeat(32), name: '日報', state: 'active', waiting: null, pausedReason: null, trigger: null, placement: 'e',
  nextSlot: null, toAccept: null, controls: true, deliverTo: null, chainStopped: null, approvedVersion: 1, ...over,
})

test('「次の回から動きます」 only when the job now runs', () => {
  assert.equal(acceptedText(job({})), '受け取りました。次の回から動きます。')
  assert.equal(acceptedText(job({ state: 'paused', waiting: 'PAUSED', pausedReason: 'ADMIN' })), '受け取りました。いまは「管理者が止めました」です。')
  assert.match(acceptedText(job({ waiting: 'COMPANY_STOPPED' })), /すべて止める/)
  assert.match(acceptedText(job({ placement: 'a' })), /アプリが開いていて/)
  assert.match(acceptedText(job({ placement: 'a', waiting: 'PAUSED', pausedReason: 'ADMIN' })), /管理者が止めました/)
})

test('the deliverable place: asked at 受け取る, its own name while usable, and that it must be chosen again once not', () => {
  const place = { label: 'Google Drive のフォルダ', chosen: false, usable: false, name: null, expiresAt: null }
  assert.equal(placeLine(job({})), null)
  assert.match(placeLine(job({ deliverTo: place })) ?? '', /「受け取る」を押すと/)
  assert.match(placeLine(job({ deliverTo: { ...place, chosen: true } })) ?? '', /選び直すまで動きません/)
  assert.match(placeLine(job({ deliverTo: { ...place, chosen: true, usable: true, name: '報告書', expiresAt: '2027-02-09T00:00:00.000Z' } })) ?? '', /「報告書」（2\/9 まで使えます/)
})

const occ = (over: Partial<MyJobOccurrence>): MyJobOccurrence => ({
  id: 'occ.' + 'a'.repeat(32), jobId: 'job.' + '1'.repeat(32), name: '面談の報告', dueSlot: '2026-11-22T10:00', state: 'needs_person',
  outcomeCode: 'RESULT_UNKNOWN', retry: null, unknownOperations: [], madeBefore: [], ...over,
})

test('「AI が動いた回」 (D11): the buttons follow exactly what the server answered — never derived from the state', () => {
  // Nothing to press (the server left `retry` and `unknownOperations` out: rights it does not give): not shown at all.
  assert.deepEqual(occurrenceRows([occ({})]), [])
  // 「もう一度」 only where allowed; else why not, in the server's words.
  assert.equal(occurrenceRows([occ({ retry: { allowed: true } })])[0].retry, 'allowed')
  assert.deepEqual(occurrenceRows([occ({ retry: { allowed: false, why: 'JOB_RESULT_UNKNOWN' } })])[0].retry, { blocked: '外への操作（メールの下書きなど）が済んだか分からないものがあります。先に確かめてください' })
  // 「後始末」 for each unknown operation, also on a held occurrence (no 「もう一度」 there).
  const held = occurrenceRows([occ({ state: 'held', outcomeCode: 'JOB_PAUSED', unknownOperations: [{ key: 'acb-1', kind: 'drive-put' }] })])[0]
  assert.equal(held.retry, null)
  assert.deepEqual(held.unknown, [{ key: 'acb-1', what: 'Google Drive に置くファイル' }])
  assert.equal(held.heading, '面談の報告（11月22日 10:00）')
  // A later server's state and reason: still shown with its 「後始末」, in plain words.
  const later = occurrenceRows([occ({ state: null, retry: { allowed: false, why: 'UNKNOWN' }, unknownOperations: [{ key: 'acb-2', kind: 'other' }] })])[0]
  assert.equal(later.state, 'このアプリでは表示できない状態です')
  assert.deepEqual(later.retry, { blocked: '今は「もう一度」できません' })
  assert.equal(later.unknown.length, 1)
})

// 「出した案」 (member proposals): only what the server answered; 「取り下げる」 only while it waits.
test('出した案: the state in the proposer\'s words, 取り下げる only while it waits, a retired job\'s name never guessed', async () => {
  const { proposalRows } = await import('./model')
  const base = { jobId: 'job.' + '1'.repeat(32), proposerId: 'me', candidateId: 'jc.' + 'a'.repeat(32), submittedVersion: 1, submittedFingerprint: null, returnReason: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-22T03:00:00Z' }
  const rows = proposalRows([
    { ...base, id: 'jp.' + '1'.repeat(32), state: 'submitted' },
    { ...base, id: 'jp.' + '2'.repeat(32), state: 'approved' },
    { ...base, id: 'jp.' + '3'.repeat(32), jobId: 'job.' + '3'.repeat(32), state: 'returned', returnReason: 'TALK_FIRST' },
    { ...base, id: 'jp.' + '4'.repeat(32), state: 'withdrawn' },
  ], [job({ name: '議事録まとめ（毎週月曜 09:00）' })])
  assert.deepEqual(rows.map(r => r.withdraw), [true, false, false, false])
  assert.equal(rows[0].name, '議事録まとめ（毎週月曜 09:00）')
  assert.equal(rows[2].name, '定期の仕事')
  assert.match(rows[2].line, /差し戻されました（理由：先に話をしたい）/)
  assert.match(rows[1].line, /「受け取る」/)
})

// 4b-4 PR6: the set watch's 受け取る says what the admin approved (memo §2 / §5 / §6) — which records it takes and never takes,
// when it does not run, who sees its occurrences — and never describes a combination that is not opened as the opened one.
const setWatchDef = {
  schema: 5, name: '商談のあと', actingUser: 'u1', trigger: JOB_SET_WATCH_OPENED[0], check: { kind: 'matched_record' },
  run: { kind: 'procedure', procedure: { source: 'department_skill', place: '法人ソリューション', skill: 'sales-proposal-auto', fingerprint: '0'.repeat(40) } },
  placement: 'a', missed: { policy: 'skip', expiresAfterMinutes: 1440 },
  grant: {
    tools: ['records'], creates: ['task'], routes: ['GET /minutes/:recordId/text'], outbound: 'none', writes: { area: 'none' }, limits: { minutes: 30, runsPerDay: 10 },
    reads: { paths: [], calls: [], skills: [{ place: '法人ソリューション', skill: 'sales-proposal-v1', fingerprint: '0'.repeat(40) }] },
  },
  decision: { reasons: [{ code: 'asked_for_proposal', label: '提案を求められた' }] },
} as unknown as JobDefinition

test('a set watch\'s 受け取る: its conditions, when it does not run, the Skills read, the reasons, its grant and who sees it', () => {
  const lines = acceptanceLines(setWatchDef)
  assert.match(lines[0], /これから来る、条件に合うもの全部/)
  assert.ok(lines.some(l => /動く条件：.*初めての完了だけ/.test(l)))
  assert.ok(lines.some(l => /動く条件：社外の人が1人以上出た会議だけ/.test(l)))
  assert.ok(lines.includes(SET_WATCH_NOT_RUN_NOTE))
  assert.ok(lines.includes('読む Skill：「法人ソリューション」の Skill「sales-proposal-v1」'))
  assert.ok(lines.some(l => /判断の理由.*提案を求められた/.test(l)))
  assert.ok(lines.includes('議事録：動くきっかけになった会議の議事録だけ読む'))
  assert.ok(lines.some(l => /1日 10回まで。超えた会議では動かさず/.test(l)))
  assert.equal(lines[lines.length - 1], SET_WATCH_SEEN_NOTE)
  // A combination that is not opened (a later build's) is never described as this one: no condition lines.
  const other = { ...setWatchDef, trigger: { ...JOB_SET_WATCH_OPENED[0], guards: ['after_acceptance'] } } as unknown as JobDefinition
  assert.ok(!acceptanceLines(other).some(l => l.startsWith('動く条件：')))
  assert.match(acceptanceLines(other)[0], /説明できない条件/)
})

test('a set watch\'s 見送る is a row with ［作ってもらう］ until it is said; never the meeting\'s name', () => {
  const declined = occ({ id: 'occ.' + 'd'.repeat(32), name: '商談のあと', state: 'done', outcomeCode: null, report: { decision: 'decline', reason: 'just_met', confidence: 0.3, unconfirmed: [], feedback: [] } })
  const proceeded = occ({ state: 'done', outcomeCode: null, report: { decision: 'proceed', reason: 'asked', confidence: 0.9, unconfirmed: [], feedback: [] } })
  const rows = declinedRows([declined, proceeded, occ({})])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].heading, '商談のあと（11月22日 10:00）')
  assert.match(rows[0].line, /作りませんでした（AI は迷いました/)
  assert.equal(rows[0].makeAnyway, true)
  assert.equal(declinedRows([{ ...declined, report: { ...declined.report!, feedback: ['made_anyway'] } }])[0].makeAnyway, false)
  // A 見送る with update proposals has its やること (PR3b): not listed here (its ［作ってもらう］ is on the card).
  assert.deepEqual(declinedRows([{ ...declined, report: { ...declined.report!, updates: 2 } }]), [])
  assert.match(makeAnywayMessage('2026-11-22T10:00'), /11月22日 10:00ごろに私が完了した「議事録を確認する」/)
})
