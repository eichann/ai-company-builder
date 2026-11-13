// 「非公開にする」 on an existing 案件・プロジェクト (records.md "Making a 案件・プロジェクト private", tasks-ui.md).
// Guards: the card offers it only where the server's plan answered (a public 案件 this member may make
// private) and only with a well-formed plan; main sends only a company path; the screen's flow makes the
// private folder in the 案件's department, adds the people it names as participants (keeping who is
// there) and only then asks the server to move it — and says so when the move is refused after the
// folder was made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { createRecordViewsApi } from '../electron/features/record-views/ipc'
import { makePrivateOfferOf } from '../shared/record-views'
import { makeExistingBundlePrivate, type BundlePrivateWrites } from '../src/features/tasks/api'

const PROJECT = coreTypeDefinitions().find(d => d.name === 'project')!
const DETAIL = (privateFolder?: unknown) => ({
  record: { id: 'project-abc123', type: 'project', title: '新製品', summary: '', state: 'active', version: 3, fields: { owner: 'u-a' }, path: null, folder: '営業部' },
  links: [], ...(privateFolder ? { privateFolder } : {}),
})

function cardApi(plan: { status: number; data?: unknown }, detail = DETAIL()) {
  const asked: string[] = []
  return {
    asked,
    api: createRecordViewsApi({
      baseUrl: () => 'https://acb.test', cookies: () => ['session=abc'], log: { warn: () => {} },
      fetch: (async (url: string) => {
        const path = new URL(url).pathname
        asked.push(path)
        if (path.endsWith('/make-private')) return new Response(JSON.stringify(plan.data !== undefined ? { data: plan.data } : { code: 'MAKE_PRIVATE_NOT_ALLOWED', error: 'x' }), { status: plan.status })
        if (path.endsWith('/records/item/project-abc123')) return new Response(JSON.stringify({ data: detail }), { status: 200 })
        if (path.endsWith('/records/types')) return new Response(JSON.stringify({ data: { types: [{ definition: PROJECT }] } }), { status: 200 })
        if (path.includes('private-folders')) return new Response(JSON.stringify({ data: [] }), { status: path.endsWith('/me/private-folders') ? 200 : 404 })
        if (path.endsWith('/members')) return new Response(JSON.stringify({ data: [{ userId: 'u-a', name: '佐藤' }] }), { status: 200 })
        return new Response(JSON.stringify({ data: { entries: [], runs: [], records: {}, files: {} } }), { status: 200 })
      }) as unknown as typeof fetch,
    }),
  }
}

test('the card offers it with the server\'s plan, its people by name', async () => {
  const h = cardApi({ status: 200, data: { parent: '営業部', tasks: 2, people: ['u-a'], blocked: false } })
  const card = await h.api.card('co1', 'project-abc123')
  assert.deepEqual(card.success && card.card.makePrivate, { parent: '営業部', tasks: 2, people: [{ id: 'u-a', name: '佐藤' }], blocked: false })
})

test('not offered when the server refuses the plan, nor asked for a 案件 that is already private', async () => {
  const refused = cardApi({ status: 403 })
  const card = await refused.api.card('co1', 'project-abc123')
  assert.equal(card.success && 'makePrivate' in card.card, false)
  const already = cardApi({ status: 200, data: { parent: '営業部', tasks: 0, people: [], blocked: false } }, DETAIL({ scopeId: 'scope-0123456789abcdef', path: '営業部/新製品' }))
  await already.api.card('co1', 'project-abc123')
  assert.equal(already.asked.some(p => p.endsWith('/make-private')), false)
})

test('a malformed plan offers nothing', () => {
  assert.equal(makePrivateOfferOf({ parent: '../x', tasks: 0, people: [], blocked: false }, {}), null)
  assert.equal(makePrivateOfferOf({ parent: '/abs', tasks: 0, people: [], blocked: false }, {}), null)
  assert.equal(makePrivateOfferOf({ parent: '営業部', tasks: -1, people: [], blocked: false }, {}), null)
  assert.equal(makePrivateOfferOf({ parent: '営業部', tasks: 0, people: [1], blocked: false }, {}), null)
  assert.deepEqual(makePrivateOfferOf({ parent: '', tasks: 0, people: [], blocked: true }, {}), { parent: '', tasks: 0, people: [], blocked: true })
})

function ports(over: Partial<Record<keyof BundlePrivateWrites, unknown>> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const p = {
    createPrivateFolder: async (_c: string, input: { parentPath: string; name: string }) => {
      calls.push(['create', input.parentPath, input.name])
      return input.name === '新製品' ? { success: false, offline: false, code: 'FOLDER_NAME_UNAVAILABLE', error: 'taken' } : { success: true, scopeId: 'scope-1', path: `${input.parentPath}/${input.name}`, viewerCount: 2 }
    },
    getPrivateFolderMembers: async () => {
      calls.push(['members'])
      return { success: true, members: [
        { userId: 'u-me', name: '私', email: '', role: 'member', via: 'rule', canWrite: true },
        { userId: 'u-mgr', name: '管理役', email: '', role: 'member', via: 'rule', canWrite: false },
        { userId: 'u-admin', name: '管理者', email: '', role: 'admin', via: 'role', canWrite: true },
      ] }
    },
    setPrivateFolderMembers: async (_c: string, scopeId: string, input: unknown) => { calls.push(['set', scopeId, input]); return { success: true, members: [] } },
    makeBundlePrivate: async (_c: string, id: string, folder: string, version: number) => { calls.push(['move', id, folder, version]); return { success: true, recordId: id } },
    ...over,
  }
  return { calls, p: p as unknown as BundlePrivateWrites }
}

test('the flow: the folder in its department (next free name), the people added keeping who is there, then the move', async () => {
  const h = ports()
  const r = await makeExistingBundlePrivate('co1', { id: 'project-abc123', title: '新製品', version: 3 }, { parent: '営業部', people: ['u-a'] }, 'プロジェクト', h.p)
  assert.equal(r, null)
  assert.deepEqual(h.calls, [
    ['create', '営業部', '新製品'],
    ['create', '営業部', '新製品-2'],
    ['members'],
    ['set', 'scope-1', { viewers: ['u-me', 'u-mgr', 'u-a'], editors: ['u-me', 'u-a'] }],
    ['move', 'project-abc123', '営業部/新製品-2', 3],
  ])
})

test('nobody else named: no change to the participants; a refused move says the folder is left', async () => {
  const h = ports({ makeBundlePrivate: async () => ({ success: false, offline: false, error: 'ほかの人が先に変えました' }) })
  const r = await makeExistingBundlePrivate('co1', { id: 'project-abc123', title: 'A社', version: 3 }, { parent: '営業部', people: [] }, 'プロジェクト', h.p)
  assert.deepEqual(h.calls.map(c => c[0]), ['create'])
  assert.match(r ?? '', /ほかの人が先に変えました.*残っています/)
})

test('a participant change refused: the 案件 is not moved', async () => {
  const h = ports({ setPrivateFolderMembers: async () => ({ success: false, offline: false, error: 'できません' }) })
  const r = await makeExistingBundlePrivate('co1', { id: 'project-abc123', title: 'A社', version: 3 }, { parent: '営業部', people: ['u-a'] }, 'プロジェクト', h.p)
  assert.match(r ?? '', /できません/)
  assert.equal(h.calls.some(c => c[0] === 'move'), false)
})
