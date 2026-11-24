// 「会議のあと」's main part and the files it reads (4b-4 PR6-A, jobs.md "The 4b-4 screens (PR6-A)"): never the same item twice,
// only the run's own folder, files read as data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAfterMeetingApi } from '../electron/features/after-meeting/ipc'
import { itemKey, readProposalFile, readResultFile, type AfterMeetingChange, type HandedItem } from '../shared/after-meeting'

const OCC = `occ.${'a'.repeat(32)}`
const FOLDER = '営業/.personal/提案書/2026-11-24_A社'
const NOW = Date.parse('2026-11-24T10:00:00Z')
const proposals = { 版: 1, 会議: 'meeting-abc123', 更新案: [
  { 書き先: 'hubspot', 取引: '123', 項目: '確度', 値: 'B' },
  { 書き先: '係数表', 取引: '123', 項目: '粗利', 値: 1000 },
] }
const K_STAGE = itemKey({ 書き先: 'hubspot', 取引: '123', 項目: '確度' })
const K_SHEET = itemKey({ 書き先: '係数表', 取引: '123', 項目: '粗利' })
const HANDED: Record<string, HandedItem> = {
  [K_STAGE]: { 書き先: 'hubspot', 取引: '123', 項目: '確度', 値: 'A' },
  [K_SHEET]: { 書き先: '係数表', 取引: '123', 項目: '粗利', 値: 1200 },
}
/** An apply press as the card sends it: the keys and what it hands on of each. */
const press = (id: string, ...keys: string[]): AfterMeetingChange => ({ kind: 'apply', id, keys, items: keys.map(k => HANDED[k]) })

function world(t: { after: (fn: () => void) => void }, opts: { types?: unknown; folder?: string } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'acb-after-meeting-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'company')
  const runDir = path.join(root, ...FOLDER.split('/'))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, '更新案.json'), JSON.stringify(proposals))
  const records = path.join(base, 'records', 'c1', OCC)
  mkdirSync(records, { recursive: true })
  writeFileSync(path.join(records, 'run-1.1.json'), JSON.stringify({ v: 1, occurrenceId: OCC, runId: 'run-1', generation: 1, state: 'sent', folder: opts.folder ?? FOLDER, decision: 'proceed', confidence: 0.4, minutesDocVersion: 'notes:7', at: new Date(NOW).toISOString() }))
  let now = NOW
  const api = createAfterMeetingApi({
    paths: { validate: p => { if (!path.resolve(p).startsWith(root)) throw new Error('outside'); return path.resolve(p) } },
    recordsRoot: () => path.join(base, 'records'), marksRoot: () => path.join(base, 'marks'),
    baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], now: () => now, log: { warn: () => {} },
    fetch: (async () => new Response(JSON.stringify({ data: { types: opts.types ?? [] } }), { status: 200 })) as typeof fetch,
  })
  return { base, root, runDir, api, setNow: (n: number) => { now = n } }
}

test('the card reads the run\'s own files: its proposals, results and the business\'s stages for 確度', async t => {
  const w = world(t, { types: [{ definition: { fields: { confidence: { label: '確度', kind: 'choice', options: ['a', 'b'], optionLabels: { a: 'A（高）' } } } } }] })
  const r = await w.api.read('c1', w.root, OCC)
  assert.ok(r.success && r.run)
  assert.equal(r.run.folder, FOLDER)
  assert.equal(r.proposals.length, 2)
  assert.equal(r.meetingId, 'meeting-abc123')
  assert.deepEqual(r.stages, ['A（高）', 'b'])
  assert.equal(r.run.minutesDocVersion, 'notes:7')
})

