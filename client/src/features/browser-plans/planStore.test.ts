// The plan cards' shared copy (planStore.ts): a card shown again reads the server again — a failure, a
// login in the site or a run elsewhere is not kept forever — while cards shown together share one read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserPlanGetResult } from '../../../shared/browser-plans'
import { planEntry, putPlan, subscribePlan } from './planStore'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('a card shown again reads again (a failure recovers); two shown together share one read', async () => {
  let reads = 0
  let answer: BrowserPlanGetResult = { ok: false, offline: true, message: 'offline' }
  const load = async () => { reads++; return answer }
  const key = 'u|c|bp_store'
  const a = subscribePlan(key, load, () => {})
  const b = subscribePlan(key, load, () => {})
  await settle()
  assert.equal(reads, 1)
  assert.equal(planEntry(key).error, 'offline')
  a(); b()
  answer = { ok: true, card: { plan: { id: 'bp_store' }, ready: { ok: true }, stoppedHere: false, runningHere: false, siteHost: null } } as unknown as BrowserPlanGetResult
  const c = subscribePlan(key, load, () => {})
  await settle()
  assert.equal(reads, 2)
  assert.equal(planEntry(key).error, null)
  assert.ok(planEntry(key).card)
  c()
})

test('a copy shown is kept through the server being out of reach, never through a refusal', () => {
  const key = 'u|c|bp_keep'
  const card = { ok: true, card: { plan: { id: 'bp_keep' }, ready: { ok: true }, stoppedHere: false, runningHere: false, siteHost: null } } as unknown as BrowserPlanGetResult
  putPlan(key, card)
  putPlan(key, { ok: false, offline: true, message: 'offline' })
  assert.ok(planEntry(key).card)
  putPlan(key, { ok: false, offline: false, message: 'この計画は見つかりませんでした。' })
  assert.equal(planEntry(key).card, null)
  assert.equal(planEntry(key).error, 'この計画は見つかりませんでした。')
})
