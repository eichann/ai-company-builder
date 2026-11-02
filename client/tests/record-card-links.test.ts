// 「つながっているもの」 on a record's card (tasks-ui.md "Links between records"). Guards: a link the
// server marked `fixed` (where the record came from) never gets 「つながりを外す」; an incoming link is
// taken off the record that holds it, at that record's version; the record's own 案件 is marked for
// its head.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordViewsApi } from '../electron/features/record-views/ipc'

const summary = (id: string, type: string, version: number) => ({ id, type, title: id, summary: '', state: 'open', version, fields: {}, path: null, updatedAt: '' })
const DETAIL = {
  record: { ...summary('meeting-0000aa', 'meeting', 5), state: 'read' },
  links: [
    { name: 'bundle', direction: 'out', record: summary('deal-0000ee', 'deal', 2) },
    { name: 'meeting', direction: 'in', record: summary('decision-000001', 'decision', 3) },
    { name: 'meeting', direction: 'in', fixed: true, record: summary('task-000001', 'task', 4) },
  ],
}

test('only links not marked fixed can be taken off, each from the record that holds it; the 案件 is marked for the head', async () => {
  const api = createRecordViewsApi({
    baseUrl: () => 'https://acb.test', cookies: () => ['session=abc'], log: { warn: () => {} },
    fetch: (async (url: string) => {
      const path = new URL(url).pathname
      if (path.endsWith('/records/item/meeting-0000aa')) return new Response(JSON.stringify({ data: DETAIL }), { status: 200 })
      return new Response(JSON.stringify({ data: { entries: [], types: [], runs: [] } }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  const r = await api.card('co1', 'meeting-0000aa')
  assert.ok(r.success)
  if (!r.success) return
  assert.equal(r.card.version, 5)
  // Another record's link to this one says nothing under its row (its type's raw label, 「タスク」, never shows).
  assert.deepEqual(r.card.links.map(l => l.label), ['bundle', '', ''])
  assert.deepEqual(r.card.links.map(l => [l.record?.id, l.bundle ?? false, l.removable ?? null]), [
    ['deal-0000ee', true, { source: 'meeting-0000aa', sourceVersion: 5, link: 'bundle', target: 'deal-0000ee' }],
    ['decision-000001', false, { source: 'decision-000001', sourceVersion: 3, link: 'meeting', target: 'meeting-0000aa' }],
    ['task-000001', false, null],
  ])
})