test('a press is recorded once: the same item is never handed on twice while it waits or once written', async t => {
  const w = world(t)
  const first = await w.api.note('c1', w.root, OCC, press('a-0000000000000001', K_STAGE, K_SHEET))
  assert.ok(first.success)
  // A double press (two at once, and a second one later) is refused.
  const [a, b] = await Promise.all([
    w.api.note('c1', w.root, OCC, press('a-0000000000000002', K_STAGE)),
    w.api.note('c1', w.root, OCC, press('a-0000000000000003', K_SHEET)),
  ])
  assert.equal(a.success || b.success, false)
  assert.ok(!a.success && a.code === 'ALREADY')
  // Written: still refused after the wait; a failed one may be pressed again.
  writeFileSync(path.join(w.runDir, 'result.json'), JSON.stringify({ 版: 1, 結果: [
    { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '123', 項目: '確度', 状態: '済み' },
    { 回: 'a-0000000000000001', 書き先: '係数表', 取引: '123', 項目: '粗利', 状態: '失敗' },
  ] }))
  w.setNow(NOW + 60 * 60_000)
  assert.equal((await w.api.note('c1', w.root, OCC, press('a-0000000000000004', K_STAGE))).success, false)
  assert.equal((await w.api.note('c1', w.root, OCC, press('a-0000000000000005', K_SHEET))).success, true)
  // The same item twice in one press, or a press id used before: refused.
  assert.equal((await w.api.note('c1', w.root, OCC, press('a-0000000000000001', K_SHEET))).success, false)
})

test('two presses at the same moment: one is recorded, the other refused; one item twice in a press is refused', async t => {
  const w = world(t)
  const both = await Promise.all([
    w.api.note('c1', w.root, OCC, press('a-0000000000000001', K_STAGE)),
    w.api.note('c1', w.root, OCC, press('a-0000000000000002', K_STAGE)),
  ])
  assert.deepEqual(both.map(r => r.success), [true, false])
  assert.equal((await w.api.note('c1', w.root, OCC, press('a-0000000000000003', K_SHEET, K_SHEET))).success, false)
})

test('an apply keeps what it handed on (the value applied, an added item), and only items that are exactly its keys', async t => {
  const w = world(t)
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'apply', id: 'a-0000000000000001', keys: [K_STAGE], items: [HANDED[K_SHEET]] })).success, false)
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'apply', id: 'a-0000000000000001', keys: [K_STAGE] } as never)).success, false)
  const added: HandedItem = { 書き先: 'hubspot', 取引: '123', 項目: '次のアクション', 値: '見積を送る' }
  const r = await w.api.note('c1', w.root, OCC, { kind: 'apply', id: 'a-0000000000000002', keys: [K_STAGE, itemKey(added)], items: [HANDED[K_STAGE], added] })
  assert.ok(r.success)
  const read = await w.api.read('c1', w.root, OCC)
  assert.ok(read.success && read.run)
  assert.deepEqual(read.mark.applies[0].items, [HANDED[K_STAGE], added])
})

test('a press whose consultation did not start is taken back only at once and only while nothing answered it', async t => {
  const w = world(t)
  assert.ok((await w.api.note('c1', w.root, OCC, press('a-0000000000000001', K_STAGE))).success)
  assert.ok((await w.api.note('c1', w.root, OCC, { kind: 'cancel', id: 'a-0000000000000001' })).success)
  assert.ok((await w.api.note('c1', w.root, OCC, press('a-0000000000000002', K_STAGE))).success, 'offered again')
  w.setNow(NOW + 2 * 60_000)
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'cancel', id: 'a-0000000000000002' })).success, false, 'too late: it may have started')
  assert.ok((await w.api.note('c1', w.root, OCC, press('a-0000000000000003', K_SHEET))).success)
  writeFileSync(path.join(w.runDir, 'result.json'), JSON.stringify({ 版: 1, 結果: [{ 回: 'a-0000000000000003', 書き先: '係数表', 取引: '123', 項目: '粗利', 状態: '済み' }] }))
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'cancel', id: 'a-0000000000000003' })).success, false, 'answered: it started')
})

