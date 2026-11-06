// What a business plugin's step made reaches the top of the record's card (plugin-steps.md "What
// the step made", tasks-ui.md 「AI が用意したもの」): main finds the newest open やること linked to the
// record that carries the AI's preparation, and hands its 確かめる点, files and mail draft to the card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerPluginStepsIpc } from '../electron/features/plugin-steps/ipc'
import type { IpcRegistrar } from '../electron/ipc/registrar'
import type { StepDeliverablesView } from '../shared/step-deliverables'

const COMPANY = 'acme'
const DEAL = 'deal-0a1b2c3d4e5f'
const task = (id: string, state: string, prep: string | null, updatedAt: string) =>
  ({ id, type: 'task', state, title: `提案書を用意する：A社 ${id}`, summary: '', fields: prep === null ? {} : { prep_summary: prep }, version: 2, updatedAt })

function deliverablesIpc(tasks: unknown[]) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } } as unknown as IpcRegistrar
  const asked: string[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    if (url.pathname === `/api/companies/${COMPANY}/records/query`) {
      const mine = body?.type === 'task' && body.link?.name === 'bundle' && body.link?.id === DEAL
      return json(200, { data: { total: 0, records: mine ? tasks : [] } })
    }
    const item = url.pathname.match(/\/records\/item\/(task-[a-z0-9]+)$/)
    if (item) {
      asked.push(item[1])
      const t = (tasks as Array<{ id: string }>).find(x => x.id === item[1])
      return json(200, { data: { record: t, links: [
        { direction: 'out', name: 'bundle', record: { id: DEAL, type: 'deal', state: 'open', title: 'A社', summary: '', fields: {}, version: 3, updatedAt: '2026-11-06T09:00:00Z' } },
        { direction: 'out', name: 'prepared', record: { id: 'outbound_message-1a2b', type: 'outbound_message', state: 'draft', title: '提案書をお送りします', summary: '', fields: {}, version: 2, updatedAt: '2026-11-06T10:04:00Z' } },
        { direction: 'out', name: 'files', path: '営業部/.personal/提案書/2026-11-06_A社/提案書.pdf', broken: false },
        { direction: 'in', name: 'tasks', record: { id: 'meeting-x1', type: 'meeting', state: 'read', title: '商談', summary: '', fields: {}, version: 1, updatedAt: '2026-11-06T08:00:00Z' } },
      ] } })
    }
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  registerPluginStepsIpc(ipc, {
    baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, readProcedure: async () => null,
    paths: { validate: (p: string) => p, add: () => {}, rootOf: () => null },
  })
  return { asked, read: (recordId: string) => handlers.get('pluginSteps:deliverables')!({ sender: { id: 1 } }, COMPANY, recordId) as Promise<StepDeliverablesView | null> }
}

test('the card gets the newest open やること with the AI\'s preparation: its points to check, files and the mail draft', async () => {
  const ipc = deliverablesIpc([
    task('task-done1', 'done', '・終わった件', '2026-11-06T11:00:00Z'),
    task('task-plain', 'todo', null, '2026-11-06T10:30:00Z'),
    task('task-made1', 'todo', '・予算の上限を確かめてください', '2026-11-06T10:05:00Z'),
    task('task-older', 'todo', '・前の版', '2026-11-01T10:05:00Z'),
  ])
  const view = await ipc.read(DEAL)
  assert.ok(view)
  assert.equal(view.taskId, 'task-made1')
  assert.equal(view.questions, '・予算の上限を確かめてください')
  assert.deepEqual(view.files.map(f => f.path), ['営業部/.personal/提案書/2026-11-06_A社/提案書.pdf'])
  assert.deepEqual(view.prepared.map(p => [p.id, p.type]), [['outbound_message-1a2b', 'outbound_message']])
  assert.deepEqual(ipc.asked, ['task-made1'])
})

test('nothing on the card while the step has handed nothing over (or for an id that is not one)', async () => {
  const ipc = deliverablesIpc([task('task-plain', 'todo', null, '2026-11-06T10:30:00Z'), task('task-done1', 'cancelled', '・やめた', '2026-11-06T11:00:00Z')])
  assert.equal(await ipc.read(DEAL), null)
  assert.equal(await ipc.read('../records'), null)
  assert.deepEqual(ipc.asked, [])
})
