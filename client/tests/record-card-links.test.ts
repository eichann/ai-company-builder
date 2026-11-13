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

// A 案件・プロジェクト's Drive files (owner decision 2026-11-13, records.md "Drive and PC file links"): their own list
// (the name only where the server marked them the member's), never a path row; ［Google Drive のファイルをつなぐ］ only
// for a bundle type with exactly one file link, its feature on.
test('a プロジェクト: Drive files as their own list (names only the linker\'s), never a path row; the Drive button only for a bundle type with exactly one file link (not none, not two; not a non-bundle type with one), its feature on', async () => {
  const { coreTypeDefinitions } = await import('../../shared/core/core-types')
  const types = coreTypeDefinitions().map(d => ({ definition: d }))
  const project = {
    record: { ...summary('project-0000p1', 'project', 4), state: 'active' },
    links: [
      { name: 'files', direction: 'out', drive: { fileId: '1Mine00000000001', mine: true, name: '作業中の資料' } },
      // Even if a server sent a name with someone else's link, it is not shown.
      { name: 'files', direction: 'out', drive: { fileId: '1Other0000000001', mine: false, name: '他人の資料' } },
      { name: 'files', direction: 'out', local: { path: '営業/メモ.md' } },
    ],
  }
  const meeting = { record: { ...summary('meeting-0000aa', 'meeting', 5), state: 'read' }, links: [] }
  // A bundle type with no file link, one with two (the server would need a link name), and a non-bundle type with
  // exactly one (a やること: its own card offers Drive, the record card does not).
  const def = types.find(t => t.definition.name === 'project')!.definition
  const { files, ...noFiles } = def.links
  types.push({ definition: { ...def, name: 'campaign', links: noFiles } })
  types.push({ definition: { ...def, name: 'program', links: { ...def.links, drafts: { ...files } } } })
  const others: Record<string, unknown> = {
    'campaign-0000c1': { record: { ...summary('campaign-0000c1', 'campaign', 2), state: 'active' }, links: [] },
    'program-0000g1': { record: { ...summary('program-0000g1', 'program', 2), state: 'active' }, links: [] },
    'task-0000t1': { record: { ...summary('task-0000t1', 'task', 2), state: 'todo' }, links: [] },
  }
  const apiWith = (features: unknown) => createRecordViewsApi({
    baseUrl: () => 'https://acb.test', cookies: () => ['session=abc'], log: { warn: () => {} },
    fetch: (async (url: string) => {
      const path = new URL(url).pathname
      if (path.endsWith('/records/item/project-0000p1')) return new Response(JSON.stringify({ data: project }), { status: 200 })
      if (path.endsWith('/records/item/meeting-0000aa')) return new Response(JSON.stringify({ data: meeting }), { status: 200 })
      const other = Object.keys(others).find(id => path.endsWith(`/records/item/${id}`))
      if (other) return new Response(JSON.stringify({ data: others[other] }), { status: 200 })
      if (path.endsWith('/records/types')) return new Response(JSON.stringify({ data: { types, features } }), { status: 200 })
      return new Response(JSON.stringify({ data: { entries: [], runs: [] } }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  const r = await apiWith(undefined).card('co1', 'project-0000p1')
  assert.ok(r.success)
  if (!r.success) return
  assert.equal(r.card.driveLink, true)
  assert.deepEqual(r.card.driveFiles, [
    { fileId: '1Mine00000000001', mine: true, name: '作業中の資料' },
    { fileId: '1Other0000000001', mine: false, name: null },
  ])
  assert.deepEqual(r.card.links, [])
  for (const id of ['meeting-0000aa', ...Object.keys(others)]) {
    const c = await apiWith(undefined).card('co1', id)
    assert.ok(c.success, id)
    assert.equal(c.success && c.card.driveLink, undefined, id)
  }
  // Its feature turned off (「見るだけ」): nothing offered.
  const off = await apiWith({ projects: false }).card('co1', 'project-0000p1')
  assert.ok(off.success && off.card.driveLink === undefined)
})