test('an undo of the coefficient sheet only for what the consultation wrote, with the value before kept', async t => {
  const w = world(t)
  assert.ok((await w.api.note('c1', w.root, OCC, press('a-0000000000000001', K_SHEET))).success)
  writeFileSync(path.join(w.runDir, 'result.json'), JSON.stringify({ 版: 1, 結果: [{ 回: 'a-0000000000000001', 書き先: '係数表', 取引: '123', 項目: '粗利', 状態: '済み' }] }))
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'undo', id: 'u-0000000000000001', keys: [K_SHEET] })).success, false, 'nothing kept to write back')
  writeFileSync(path.join(w.runDir, 'result.json'), JSON.stringify({ 版: 1, 結果: [{ 回: 'a-0000000000000001', 書き先: '係数表', 取引: '123', 項目: '粗利', 状態: '済み', 前の値: 900, 書いた値: 1000 }] }))
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'undo', id: 'u-0000000000000002', keys: [K_SHEET] })).success, true)
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'undo', id: 'u-0000000000000003', keys: [K_SHEET] })).success, false, 'not twice')
})

test('only the run\'s own folder in the company folder: a record naming another place, a link out or a root outside reads nothing', async t => {
  const bad = world(t, { folder: '営業/.personal/../../etc' })
  assert.deepEqual(await bad.api.read('c1', bad.root, OCC), { success: true, run: null })
  const w = world(t)
  assert.equal((await w.api.read('c1', '/elsewhere', OCC)).success, false)
  assert.equal((await w.api.read('c1', w.root, 'occ.not-one')).success, false)
  // The run folder replaced by a link to a folder outside: its files are not read.
  const outside = path.join(w.base, 'outside')
  mkdirSync(outside)
  writeFileSync(path.join(outside, '更新案.json'), JSON.stringify(proposals))
  rmSync(w.runDir, { recursive: true })
  symlinkSync(outside, w.runDir)
  const r = await w.api.read('c1', w.root, OCC)
  assert.ok(r.success && r.run && r.problem === 'none' && r.proposals.length === 0)
})

test('the files are read as data: another version is said, a result entry not of the shape is left out alone', () => {
  assert.deepEqual(readProposalFile(JSON.stringify({ ...proposals, 版: 2 })), { problem: 'version' })
  assert.deepEqual(readProposalFile(JSON.stringify({ ...proposals, 更新案: [proposals.更新案[0], proposals.更新案[0]] })), { problem: 'shape' })
  const results = readResultFile(JSON.stringify({ 版: 1, 結果: [
    { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '1', 項目: '金額', 状態: '承認待ち', 承認: 'approval-abc123', 承認する人: '田中' },
    { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '1', 項目: '確度', 状態: '済み', 承認: '../../x', 操作: 'op 1', プラグイン: 'corporate-sales' },
    { 回: 'nope', 書き先: 'hubspot', 取引: '1', 項目: '確度', 状態: '済み' },
    { 回: 'a-0000000000000001', 書き先: 'hubspot', 取引: '1', 項目: '確度', 状態: 'なにか' },
  ] }))
  assert.equal(results.length, 2)
  assert.equal(results[0].承認, 'approval-abc123')
  assert.equal(results[1].承認, undefined, 'an id not of its shape is dropped')
  assert.equal(results[1].操作, undefined)
})

test('［いらない］ and a person\'s undo are kept on this PC in the app\'s data, never in the company folder', async t => {
  const w = world(t)
  const r = await w.api.note('c1', w.root, OCC, { kind: 'draft-dismissed' })
  assert.ok(r.success && r.mark.draftDismissed)
  const kept = JSON.parse(readFileSync(path.join(w.base, 'marks', 'c1', `${OCC}.json`), 'utf8'))
  assert.equal(kept.draftDismissed, true)
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'undone', key: K_STAGE })).success, true)
  assert.equal((await w.api.note('c1', w.root, OCC, { kind: 'bogus' } as never)).success, false)
})
