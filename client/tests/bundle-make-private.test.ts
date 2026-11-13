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
  const h = cardApi({ status: 200, data: { parent: '営業部', tasks: 2, people: ['u-a'], blocked: false, version: 3 } })
  const card = await h.api.card('co1', 'project-abc123')
  assert.deepEqual(card.success && card.card.makePrivate, { parent: '営業部', tasks: 2, people: [{ id: 'u-a', name: '佐藤' }], blocked: false, version: 3 })
})

test('not offered when the server refuses the plan, nor asked for a 案件 that is already private', async () => {
  const refused = cardApi({ status: 403 })
  const card = await refused.api.card('co1', 'project-abc123')
  assert.equal(card.success && 'makePrivate' in card.card, false)
  const already = cardApi({ status: 200, data: { parent: '営業部', tasks: 0, people: [], blocked: false, version: 3 } }, DETAIL({ scopeId: 'scope-0123456789abcdef', path: '営業部/新製品' }))
  await already.api.card('co1', 'project-abc123')
  assert.equal(already.asked.some(p => p.endsWith('/make-private')), false)
})

test('a malformed plan offers nothing', () => {
  assert.equal(makePrivateOfferOf({ parent: '../x', tasks: 0, people: [], blocked: false, version: 1 }, {}), null)
  assert.equal(makePrivateOfferOf({ parent: '/abs', tasks: 0, people: [], blocked: false, version: 1 }, {}), null)
  assert.equal(makePrivateOfferOf({ parent: '営業部', tasks: -1, people: [], blocked: false, version: 1 }, {}), null)
  assert.equal(makePrivateOfferOf({ parent: '営業部', tasks: 0, people: [1], blocked: false, version: 1 }, {}), null)
  assert.equal(makePrivateOfferOf({ parent: '営業部', tasks: 0, people: [], blocked: false }, {}), null, 'no version')
  assert.deepEqual(makePrivateOfferOf({ parent: '', tasks: 0, people: [], blocked: true, version: 0 }, {}), { parent: '', tasks: 0, people: [], blocked: true, version: 0 })
})

const PLAN = { parent: '営業部', tasks: 1, people: [{ id: 'u-a', name: '佐藤' }], blocked: false, version: 3 }
const BUNDLE = { id: 'project-abc123', title: '新製品', version: 3 }
const BEFORE = { viewers: ['u-me', 'u-mgr'], editors: ['u-me'] }

function ports(over: Partial<Record<keyof BundlePrivateWrites, unknown>> = {}, plan: unknown = { success: true, offer: PLAN }) {
  const calls: Array<[string, ...unknown[]]> = []
  const p = {
    makeBundlePrivatePlan: async () => { calls.push(['plan']); return plan },
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
    getRecordCard: async () => { calls.push(['card']); return { success: false, offline: true, error: 'x' } },
    ...over,
  }
  return { calls, p: p as unknown as BundlePrivateWrites }
}

test('the flow: the plan again, the folder in its department (next free name), the people added keeping who is there, then the move', async () => {
  const h = ports()
  const r = await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', h.p)
  assert.equal(r, null)
  assert.deepEqual(h.calls, [
    ['plan'],
    ['create', '営業部', '新製品'],
    ['create', '営業部', '新製品-2'],
    ['members'],
    ['set', 'scope-1', { viewers: ['u-me', 'u-mgr', 'u-a'], editors: ['u-me', 'u-a'] }],
    ['move', 'project-abc123', '営業部/新製品-2', 3],
  ])
})

test('nothing is made when the plan is refused, blocked, or the 案件 changed meanwhile', async () => {
  for (const plan of [
    { success: false, offline: false, error: 'あとから非公開にできるのは…' },
    { success: true, offer: { ...PLAN, blocked: true } },
    { success: true, offer: { ...PLAN, version: 4 } },
  ]) {
    const h = ports({}, plan)
    const r = await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', h.p)
    assert.ok(r)
    assert.deepEqual(h.calls, [['plan']])
  }
})

test('a refused move after the folder was made: the people added are taken off again, and the person is told the empty folder is left', async () => {
  const h = ports({ makeBundlePrivate: async () => ({ success: false, offline: false, code: 'VERSION_CONFLICT', error: 'ほかの人が先に変えました' }) })
  const r = await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', h.p)
  assert.deepEqual(h.calls.at(-1), ['set', 'scope-1', BEFORE])
  assert.match(r ?? '', /非公開にできませんでした。ほかの人が先に変えました/)
  assert.match(r ?? '', /新製品-2」は、中身がないまま残っています/)
  assert.doesNotMatch(r ?? '', /外せなかった/)
})

