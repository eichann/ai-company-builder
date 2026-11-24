// The inspection cards' copy (inspectionStore.ts): what the site showed is kept only while a card shows it, and main's
// copy decides — so after a sign-out (main cleared its cards) a card shown again asks main and shows no value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserInspectionGetResult } from '../../../shared/browser-inspection'
import { inspectionEntry, inspectionKey, subscribeInspection } from './inspectionStore'

const view = {
  card: { title: '流入経路を点検する', state: 'all_ok', headline: 'h', sections: [{ heading: 's', rows: [{ label: '名前', value: { status: 'read', text: 'ひみつの名前' } }] }], checks: [], notes: [] },
  readAt: '2026-11-25T00:00:00.000Z', siteLabel: 'Lステップ',
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('a card shown again asks main again: after main dropped it (a sign-out), no value is shown from here', async () => {
  const key = inspectionKey('u1', 'c1', `bl_${'a'.repeat(32)}`)
  let answer: BrowserInspectionGetResult = { ok: true, view: view as never }
  let asked = 0
  const load = async () => { asked++; return answer }
  const off = subscribeInspection(key, load, 'x', () => {})
  await flush()
  assert.equal(inspectionEntry(key).view?.siteLabel, 'Lステップ')
  off()
  assert.equal(inspectionEntry(key).view, null, 'the copy goes with the last card')
  answer = { ok: false, message: '消えました' }
  const off2 = subscribeInspection(key, load, 'x', () => {})
  await flush()
  assert.equal(asked, 2)
  assert.equal(inspectionEntry(key).view, null)
  assert.equal(inspectionEntry(key).message, '消えました')
  off2()
})

test('an answer that arrives after the card went is dropped', async () => {
  const key = inspectionKey('u1', 'c1', `bl_${'b'.repeat(32)}`)
  let release: (r: BrowserInspectionGetResult) => void = () => {}
  const off = subscribeInspection(key, () => new Promise(r => { release = r }), 'x', () => {})
  off()
  release({ ok: true, view: view as never })
  await flush()
  assert.equal(inspectionEntry(key).view, null)
})
