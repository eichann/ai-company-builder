// 「記録の一覧」's read in main (electron/features/records-table/ipc.ts) and its pure rules
// (shared/records-table.ts): the server decides what the member sees; main only shapes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { TypeDefinition } from '../../shared/core/record-types'
import type { RecordSummary } from '../../shared/types/records'
import { createRecordsTableApi } from '../electron/features/records-table/ipc'
import { columnsOf, kindsOf, openStatesOf } from '../shared/records-table'

const defs: TypeDefinition[] = coreTypeDefinitions()
const task = defs.find(d => d.name === 'task')!

const summary = (id: string, fields: RecordSummary['fields'] = {}, extra: Partial<RecordSummary> = {}): RecordSummary => ({
  id, type: 'task', typeVersion: 1, title: id, summary: '', path: null, state: 'todo', fields, version: 1, updatedAt: '2026-11-20T00:00:00Z', ...extra,
})

function server(records: RecordSummary[], opts: { status?: number; code?: string } = {}) {
  const bodies: unknown[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
    if (opts.status) return json({ code: opts.code }, opts.status)
    if (path.endsWith('/records/types')) return json({ data: { types: defs.map(d => ({ definition: d, source: 'core', versions: [d.version] })) } })
    if (path.endsWith('/members')) return json({ data: [{ userId: 'u-sato', name: '佐藤' }] })
    if (path.endsWith('/records/query')) { bodies.push(JSON.parse(String(init?.body))); return json({ data: { total: 7, records } }) }
    return json({}, 404)
  }) as typeof fetch
  const api = createRecordsTableApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn: () => {} } })
  return { api, bodies }
}

test('the table shows exactly the records the server answered, in its order, marks as the server set them', async () => {
  const { api } = server([summary('task-b', { assignee: 'u-sato', due: '2026-11-19' }), summary('task-a', {}, { personal: true })])
  const page = await api.page('c1', { kind: 'task', openOnly: false, offset: 0 })
  assert.ok(page.success)
  assert.deepEqual(page.rows.map(r => r.id), ['task-b', 'task-a'])
  assert.equal(page.total, 7, 'the total is the server\'s (what the member may read), not counted here')
  assert.equal(page.rows[0].cells.assignee.text, '佐藤')
  assert.equal(page.rows[0].cells.due.sort, '2026-11-19')
  assert.equal(page.rows[1].personal, true)
})

test('it asks the existing query for one kind and one page; 済み以外 is the server\'s state filter', async () => {
  const { api, bodies } = server([])
  await api.page('c1', { kind: 'task', openOnly: true, offset: 200 })
  assert.deepEqual(bodies[0], { type: 'task', state: openStatesOf(task), limit: 200, offset: 200 })
  assert.ok(!(openStatesOf(task) ?? []).includes('done'))
  await api.page('c1', { kind: 'task', openOnly: false, offset: 0 })
  assert.deepEqual(bodies[1], { type: 'task', limit: 200, offset: 0 })
})

test('a kind gone since it was chosen falls back to the first kind there is', async () => {
  const { api, bodies } = server([])
  const page = await api.page('c1', { kind: 'gone_kind', openOnly: false, offset: 0 })
  assert.ok(page.success)
  assert.equal(page.kind, 'task')
  assert.equal((bodies[0] as { type: string }).type, 'task')
})

test('what the renderer hands is checked before anything is asked', async () => {
  const { api, bodies } = server([])
  for (const q of [{ kind: 'Task!', openOnly: true, offset: 0 }, { kind: 'task', openOnly: 'yes', offset: 0 }, { kind: 'task', openOnly: true, offset: -1 }, { kind: 'task', openOnly: true, offset: 1.5 }, null]) {
    const r = await api.page('c1', q)
    assert.equal(r.success, false)
  }
  assert.equal((await api.page('../x', { kind: 'task', openOnly: true, offset: 0 })).success, false)
  assert.equal(bodies.length, 0)
})

test('records turned off is not an error; an unreachable server says so in plain words', async () => {
  const off = await server([], { status: 404, code: 'RECORDS_DISABLED' }).api.page('c1', { kind: 'task', openOnly: true, offset: 0 })
  assert.ok(off.success && !off.available)
  const down = await server([], { status: 503 }).api.page('c1', { kind: 'task', openOnly: true, offset: 0 })
  assert.ok(!down.success && down.offline)
  assert.match(down.error, /サーバーにつながらない/)
})

test('columns: the kind\'s one-line server fields, 担当・期限 first, a few shown at first; kinds in the order people meet them', () => {
  const cols = columnsOf(task)
  assert.deepEqual(cols.slice(0, 3).map(c => c.field), ['assignee', 'due', 'requested_by'])
  assert.ok(cols.every(c => task.fields[c.field].source === 'server' && c.kind !== 'long_text' && c.kind !== 'record'))
  assert.equal(cols.filter(c => c.shown).length, 5)
  const kinds = kindsOf(defs).map(k => k.name)
  assert.equal(kinds[0], 'task')
  assert.ok(kinds.indexOf('project') < kinds.indexOf('meeting') && kinds.indexOf('meeting') < kinds.indexOf('decision'))
  assert.equal(kindsOf(defs)[0].label, 'やること')
})
