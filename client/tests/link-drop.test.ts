// 「落とすと、つながります」 (owner decision 2026-11-03, tasks-ui.md "Dropping links"). Guards: a drop
// becomes only a link the two types allow — never where the record came from (origin) — with the
// one-line refusal otherwise; main links at the version the server has now, asks when several fit,
// and a refused drop never reaches the server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { TypeDefinition } from '../../shared/core/record-types'
import { dropLinkPlan } from '../shared/link-drop'
import { linkedPathOf } from '../shared/record-views'
import { createTasksApi } from '../electron/features/tasks/ipc'

const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const t = (type: string) => ({ type, def: defs.get(type) })
// A business plugin's 案件: a bundle with no links of its own to tasks.
const deal: TypeDefinition = { ...defs.get('project')!, name: 'deal', label: '案件' }

test('a やること dropped on a やること is a related one; on a 案件 it becomes that 案件\'s', () => {
  assert.deepEqual(dropLinkPlan(t('task'), t('task')), { choices: [{ source: 'target', link: 'related', label: '関係するやること' }] })
  assert.deepEqual(dropLinkPlan({ type: 'deal', def: deal }, t('task')), { choices: [{ source: 'dropped', link: 'bundle', label: '案件' }] })
  assert.deepEqual(dropLinkPlan(t('task'), { type: 'deal', def: deal }), { choices: [{ source: 'target', link: 'bundle', label: '案件' }] })
})

test('what no link allows is refused in one line, never 「まとまり」', () => {
  assert.deepEqual(dropLinkPlan(t('task'), t('decision')), { refused: 'やることには決めたことはつなげません' })
  // A task's もとの会議 is where it came from: never made by a drop, either way.
  assert.deepEqual(dropLinkPlan(t('task'), t('meeting')), { refused: 'やることには会議の記録はつなげません' })
  assert.deepEqual(dropLinkPlan(t('meeting'), t('task')), { refused: '会議の記録にはやることはつなげません' })
  for (const [a, b] of [['task', 'decision'], ['decision', 'task'], ['task', 'project']]) {
    const plan = dropLinkPlan(t(a), t(b))
    assert.ok(!JSON.stringify(plan).includes('まとまり'), `${a} ← ${b}`)
  }
})

test('records only their service changes take no drops; a file needs a file link', () => {
  assert.ok('refused' in dropLinkPlan(t('approval'), t('task')))
  assert.deepEqual(dropLinkPlan(t('task'), 'file'), { choices: [{ source: 'target', link: 'files', label: '関係するファイル' }] })
  assert.deepEqual(dropLinkPlan(t('decision'), 'file'), { refused: '決めたことにはファイルやフォルダはつなげません' })
})

test('several links that fit are offered as a choice', () => {
  const two: TypeDefinition = { ...defs.get('task')!, name: 'review', label: '見直し', links: {
    main: { label: 'もとのやること', target: 'task', cardinality: 'one' }, more: { label: 'ほかのやること', target: 'task', cardinality: 'many' },
  } }
  const plan = dropLinkPlan({ type: 'review', def: two }, t('task'))
  assert.ok('choices' in plan && plan.choices.map(c => c.link).join() === 'main,more')
})

function harness(records: Record<string, { type: string; version: number; title: string }>) {
  const sent: Array<{ path: string; body: unknown }> = []
  const api = createTasksApi({
    baseUrl: () => 'https://acb.test', cookies: () => ['s=1'], log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace('/api/companies/co1', '')
      if (path === '/records/types') return Response.json({ data: { types: [...defs.values(), deal].map(definition => ({ definition })) } })
      const item = /^\/records\/item\/([^/]+)$/.exec(path)
      if (item && (!init.method || init.method === 'GET')) {
        const r = records[decodeURIComponent(item[1])]
        return r ? Response.json({ data: { record: { id: item[1], fields: {}, state: null, summary: '', updatedAt: '', ...r }, links: [] } }) : Response.json({}, { status: 404 })
      }
      sent.push({ path, body: JSON.parse(String(init.body)) })
      return Response.json({ data: { entry: { version: 99 }, changed: true } })
    }) as unknown as typeof fetch,
  })
  return { api, sent }
}

test('main links at the version read now, on the record that holds the link, and answers its 取り消す', async () => {
  const h = harness({ 'task-aaaaaa': { type: 'task', version: 4, title: '見積を直す' }, 'deal-bbbbbb': { type: 'deal', version: 7, title: 'A社' } })
  const r = await h.api.dropLink('co1', 'deal-bbbbbb', { kind: 'record', id: 'task-aaaaaa' })
  assert.deepEqual(r, { success: true, done: { text: '「見積を直す」をつなぎました', undo: { recordId: 'task-aaaaaa', version: 99 } } })
  assert.deepEqual(h.sent, [{ path: '/records/item/task-aaaaaa/record-links', body: { link: 'bundle', target: 'deal-bbbbbb', expectedVersion: 4 } }])
})

test('a refused drop, a record on itself and a path outside the company never reach the server', async () => {
  const h = harness({ 'task-aaaaaa': { type: 'task', version: 1, title: 'a' }, 'decision-cccccc': { type: 'decision', version: 1, title: 'b' } })
  const refused = await h.api.dropLink('co1', 'task-aaaaaa', { kind: 'record', id: 'decision-cccccc' })
  assert.deepEqual(refused, { success: false, offline: false, error: 'やることには決めたことはつなげません' })
  assert.equal((await h.api.dropLink('co1', 'task-aaaaaa', { kind: 'record', id: 'task-aaaaaa' })).success, false)
  assert.equal((await h.api.dropLink('co1', 'task-aaaaaa', { kind: 'path', path: '../outside.md' })).success, false)
  assert.equal((await h.api.dropLink('co1', 'task-aaaaaa', { kind: 'path', path: '営業/a.md' }, '../x')).success, false)
  assert.deepEqual(h.sent, [])
})

test('a folder dropped on a やること is linked as a file link at the task\'s version', async () => {
  const h = harness({ 'task-aaaaaa': { type: 'task', version: 3, title: 'a' } })
  const r = await h.api.dropLink('co1', 'task-aaaaaa', { kind: 'path', path: '営業部/見積' })
  assert.equal(r.success && 'done' in r && r.done.text, '「見積」をつなぎました')
  assert.deepEqual(h.sent, [{ path: '/records/item/task-aaaaaa/file-links', body: { path: '営業部/見積', link: 'files', expectedVersion: 3 } }])
})

test('「〇人は開けません」 is only a positive count from the server, per path', () => {
  assert.deepEqual(linkedPathOf({ path: '経理/a.md', folder: true }, { '経理/a.md': 2, '営業/b.md': 1 }), { path: '経理/a.md', folder: true, cannotOpen: 2 })
  assert.deepEqual(linkedPathOf({ path: '経理/a.md' }, { '経理/a.md': 0 }), { path: '経理/a.md' })
  assert.deepEqual(linkedPathOf({ path: '経理/a.md' }, { '経理/a.md': '2人' }), { path: '経理/a.md' })
  assert.deepEqual(linkedPathOf({ path: '経理/a.md' }, undefined), { path: '経理/a.md' })
})
