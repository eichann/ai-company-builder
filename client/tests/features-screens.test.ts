// 「使う機能」 on the app's screens (owner decisions 2026-11-07, records.md "Features on and off").
// Guards:
// - the task list's read carries the company's features (an older server without them = everything
//   on) and asks for 決めたこと to confirm only while 決めたこと is on;
// - 「ACB で押すもの」 lists only approvals waiting for the member and what the AI prepared for them —
//   never an ordinary or resting task, never someone else's;
// - the title bar counts arrived minutes (nobody asked the AI yet) once, with what the list has;
// - a record's card is 「見るだけ」 exactly when its type's feature is off;
// - プロジェクト off: nothing of the core's kind is offered to make; a business plugin's kind still is;
// - 決めたこと off: the meeting's line does not speak of decisions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTasksApi } from '../electron/features/tasks/ipc'
import { createRecordViewsApi } from '../electron/features/record-views/ipc'
import { corePressItems, type TaskListItem } from '../shared/tasks'
import { arrivedMeetingTurns } from '../shared/notifications-app'
import { departmentBundleKind } from '../src/features/tasks/model'
import { madeWords } from '../src/features/minutes/model'
import type { BundleKindsResult } from '../../shared/types/records'

const ME = 'u-me'

function tasksHarness(features: unknown) {
  const asked: Array<{ path: string; body: unknown }> = []
  const api = createTasksApi({
    baseUrl: () => 'https://acb.test', cookies: () => ['session=abc'], log: { warn: () => {} },
    now: () => Date.parse('2026-11-05T06:00:00.000Z'),
    fetch: (async (url: string, init: RequestInit) => {
      const path = url.replace('https://acb.test', '')
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      asked.push({ path, body })
      if (path === '/api/me') return new Response(JSON.stringify({ data: { id: ME } }), { status: 200 })
      if (path.endsWith('/records/types')) return new Response(JSON.stringify({ data: { types: [], ...(features === undefined ? {} : { features }) } }), { status: 200 })
      if (path.endsWith('/records/query') && (body as { type?: string }).type === 'decision') {
        return new Response(JSON.stringify({ data: { total: 1, records: [{ id: 'decision-000001', type: 'decision', title: '値引きは10%まで', summary: '', state: 'unconfirmed', version: 1, fields: { owner: ME }, path: null }] } }), { status: 200 })
      }
      if (path.endsWith('/records/my-turn') || path.endsWith('/records/ai-turn') || path.endsWith('/records/query')) return new Response(JSON.stringify({ data: { total: 0, records: [] } }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 404 })
    }) as unknown as typeof fetch,
  })
  return { api, asked }
}

const decisionAsked = (asked: Array<{ path: string; body: unknown }>) => asked.some(a => a.path.endsWith('/records/query') && (a.body as { type?: string }).type === 'decision')

test('the list carries the features; an older server without them reads as everything on', async () => {
  const off = await tasksHarness({ taskList: false, meetings: true, inbox: true, decisions: true, projects: false }).api.list('co1')
  assert.ok(off.success)
  assert.deepEqual(off.data.features, { taskList: false, meetings: true, inbox: true, decisions: true, projects: false })
  const old = await tasksHarness(undefined).api.list('co1')
  assert.ok(old.success)
  assert.deepEqual(old.data.features, { taskList: true, meetings: true, inbox: true, decisions: true, projects: true })
})

test('決めたこと to confirm are read only while 決めたこと is on', async () => {
  const on = tasksHarness({ decisions: true })
  const r = await on.api.list('co1')
  assert.ok(r.success)
  assert.deepEqual(r.data.decisionsToConfirm, [{ id: 'decision-000001', title: '値引きは10%まで' }])
  const q = on.asked.find(a => (a.body as { type?: string } | undefined)?.type === 'decision')
  assert.deepEqual(q?.body, { type: 'decision', state: ['unconfirmed'], fields: { owner: ME }, limit: 50 })
  const off = tasksHarness({ decisions: false })
  const r2 = await off.api.list('co1')
  assert.ok(r2.success)
  assert.equal(decisionAsked(off.asked), false)
  assert.deepEqual(r2.data.decisionsToConfirm, [])
})