test('nobody else named: the participants are not touched; taking them off failing is said', async () => {
  const quiet = ports({ makeBundlePrivate: async () => ({ success: false, offline: false, code: 'VERSION_CONFLICT', error: 'x' }) }, { success: true, offer: { ...PLAN, people: [] } })
  await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', quiet.p)
  assert.equal(quiet.calls.some(c => c[0] === 'set'), false)
  let sets = 0
  const stuck = ports({
    makeBundlePrivate: async () => ({ success: false, offline: false, code: 'FOLDER_NOT_PLACEABLE', error: 'x' }),
    setPrivateFolderMembers: async () => ({ success: ++sets === 1, members: [], offline: false, error: 'y' }),
  })
  assert.match(await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', stuck.p) ?? '', /外せなかった/)
})

test('a participant change refused: the 案件 is not moved', async () => {
  const h = ports({ setPrivateFolderMembers: async () => ({ success: false, offline: false, error: 'できません' }) })
  const r = await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', h.p)
  assert.match(r ?? '', /できません/)
  assert.equal(h.calls.some(c => c[0] === 'move'), false)
})

// The move's answer lost (no answer, a 5xx, a throw): the server may have made it. Read the 案件 again.
const LOST = [
  async () => ({ success: false, offline: true, code: null, error: 'つながりません' }),
  async () => ({ success: false, offline: false, code: null, error: '一時的なエラー' }),
  async () => { throw new Error('gone') },
]
const cardAt = (privateFolder?: { scopeId: string; path: string }) => async () => ({ success: true, card: { record: {}, fields: [], history: [], links: [], ...(privateFolder ? { privateFolder } : {}) } })

test('a lost answer after the move was made: nothing taken back, done', async () => {
  for (const lost of LOST) {
    const h = ports({ makeBundlePrivate: lost, getRecordCard: cardAt({ scopeId: 'scope-1', path: '営業部/新製品-2' }) })
    assert.equal(await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', h.p), null)
    assert.equal(h.calls.filter(c => c[0] === 'set').length, 1, 'only the adding')
  }
})

test('a lost answer and the 案件 still public: the people added are taken off, the empty folder said', async () => {
  const h = ports({ makeBundlePrivate: LOST[0], getRecordCard: cardAt() })
  const r = await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', h.p)
  assert.deepEqual(h.calls.at(-1), ['set', 'scope-1', BEFORE])
  assert.match(r ?? '', /中身がないまま残っています/)
})

test('still unknown after reading again: nothing changed, the person is told to reopen it (no deletion advice)', async () => {
  const h = ports({ makeBundlePrivate: LOST[1] })
  const r = await makeExistingBundlePrivate('co1', BUNDLE, 'プロジェクト', h.p)
  assert.equal(h.calls.filter(c => c[0] === 'set').length, 1, 'only the adding')
  assert.match(r ?? '', /分かりませんでした.*開き直して/)
  assert.doesNotMatch(r ?? '', /消して/)
})

test('main passes a refusal code only with the server\'s own 4xx refusal (a 5xx carries none), and sends only a company path', async () => {
  const { createTasksApi } = await import('../electron/features/tasks/ipc')
  let status = 409
  let calls = 0
  const api = createTasksApi({ baseUrl: () => 'https://acb.test', cookies: () => ['s=1'], log: { warn: () => {} },
    fetch: (async () => { calls++; return new Response(JSON.stringify({ code: 'VERSION_CONFLICT', error: 'x' }), { status }) }) as unknown as typeof fetch })
  const refused = await api.makeBundlePrivate('co1', 'project-abc123', '営業部/新製品', 3)
  assert.equal(!refused.success && refused.code, 'VERSION_CONFLICT')
  status = 502
  const unknown = await api.makeBundlePrivate('co1', 'project-abc123', '営業部/新製品', 3)
  assert.equal(!unknown.success && unknown.code, null)
  assert.equal((await api.makeBundlePrivate('co1', 'project-abc123', '../x', 3)).success, false)
  assert.equal(calls, 2)
})
