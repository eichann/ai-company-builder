// After 受け取る the app says what will really happen: 「次の回から動きます」 only for a job that now runs —
// not for one paused, held by the company's stop, or on the PC (placement a, not run before PR 5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MyJob } from '../../../shared/jobs'
import { acceptedText } from './model'

const job = (over: Partial<MyJob>): MyJob => ({
  id: 'job.' + '1'.repeat(32), name: '日報', state: 'active', waiting: null, pausedReason: null, trigger: null, placement: 'e',
  nextSlot: null, toAccept: null, controls: true, ...over,
})

test('「次の回から動きます」 only when the job now runs', () => {
  assert.equal(acceptedText(job({})), '受け取りました。次の回から動きます。')
  assert.equal(acceptedText(job({ state: 'paused', waiting: 'PAUSED', pausedReason: 'ADMIN' })), '受け取りました。いまは「管理者が止めました」です。')
  assert.match(acceptedText(job({ waiting: 'COMPANY_STOPPED' })), /すべて止める/)
  assert.match(acceptedText(job({ placement: 'a' })), /まだ動きません/)
})
