// After 受け取る the app says what will really happen: 「次の回から動きます」 only for a job that now runs —
// not for one paused or held by the company's stop; a PC job (placement a) says it needs the app open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MyJob } from '../../../shared/jobs'
import { acceptedText, placeLine } from './model'

const job = (over: Partial<MyJob>): MyJob => ({
  id: 'job.' + '1'.repeat(32), name: '日報', state: 'active', waiting: null, pausedReason: null, trigger: null, placement: 'e',
  nextSlot: null, toAccept: null, controls: true, deliverTo: null, ...over,
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
