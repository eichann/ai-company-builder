// After 受け取る the app says what will really happen: 「次の回から動きます」 only for a job that now runs —
// not for one paused or held by the company's stop; a PC job (placement a) says it needs the app open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MyJob, MyJobOccurrence } from '../../../shared/jobs'
import { acceptedText, occurrenceRows, placeLine } from './model'

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
