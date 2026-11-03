// 「新しい〇〇にする」 in main (tasks:createBundle, tasks-ui.md). Guards: the new 案件・プロジェクト has the
// member as its 責任者 (the server does not fill it in), sits in the department's folder with the 相手
// when given; a malformed type, folder or 相手 never reaches the server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTasksApi } from '../electron/features/tasks/ipc'

function harness() {
  const sent: unknown[] = []
  const api = createTasksApi({
    baseUrl: () => 'https://acb.test', cookies: () => ['s=1'], log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname
      if (path === '/api/me') return new Response(JSON.stringify({ data: { id: 'u-sato' } }), { status: 200 })
      sent.push({ path, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ data: { record: { id: 'project-0000nn' } } }), { status: 201 })
    }) as unknown as typeof fetch,
  })
  return { api, sent }
}

test('the new one has the member as 責任者, in the department\'s folder, with its 相手', async () => {
  const h = harness()
  const r = await h.api.createBundle('co1', { type: 'project', title: ' A社 研修導入 ', folder: '営業部', counterpart: 'company-0000ff' })
  assert.deepEqual(r, { success: true, recordId: 'project-0000nn' })
  assert.deepEqual(h.sent, [{ path: '/api/companies/co1/records/item', body: {
    type: 'project', title: 'A社 研修導入', fields: { owner: 'u-sato' }, folder: '営業部', links: { counterpart: 'company-0000ff' },
  } }])
})

test('a malformed type, folder or 相手 never reaches the server', async () => {
  const h = harness()
  for (const input of [
    { type: '../x', title: 'a' }, { type: 'project', title: 'a', folder: '../outside' },
    { type: 'project', title: 'a', counterpart: 'company/../x' }, { type: 'project', title: '' },
  ]) assert.equal((await h.api.createBundle('co1', input)).success, false)
  assert.deepEqual(h.sent, [])
})