const item = (id: string, over: Partial<TaskListItem> = {}): TaskListItem => ({
  id, type: 'task', typeLabel: 'やること', title: id, state: 'todo', stateLabel: null, version: 1, due: null, tags: [], turn: 'mine',
  waitingFor: null, personal: false, own: true, actingFor: null, bundle: null, finishedAt: null, ...over,
})

test('「ACB で押すもの」: approvals waiting for the member and what the AI prepared for them, nothing else', () => {
  const r = corePressItems([
    item('approval-1', { type: 'approval' }),
    item('task-prepared', { aiPrepared: true }),
    item('task-plain'),
    item('task-resting', { aiPrepared: true, resting: true }),
    item('approval-others', { type: 'approval', turn: 'others' }),
    item('task-ai', { aiPrepared: true, turn: 'ai' }),
  ])
  assert.deepEqual(r.approvals.map(i => i.id), ['approval-1'])
  assert.deepEqual(r.prepared.map(i => i.id), ['task-prepared'])
})

test('the title bar counts arrived minutes nobody asked to read yet, each once', () => {
  const rows = arrivedMeetingTurns([
    { recordId: 'meeting-1', title: '定例', status: 'arrived' },
    { recordId: 'meeting-2', title: '読んだ会議', status: 'read' },
    { recordId: 'meeting-3', title: '頼んだ会議', status: 'asked' },
    { recordId: 'meeting-4', title: 'AI の番にもある', status: 'arrived' },
  ], new Set(['meeting-4']))
  assert.deepEqual(rows.map(r => [r.id, r.needsPerson]), [['meeting-1', true]])
})

test('a record\'s card is 「見るだけ」 exactly when its type\'s feature is off', async () => {
  const card = async (features: unknown) => {
    const api = createRecordViewsApi({
      baseUrl: () => 'https://acb.test', cookies: () => ['session=abc'], log: { warn: () => {} },
      fetch: (async (url: string) => {
        const path = new URL(url).pathname
        if (path.endsWith('/records/item/decision-abc123')) {
          return new Response(JSON.stringify({ data: { record: { id: 'decision-abc123', type: 'decision', title: '窓口は3つ', summary: '', state: 'unconfirmed', version: 2, fields: {}, path: null }, links: [] } }), { status: 200 })
        }
        if (path.endsWith('/records/types')) return new Response(JSON.stringify({ data: { types: [], ...(features === undefined ? {} : { features }) } }), { status: 200 })
        return new Response(JSON.stringify({ data: { entries: [], runs: [] } }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const r = await api.card('co1', 'decision-abc123')
    assert.ok(r.success)
    return r.card.featureOff === true
  }
  assert.equal(await card({ decisions: false }), true)
  assert.equal(await card({ decisions: true, meetings: false }), false)
  assert.equal(await card(undefined), false)
})

test('プロジェクト off: the core\'s kind is offered nowhere, a business plugin\'s kind still is', () => {
  const kinds: BundleKindsResult = {
    core: { type: 'project', name: 'プロジェクト', source: 'core' },
    departments: [
      { departmentId: 'd1', folder: '営業部', kind: { type: 'deal', name: '案件', source: 'plugin' } },
      { departmentId: 'd2', folder: '開発部', kind: { type: 'project', name: 'プロジェクト', source: 'core' } },
    ],
    kinds: [],
  }
  assert.equal(departmentBundleKind(kinds, '開発部')?.type, 'project')
  const off = { ...kinds, coreOff: true as const }
  assert.equal(departmentBundleKind(off, '開発部'), null)
  assert.equal(departmentBundleKind(off, null), null)
  assert.equal(departmentBundleKind(off, '営業部')?.type, 'deal')
})

test('決めたこと off: a read meeting\'s line speaks only of やることの案', () => {
  assert.equal(madeWords({ decisions: 2, proposals: 3 }), '決めたこと2・やることの案3')
  assert.equal(madeWords({ decisions: 2, proposals: 3 }, false), 'やることの案3')
})
